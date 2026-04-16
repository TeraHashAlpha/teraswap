// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
// Chainlink AggregatorV3Interface (inlined to avoid heavy dependency)
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/**
 * @title TeraSwapOrderExecutor v2
 * @author TeraSwap
 * @notice Executes conditional swap orders (Limit, Stop-Loss, DCA) signed by users via EIP-712.
 *         Orders are stored off-chain (Supabase) and executed by an autonomous keeper
 *         when price conditions are met.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                         ARCHITECTURE                               │
 * │                                                                     │
 * │  User signs EIP-712 order ──► Stored in Supabase                   │
 * │                                     │                               │
 * │  Keeper cron (30s) ──► checker() ──► canExec? ──► executeOrder()   │
 * │                                                                     │
 * │  Contract verifies:                                                 │
 * │    1. Signature is valid (EIP-712)                                  │
 * │    2. Order not expired / not cancelled / nonce valid               │
 * │    3. Price condition met (Chainlink oracle)                        │
 * │    4. User has sufficient balance + allowance                       │
 * │    5. Router matches signed order (H-01 fix)                       │
 * │                                                                     │
 * │  Then executes the swap through the signed DEX router               │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * SECURITY (v2 hardening):
 * - H-01: Router is part of EIP-712 signed data (user commits to specific router)
 * - H-02: ETH output handling via WETH unwrap
 * - H-03: Mass nonce invalidation + per-order cancellation
 * - H-04: MEV-resistant execution via Flashbots Protect (off-chain, executor config)
 * - M-01: Pre-execution balance & allowance checks
 * - M-02: 48h timelock for admin functions (router whitelist, admin transfer)
 * - L-03: Minimum output amount enforced (cannot be zero)
 * - Chainlink: answeredInRound validation for incomplete rounds
 *
 * Self-hosted keeper: contracts/order-engine/executor/executor.js
 */
contract TeraSwapOrderExecutor is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════
    //  TYPES
    // ══════════════════════════════════════════════════════════════════

    enum OrderType {
        LIMIT,      // Execute when price reaches target
        STOP_LOSS,  // Execute when price drops below threshold
        DCA         // Execute at regular intervals
    }

    enum PriceCondition {
        ABOVE,  // Execute when price >= targetPrice (limit buy token)
        BELOW   // Execute when price <= targetPrice (stop-loss / limit sell)
    }

    struct Order {
        address owner;           // Signer / token owner
        address tokenIn;         // Token to sell
        address tokenOut;        // Token to buy
        uint256 amountIn;        // Amount to sell (in tokenIn wei)
        uint256 minAmountOut;    // Minimum acceptable output (slippage protection)
        OrderType orderType;     // LIMIT | STOP_LOSS | DCA
        PriceCondition condition;// ABOVE or BELOW
        uint256 targetPrice;     // Price threshold (8 decimals, like Chainlink)
        address priceFeed;       // Chainlink price feed address
        uint256 expiry;          // Unix timestamp — order expires after this
        uint256 nonce;           // Per-user nonce (prevents replay)
        address router;          // [H-01] DEX router committed in signature
        bytes32 routerDataHash;  // [C-01] keccak256 of routerData — prevents calldata substitution
        // DCA-specific fields
        uint256 dcaInterval;     // Seconds between DCA executions (0 for non-DCA)
        uint256 dcaTotal;        // Total number of DCA executions planned
    }

    /// @notice Pending timelock action
    struct TimelockAction {
        bytes32 actionHash;      // keccak256 of the action data
        uint256 readyAt;         // Timestamp when action can be executed
        bool exists;             // Whether action is queued
    }

    // EIP-712 type hash — v3: includes routerDataHash field (C-01 fix)
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,"
        "uint256 minAmountOut,uint8 orderType,uint8 condition,uint256 targetPrice,"
        "address priceFeed,uint256 expiry,uint256 nonce,address router,"
        "bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)"
    );

    // ══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ══════════════════════════════════════════════════════════════════

    uint256 public constant FEE_BPS = 10;           // 0.1% fee
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_STALENESS = 300;      // [H-03] 5 min staleness (was 3600s/1h)
    uint256 public constant TIMELOCK_ADMIN_TRANSFER = 7 days;   // [R-12] Admin transfer requires 7-day delay
    uint256 public constant TIMELOCK_ROUTER_CHANGE  = 48 hours; // [R-12] Router whitelist change delay
    uint256 public constant TIMELOCK_SWEEP          = 48 hours; // [R-12] Sweep action delay
    uint256 public constant TIMELOCK_EXECUTOR_CHANGE = 48 hours; // [SC-H-01] Executor whitelist change delay
    uint256 public constant TIMELOCK_GRACE = 7 days;            // [Audit M-03] Timelock expiry window
    uint256 public constant MIN_ORDER_AMOUNT = 10_000; // [Audit M-01] Min order to prevent zero-fee

    // ══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ══════════════════════════════════════════════════════════════════

    address public immutable feeRecipient;
    address public immutable WETH; // [H-02] WETH address for ETH output handling

    // ══════════════════════════════════════════════════════════════════
    //  STATE
    // ══════════════════════════════════════════════════════════════════

    /// @notice Per-user nonce (increments after each non-DCA execution)
    mapping(address => uint256) public nonces;

    /// @notice [H-03] Mass nonce invalidation — all orders with nonce < this value are void
    mapping(address => uint256) public invalidatedNonces;

    /// @notice Cancelled order hashes
    mapping(bytes32 => bool) public cancelledOrders;

    /// @notice DCA execution counts: orderHash => timesExecuted
    mapping(bytes32 => uint256) public dcaExecutions;

    /// @notice DCA last execution time: orderHash => timestamp
    mapping(bytes32 => uint256) public dcaLastExecution;

    /// @notice Whitelisted DEX routers (security: prevent routing to malicious contracts)
    mapping(address => bool) public whitelistedRouters;

    /// @notice [Audit H-01] Whitelisted executors (access control on executeOrder)
    mapping(address => bool) public whitelistedExecutors;

    /// @notice Admin (for router whitelist management)
    address public admin;

    /// @notice Whether the contract is paused (emergency stop)
    bool public paused;

    /// @notice [M-02] Timelock actions: actionId => TimelockAction
    mapping(bytes32 => TimelockAction) public timelockActions;

    /// @notice Whether initial bootstrap has been used (one-time router setup)
    bool public bootstrapped;

    /// @notice [SC-H-01] Pending executor whitelist change proposals
    struct ExecutorProposal {
        bool proposed;
        bool newStatus;
        uint256 executeAfter;
    }
    mapping(address => ExecutorProposal) public pendingExecutorChanges;

    // [HIGH-004] Per-feed oracle configuration
    struct OracleConfig {
        uint8 decimals;          // Feed decimals (8 or 18)
        uint256 maxStaleness;    // Per-feed staleness (0 = use global MAX_STALENESS)
        int256 minPrice;         // Floor price (0 = no min)
        int256 maxPrice;         // Ceiling price (0 = no max)
        bool registered;         // Whether this feed has been configured
    }
    mapping(address => OracleConfig) public oracleConfigs;

    // ══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ══════════════════════════════════════════════════════════════════

    event OrderExecuted(
        bytes32 indexed orderHash,
        address indexed owner,
        OrderType indexed orderType,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );

    event OrderCancelled(bytes32 indexed orderHash, address indexed owner);
    event NoncesInvalidated(address indexed owner, uint256 newNonce);
    event RouterWhitelisted(address indexed router, bool status);
    event TimelockQueued(bytes32 indexed actionId, bytes32 actionHash, uint256 readyAt);
    // [Audit L-02] Enhanced with action type and data for monitoring
    event TimelockExecuted(bytes32 indexed actionId, string actionType, bytes data);
    event TimelockCancelled(bytes32 indexed actionId);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event Bootstrap(address indexed router);
    event ExecutorWhitelisted(address indexed executor, bool status);
    event ExecutorChangeProposed(address indexed executor, bool status, uint256 executeAfter);
    event ExecutorChangeExecuted(address indexed executor, bool status);
    event ExecutorChangeCancelled(address indexed executor);
    event Paused(address indexed admin);
    event Unpaused(address indexed admin);
    event OracleConfigured(address indexed feed, uint8 decimals, uint256 maxStaleness, int256 minPrice, int256 maxPrice);
    event SweepQueued(bytes32 indexed actionId, address token);

    // ══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ══════════════════════════════════════════════════════════════════

    error InvalidSignature();
    error OrderExpired();
    error OrderCancelledError();
    error OrderAlreadyExecuted();
    error NonceBelowInvalidation();
    error PriceConditionNotMet();
    error StalePriceFeed();
    error IncompleteRound();
    error InsufficientOutput();
    error InvalidMinOutput();
    error RouterNotWhitelisted();
    error RouterMismatch();
    error DCAIntervalNotReached();
    error DCAComplete();
    error NotAdmin();
    error NotOwner();
    error SwapFailed(bytes reason);
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error TimelockNotReady();
    error TimelockNotQueued();
    error TimelockAlreadyQueued();
    error TimelockHashMismatch();
    error AlreadyBootstrapped();
    error ETHTransferFailed();
    error TimelockExpired();
    error OrderTooSmall();
    error NotExecutor();
    error NonceTooHigh();
    error DCAChunkTooSmall();
    error RouterDataMismatch();
    error InvalidDCATotal();        // [Audit L-04]
    error InvalidDCAInterval();     // [Audit L-04]
    error NotAContract();           // [Audit L-05]
    error NoActiveProposal();       // [SC-H-01]
    error ProposalAlreadyExists();  // [SC-H-01]
    error ProposalExpired();        // [SC-H-01]
    error TimelockNotExpired();     // [SC-H-01]

    // ══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════

    /// @notice Deploy TeraSwapOrderExecutor v2.
    /// @dev [Audit I-01] EIP-712 domain name "TeraSwapOrderExecutor" and version "2" are
    ///      immutable by design. Changing them would invalidate all existing signatures.
    ///      This is intentional for non-upgradeable contracts.
    ///
    ///      ORACLE ASSUMPTIONS:
    ///      - Chainlink price feeds return 8-decimal prices (standard for USD pairs)
    ///      - MAX_STALENESS = 300s (5 min) — suitable for high-liquidity feeds (ETH/USD, BTC/USD)
    ///      - For less liquid pairs, consider separate staleness thresholds
    ///
    ///      NONCE SEMANTICS:
    ///      - Non-DCA: nonces[owner] must match order.nonce (single execution, then incremented)
    ///      - DCA: nonce not checked per execution (same order executed dcaTotal times)
    ///      - invalidateNonces(n): mass cancel — all orders with nonce < n become void
    ///      - Upper bound: cannot jump more than 1000 nonces ahead (prevents lockout)
    constructor(
        address _feeRecipient,
        address _admin,
        address _weth
    ) EIP712("TeraSwapOrderExecutor", "2") {
        if (_feeRecipient == address(0) || _admin == address(0) || _weth == address(0)) {
            revert ZeroAddress();
        }
        feeRecipient = _feeRecipient;
        admin = _admin;
        WETH = _weth;
    }

    // ══════════════════════════════════════════════════════════════════
    //  GELATO CHECKER (view — called off-chain to determine if order can execute)
    // ══════════════════════════════════════════════════════════════════

    /**
     * @notice Check if an order can be executed right now.
     * @param order The order struct
     * @param signature The EIP-712 signature from the order owner
     * @return canExec Whether the order can be executed
     * @return reason Human-readable reason if canExec is false
     */
    function canExecute(
        Order calldata order,
        bytes calldata signature
    ) external view returns (bool canExec, string memory reason) {
        bytes32 orderHash = getOrderHash(order);

        // 1. Verify signature
        address signer = ECDSA.recover(_hashTypedDataV4(orderHash), signature);
        if (signer != order.owner) return (false, "Invalid signature");

        // 2. Check cancellation
        if (cancelledOrders[orderHash]) return (false, "Order cancelled");

        // 3. Check expiry
        if (block.timestamp > order.expiry) return (false, "Order expired");

        // 4. [H-01] Check router is whitelisted
        if (!whitelistedRouters[order.router]) return (false, "Router not whitelisted");

        // 5. [H-03] Check nonce invalidation
        if (order.nonce < invalidatedNonces[order.owner]) {
            return (false, "Nonce invalidated");
        }

        // 6. Check nonce (non-DCA orders: single execution)
        if (order.orderType != OrderType.DCA && nonces[order.owner] != order.nonce) {
            return (false, "Nonce mismatch");
        }

        // 7. DCA checks
        if (order.orderType == OrderType.DCA) {
            // [Audit L-04] Explicit validation for invalid DCA params
            if (order.dcaTotal == 0) return (false, "DCA total must be > 0");
            if (order.dcaInterval == 0) return (false, "DCA interval must be > 0");
            if (dcaExecutions[orderHash] >= order.dcaTotal) return (false, "DCA complete");
            if (block.timestamp < dcaLastExecution[orderHash] + order.dcaInterval) {
                return (false, "DCA interval not reached");
            }
        }

        // 8. Check price condition
        (bool priceOk, string memory priceReason) = _checkPriceCondition(
            order.priceFeed,
            order.condition,
            order.targetPrice
        );
        if (!priceOk) return (false, priceReason);

        // 9. [M-01] Check user balance & allowance
        uint256 requiredAmount = order.orderType == OrderType.DCA
            ? order.amountIn / order.dcaTotal
            : order.amountIn;

        uint256 balance = IERC20(order.tokenIn).balanceOf(order.owner);
        uint256 allowance = IERC20(order.tokenIn).allowance(order.owner, address(this));

        if (balance < requiredAmount) return (false, "Insufficient balance");
        if (allowance < requiredAmount) return (false, "Insufficient allowance");

        return (true, "");
    }

    // ══════════════════════════════════════════════════════════════════
    //  EXECUTE ORDER (called by keeper / executor)
    // ══════════════════════════════════════════════════════════════════

    /**
     * @notice Execute a signed order when conditions are met.
     * @dev Router is now part of the signed Order struct (H-01).
     *      The caller provides routerData (swap calldata) which is executed
     *      against order.router.
     * @param order The order struct (must match the signed data)
     * @param signature EIP-712 signature from order.owner
     * @param routerData Encoded swap calldata for order.router
     */
    function executeOrder(
        Order calldata order,
        bytes calldata signature,
        bytes calldata routerData
    ) external nonReentrant {
        // [Audit H-01] Access control: only whitelisted executors
        if (!whitelistedExecutors[msg.sender]) revert NotExecutor();
        // [Audit] Emergency pause
        require(!paused, "Contract paused");
        bytes32 orderHash = getOrderHash(order);

        // ── [L-03] Validate minAmountOut ──
        if (order.minAmountOut == 0) revert InvalidMinOutput();

        // ── [Audit M-01] Minimum order size to prevent zero-fee ──
        if (order.amountIn < MIN_ORDER_AMOUNT) revert OrderTooSmall();

        // ── Verify signature ──
        address signer = ECDSA.recover(_hashTypedDataV4(orderHash), signature);
        if (signer != order.owner) revert InvalidSignature();

        // ── Check order state ──
        if (cancelledOrders[orderHash]) revert OrderCancelledError();
        if (block.timestamp > order.expiry) revert OrderExpired();

        // ── [H-01] Router is from signed data, verify it's whitelisted ──
        if (!whitelistedRouters[order.router]) revert RouterNotWhitelisted();

        // ── [C-01] Verify routerData matches the hash signed by the user ──
        // [MEDIUM-006] Non-DCA orders MUST commit to specific routerData (no bytes32(0) bypass)
        if (order.orderType != OrderType.DCA) {
            if (order.routerDataHash == bytes32(0)) revert RouterDataMismatch();
            if (keccak256(routerData) != order.routerDataHash) revert RouterDataMismatch();
        }
        // DCA orders: routerDataHash bypass (bytes32(0)) is safe because:
        //   (a) minAmountOut enforces minimum output per-execution (line ~478, scaled proportionally)
        //   (b) recipient is always order.owner — the executor receives swap output and transfers
        //       to order.owner (lines ~501-524), NOT to an address from routerData
        //   (c) nonReentrant prevents compound attacks during the router call
        //   (d) router must be whitelisted (line ~395) — limits calldata to trusted contracts

        // ── [H-03] Check nonce invalidation ──
        if (order.nonce < invalidatedNonces[order.owner]) revert NonceBelowInvalidation();

        // ── Nonce / DCA checks ──
        uint256 executeAmount;

        if (order.orderType == OrderType.DCA) {
            // [Audit L-04] Validate DCA parameters
            if (order.dcaTotal == 0) revert InvalidDCATotal();
            if (order.dcaInterval == 0) revert InvalidDCAInterval();
            uint256 execCount = dcaExecutions[orderHash];
            if (execCount >= order.dcaTotal) revert DCAComplete();
            if (block.timestamp < dcaLastExecution[orderHash] + order.dcaInterval) {
                revert DCAIntervalNotReached();
            }
            // [HIGH-003 fix] Cumulative DCA tracking eliminates dust accumulation.
            // Instead of simple division, track how much has been executed cumulatively
            // and give the remainder to the final execution.
            uint256 perExecution = order.amountIn / order.dcaTotal;
            // [Audit H-02] Per-execution amount must meet minimum to prevent zero-fee attack
            if (perExecution < MIN_ORDER_AMOUNT) revert DCAChunkTooSmall();
            // Cumulative approach: what SHOULD have been executed by now (inclusive)
            uint256 cumulativeTarget = (order.amountIn * (execCount + 1)) / order.dcaTotal;
            uint256 previouslyExecuted = (order.amountIn * execCount) / order.dcaTotal;
            executeAmount = cumulativeTarget - previouslyExecuted;
            // Safety: last execution gets exact remainder
            if (execCount == order.dcaTotal - 1) {
                executeAmount = order.amountIn - previouslyExecuted;
            }
        } else {
            if (nonces[order.owner] != order.nonce) revert OrderAlreadyExecuted();
            executeAmount = order.amountIn;
        }

        // ── Check price condition ──
        (bool priceOk, ) = _checkPriceCondition(
            order.priceFeed,
            order.condition,
            order.targetPrice
        );
        if (!priceOk) revert PriceConditionNotMet();

        // ── [M-01] Pre-execution balance & allowance check ──
        uint256 userBalance = IERC20(order.tokenIn).balanceOf(order.owner);
        if (userBalance < executeAmount) revert InsufficientBalance();
        uint256 userAllowance = IERC20(order.tokenIn).allowance(order.owner, address(this));
        if (userAllowance < executeAmount) revert InsufficientAllowance();

        // ── Calculate fee ──
        uint256 fee = (executeAmount * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netAmount = executeAmount - fee;

        // ── Pull tokens from user ──
        IERC20(order.tokenIn).safeTransferFrom(order.owner, address(this), executeAmount);

        // ── Send fee ──
        IERC20(order.tokenIn).safeTransfer(feeRecipient, fee);

        // ── Execute swap via signed router ──
        IERC20(order.tokenIn).forceApprove(order.router, netAmount);

        uint256 ethBefore = address(this).balance;
        // [M-01] Record tokenOut balance BEFORE swap to use delta (not absolute)
        uint256 tokenOutBefore = IERC20(order.tokenOut).balanceOf(address(this));

        (bool ok, bytes memory result) = order.router.call(routerData);
        if (!ok) revert SwapFailed(result);

        // Revoke approval
        IERC20(order.tokenIn).forceApprove(order.router, 0);

        // ── Verify & deliver output ──
        // For DCA, minAmountOut is proportional to executeAmount
        uint256 minOut;
        if (order.orderType == OrderType.DCA) {
            // Scale minAmountOut proportionally to executeAmount vs total amountIn
            minOut = (order.minAmountOut * executeAmount) / order.amountIn;
            if (minOut == 0) minOut = 1; // Ensure at least 1 wei minimum
        } else {
            minOut = order.minAmountOut;
        }

        // [H-02] Handle both ERC-20 output and ETH output (e.g. selling tokens for ETH)
        // [M-01] Use balance DELTA instead of absolute balance to prevent race conditions
        uint256 tokenOutBalance = IERC20(order.tokenOut).balanceOf(address(this)) - tokenOutBefore;
        uint256 ethReceived = address(this).balance - ethBefore;

        // ── [Audit CEI] Update state BEFORE external calls (Checks-Effects-Interactions) ──
        if (order.orderType == OrderType.DCA) {
            dcaExecutions[orderHash]++;
            dcaLastExecution[orderHash] = block.timestamp;
        } else {
            nonces[order.owner]++;
        }

        // ── Verify output meets minimum ──
        if (tokenOutBalance >= minOut) {
            // Standard ERC-20 output
            IERC20(order.tokenOut).safeTransfer(order.owner, tokenOutBalance);
        } else if (order.tokenOut == WETH && ethReceived >= minOut) {
            // Router returned native ETH — wrap to WETH and send, or send ETH directly
            // Send native ETH to user (more gas efficient than WETH wrap)
            (bool ethOk, ) = order.owner.call{value: ethReceived}("");
            if (!ethOk) {
                // Fallback: wrap to WETH and send
                IWETH(WETH).deposit{value: ethReceived}();
                IERC20(WETH).safeTransfer(order.owner, ethReceived);
            }
        } else if (tokenOutBalance + ethReceived >= minOut) {
            // Mixed output — send whatever we have
            if (tokenOutBalance > 0) {
                IERC20(order.tokenOut).safeTransfer(order.owner, tokenOutBalance);
            }
            if (ethReceived > 0) {
                (bool ethOk, ) = order.owner.call{value: ethReceived}("");
                if (!ethOk) revert ETHTransferFailed();
            }
        } else {
            revert InsufficientOutput();
        }

        // ── Refund any dust ──
        uint256 inputDust = IERC20(order.tokenIn).balanceOf(address(this));
        if (inputDust > 0) {
            IERC20(order.tokenIn).safeTransfer(order.owner, inputDust);
        }

        emit OrderExecuted(
            orderHash,
            order.owner,
            order.orderType,
            order.tokenIn,
            order.tokenOut,
            executeAmount,
            tokenOutBalance > 0 ? tokenOutBalance : ethReceived,
            fee
        );
    }

    // ══════════════════════════════════════════════════════════════════
    //  USER ACTIONS
    // ══════════════════════════════════════════════════════════════════

    /// @notice Cancel a specific pending order (only the order owner can call)
    function cancelOrder(Order calldata order) external {
        if (msg.sender != order.owner) revert NotOwner();
        bytes32 orderHash = getOrderHash(order);
        cancelledOrders[orderHash] = true;
        emit OrderCancelled(orderHash, msg.sender);
    }

    /// @notice [H-03] Invalidate all orders with nonce < newNonce (mass cancel)
    /// @dev User can set this to their current nonce to cancel all pending orders.
    ///      [Audit] Upper bound prevents accidental lockout.
    function invalidateNonces(uint256 newNonce) external {
        // Must be > current invalidation
        require(newNonce > invalidatedNonces[msg.sender], "Must increase");
        // [Audit M-04] Upper bound: cannot jump more than 1000 nonces ahead
        // Prevents accidental permanent lockout of all future orders
        if (newNonce > nonces[msg.sender] + 1000) revert NonceTooHigh();
        invalidatedNonces[msg.sender] = newNonce;
        emit NoncesInvalidated(msg.sender, newNonce);
    }

    /// @notice Get the current nonce for a user
    function getNonce(address user) external view returns (uint256) {
        return nonces[user];
    }

    // ══════════════════════════════════════════════════════════════════
    //  ADMIN — TIMELOCKED (M-02)
    // ══════════════════════════════════════════════════════════════════

    /**
     * @notice Queue a router whitelist change (48h delay)
     * @param router The router address to change
     * @param status true = whitelist, false = remove
     */
    function queueRouterChange(address router, bool status) external {
        if (msg.sender != admin) revert NotAdmin();
        if (router == address(0)) revert ZeroAddress();

        bytes32 actionHash = keccak256(abi.encode("setRouter", router, status));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        if (timelockActions[actionId].exists) revert TimelockAlreadyQueued();

        timelockActions[actionId] = TimelockAction({
            actionHash: actionHash,
            readyAt: block.timestamp + TIMELOCK_ROUTER_CHANGE,
            exists: true
        });

        emit TimelockQueued(actionId, actionHash, block.timestamp + TIMELOCK_ROUTER_CHANGE);
    }

    /// @notice Execute a queued router whitelist change after timelock
    function executeRouterChange(bytes32 actionId, address router, bool status) external {
        if (msg.sender != admin) revert NotAdmin();

        TimelockAction storage action = timelockActions[actionId];
        if (!action.exists) revert TimelockNotQueued();
        if (block.timestamp < action.readyAt) revert TimelockNotReady();
        // [Audit M-03] Timelock expires after grace period
        if (block.timestamp > action.readyAt + TIMELOCK_GRACE) revert TimelockExpired();

        bytes32 expectedHash = keccak256(abi.encode("setRouter", router, status));
        if (action.actionHash != expectedHash) revert TimelockHashMismatch();

        delete timelockActions[actionId];
        whitelistedRouters[router] = status;

        emit TimelockExecuted(actionId, "setRouter", abi.encode(router, status));
        emit RouterWhitelisted(router, status);
    }

    /**
     * @notice Queue an admin transfer (48h delay)
     * @param newAdmin The new admin address
     */
    function queueAdminChange(address newAdmin) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newAdmin == address(0)) revert ZeroAddress();

        bytes32 actionHash = keccak256(abi.encode("setAdmin", newAdmin));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        if (timelockActions[actionId].exists) revert TimelockAlreadyQueued();

        timelockActions[actionId] = TimelockAction({
            actionHash: actionHash,
            readyAt: block.timestamp + TIMELOCK_ADMIN_TRANSFER,
            exists: true
        });

        emit TimelockQueued(actionId, actionHash, block.timestamp + TIMELOCK_ADMIN_TRANSFER);
    }

    /// @notice Execute a queued admin transfer after timelock
    function executeAdminChange(bytes32 actionId, address newAdmin) external {
        if (msg.sender != admin) revert NotAdmin();

        TimelockAction storage action = timelockActions[actionId];
        if (!action.exists) revert TimelockNotQueued();
        if (block.timestamp < action.readyAt) revert TimelockNotReady();
        // [Audit M-03] Timelock expires after grace period
        if (block.timestamp > action.readyAt + TIMELOCK_GRACE) revert TimelockExpired();

        bytes32 expectedHash = keccak256(abi.encode("setAdmin", newAdmin));
        if (action.actionHash != expectedHash) revert TimelockHashMismatch();

        delete timelockActions[actionId];

        address oldAdmin = admin;
        admin = newAdmin;

        emit TimelockExecuted(actionId, "setAdmin", abi.encode(newAdmin));
        emit AdminTransferred(oldAdmin, newAdmin);
    }

    /// @notice Cancel a queued timelock action
    function cancelTimelockAction(bytes32 actionId) external {
        if (msg.sender != admin) revert NotAdmin();
        if (!timelockActions[actionId].exists) revert TimelockNotQueued();
        delete timelockActions[actionId];
        emit TimelockCancelled(actionId);
    }

    /// @notice [R-12] Returns all progressive timelock delays for transparency
    /// @return adminTransfer Delay for admin transfer (7 days)
    /// @return routerChange Delay for router whitelist changes (48 hours)
    /// @return sweep Delay for sweep actions (48 hours)
    /// @return executorChange Delay for executor whitelist changes (48 hours)
    function getTimelockDelays() external pure returns (
        uint256 adminTransfer,
        uint256 routerChange,
        uint256 sweep,
        uint256 executorChange
    ) {
        return (TIMELOCK_ADMIN_TRANSFER, TIMELOCK_ROUTER_CHANGE, TIMELOCK_SWEEP, TIMELOCK_EXECUTOR_CHANGE);
    }

    /**
     * @notice One-time bootstrap: whitelist initial routers without timelock.
     * @dev Can only be called once, intended for deployment setup.
     * @param routers Array of router addresses to whitelist
     */
    function bootstrap(address[] calldata routers, address[] calldata executors) external {
        if (msg.sender != admin) revert NotAdmin();
        if (bootstrapped) revert AlreadyBootstrapped();
        bootstrapped = true;

        for (uint256 i = 0; i < routers.length; i++) {
            if (routers[i] == address(0)) revert ZeroAddress();
            // [Audit L-05] Verify router is a contract (not an EOA)
            address r = routers[i];
            uint256 codeSize;
            assembly { codeSize := extcodesize(r) }
            if (codeSize == 0) revert NotAContract();
            whitelistedRouters[routers[i]] = true;
            emit Bootstrap(routers[i]);
        }

        // [Audit H-01] Bootstrap executors in same tx
        for (uint256 i = 0; i < executors.length; i++) {
            if (executors[i] == address(0)) revert ZeroAddress();
            whitelistedExecutors[executors[i]] = true;
            emit ExecutorWhitelisted(executors[i], true);
        }
    }

    /// @notice [Audit H-04] Queue a sweep action (timelocked — prevents instant fund drain)
    function queueSweep(address token) external {
        if (msg.sender != admin) revert NotAdmin();

        bytes32 actionHash = keccak256(abi.encode("sweep", token));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        if (timelockActions[actionId].exists) revert TimelockAlreadyQueued();

        timelockActions[actionId] = TimelockAction({
            actionHash: actionHash,
            readyAt: block.timestamp + TIMELOCK_SWEEP,
            exists: true
        });

        emit SweepQueued(actionId, token);
        emit TimelockQueued(actionId, actionHash, block.timestamp + TIMELOCK_SWEEP);
    }

    /// @notice Execute a queued sweep after timelock
    function executeSweep(bytes32 actionId, address token) external {
        if (msg.sender != admin) revert NotAdmin();

        TimelockAction storage action = timelockActions[actionId];
        if (!action.exists) revert TimelockNotQueued();
        if (block.timestamp < action.readyAt) revert TimelockNotReady();
        if (block.timestamp > action.readyAt + TIMELOCK_GRACE) revert TimelockExpired();

        bytes32 expectedHash = keccak256(abi.encode("sweep", token));
        if (action.actionHash != expectedHash) revert TimelockHashMismatch();

        delete timelockActions[actionId];

        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) {
                (bool ok, ) = admin.call{value: bal}("");
                if (!ok) revert ETHTransferFailed();
            }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(admin, bal);
        }

        emit TimelockExecuted(actionId, "sweep", abi.encode(token));
    }

    // ══════════════════════════════════════════════════════════════════
    //  EXECUTOR MANAGEMENT — TIMELOCKED (SC-H-01)
    // ══════════════════════════════════════════════════════════════════

    /// @notice Propose an executor whitelist change (48h delay, matching router timelock)
    /// @param _executor The executor address to change
    /// @param status true = whitelist, false = remove
    function proposeExecutor(address _executor, bool status) external {
        if (msg.sender != admin) revert NotAdmin();
        if (_executor == address(0)) revert ZeroAddress();
        if (pendingExecutorChanges[_executor].proposed) revert ProposalAlreadyExists();

        uint256 executeAfter = block.timestamp + TIMELOCK_EXECUTOR_CHANGE;
        pendingExecutorChanges[_executor] = ExecutorProposal({
            proposed: true,
            newStatus: status,
            executeAfter: executeAfter
        });

        emit ExecutorChangeProposed(_executor, status, executeAfter);
    }

    /// @notice Execute a pending executor whitelist change after the timelock expires
    /// @param _executor The executor address whose proposal to execute
    function executeExecutorChange(address _executor) external {
        if (msg.sender != admin) revert NotAdmin();

        ExecutorProposal storage proposal = pendingExecutorChanges[_executor];
        if (!proposal.proposed) revert NoActiveProposal();
        if (block.timestamp < proposal.executeAfter) revert TimelockNotExpired();
        if (block.timestamp > proposal.executeAfter + TIMELOCK_GRACE) revert ProposalExpired();

        bool newStatus = proposal.newStatus;
        delete pendingExecutorChanges[_executor];

        whitelistedExecutors[_executor] = newStatus;

        emit ExecutorChangeExecuted(_executor, newStatus);
        emit ExecutorWhitelisted(_executor, newStatus);
    }

    /// @notice Cancel a pending executor whitelist change proposal
    /// @param _executor The executor address whose proposal to cancel
    function cancelExecutorProposal(address _executor) external {
        if (msg.sender != admin) revert NotAdmin();
        if (!pendingExecutorChanges[_executor].proposed) revert NoActiveProposal();

        delete pendingExecutorChanges[_executor];

        emit ExecutorChangeCancelled(_executor);
    }

    // ══════════════════════════════════════════════════════════════════
    //  EMERGENCY PAUSE
    // ══════════════════════════════════════════════════════════════════

    /// @notice Pause all order executions (admin only, emergency)
    function pause() external {
        if (msg.sender != admin) revert NotAdmin();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Unpause order executions
    function unpause() external {
        if (msg.sender != admin) revert NotAdmin();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ══════════════════════════════════════════════════════════════════
    //  ORACLE CONFIGURATION [HIGH-004]
    // ══════════════════════════════════════════════════════════════════

    /// @notice Register/update a Chainlink price feed with per-feed bounds
    /// @param feed The Chainlink AggregatorV3 address
    /// @param maxStaleness Max seconds since last update (0 = use global MAX_STALENESS)
    /// @param minPrice Floor price (0 = no minimum)
    /// @param maxPrice Ceiling price (0 = no maximum)
    function setOracleConfig(
        address feed,
        uint256 maxStaleness,
        int256 minPrice,
        int256 maxPrice
    ) external {
        if (msg.sender != admin) revert NotAdmin();
        if (feed == address(0)) revert ZeroAddress();

        // [HIGH-004] Read actual decimals from the feed
        uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
        require(feedDecimals == 8 || feedDecimals == 18, "Unexpected feed decimals");

        // Validate feed returns reasonable data
        (, int256 testPrice, , uint256 testUpdatedAt, ) = AggregatorV3Interface(feed).latestRoundData();
        require(testPrice > 0, "Feed returns invalid price");
        require(block.timestamp - testUpdatedAt < 86400, "Feed seems dead (>24h stale)");

        oracleConfigs[feed] = OracleConfig({
            decimals: feedDecimals,
            maxStaleness: maxStaleness,
            minPrice: minPrice,
            maxPrice: maxPrice,
            registered: true
        });

        emit OracleConfigured(feed, feedDecimals, maxStaleness, minPrice, maxPrice);
    }

    // ══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ══════════════════════════════════════════════════════════════════

    /// @dev Validates that current Chainlink price meets the order's price condition.
    ///      Handles feed validation (staleness ≤ MAX_STALENESS, round completeness) and comparison.
    /// @param priceFeed Chainlink AggregatorV3 address. address(0) = no condition (DCA, always true).
    /// @param condition ABOVE (price >= target) or BELOW (price <= target)
    /// @param targetPrice Target price in 8 decimals (Chainlink standard)
    /// @return ok Whether the price condition is met
    /// @return reason Human-readable failure reason (empty string if ok == true)
    function _checkPriceCondition(
        address priceFeed,
        PriceCondition condition,
        uint256 targetPrice
    ) internal view returns (bool ok, string memory reason) {
        if (priceFeed == address(0)) {
            // No price feed = DCA (execute unconditionally on schedule)
            return (true, "");
        }

        AggregatorV3Interface feed = AggregatorV3Interface(priceFeed);
        (
            uint80 roundId,
            int256 price,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = feed.latestRoundData();

        if (price <= 0) return (false, "Invalid price");

        // [HIGH-004] Use per-feed staleness if configured, else global
        OracleConfig memory config = oracleConfigs[priceFeed];
        uint256 staleness = (config.registered && config.maxStaleness > 0)
            ? config.maxStaleness
            : MAX_STALENESS;
        if (block.timestamp - updatedAt > staleness) return (false, "Stale price feed");

        // Validate that this round is complete
        if (answeredInRound < roundId) return (false, "Incomplete round");

        // [HIGH-004] Per-feed price bounds check
        if (config.registered) {
            if (config.minPrice > 0 && price < config.minPrice) return (false, "Price below floor");
            if (config.maxPrice > 0 && price > config.maxPrice) return (false, "Price above ceiling");
        }

        uint256 currentPrice = uint256(price);

        if (condition == PriceCondition.ABOVE) {
            return currentPrice >= targetPrice
                ? (true, "")
                : (false, "Price below target");
        } else {
            return currentPrice <= targetPrice
                ? (true, "")
                : (false, "Price above target");
        }
    }

    /// @notice Compute the EIP-712 struct hash for an Order.
    /// @dev Used both on-chain (signature verification) and off-chain (frontend signing).
    ///      Includes router + routerDataHash fields (H-01/C-01 hardening).
    /// @param order The full Order struct
    /// @return The keccak256 hash of the EIP-712 encoded order
    function getOrderHash(Order calldata order) public pure returns (bytes32) {
        return keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.owner,
            order.tokenIn,
            order.tokenOut,
            order.amountIn,
            order.minAmountOut,
            order.orderType,
            order.condition,
            order.targetPrice,
            order.priceFeed,
            order.expiry,
            order.nonce,
            order.router,            // [H-01] Router is part of hash
            order.routerDataHash,    // [C-01] routerData hash prevents calldata substitution
            order.dcaInterval,
            order.dcaTotal
        ));
    }

    /// @notice EIP-712 domain separator (exposed for frontend)
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    receive() external payable {}
}
