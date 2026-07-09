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
 * @title TeraSwapOrderExecutor v3
 * @author TeraSwap
 * @notice Executes conditional swap orders (Limit, Stop-Loss, DCA) signed by users via EIP-712.
 *         Orders are stored off-chain (Supabase) and executed by an autonomous keeper
 *         when price conditions are met.
 *
 *         v3 (ADR-013 §1–§3) is a NEW, non-upgradeable contract — the deployed v2 is immutable.
 *         It replaces v2's 1-wei minimum-output clamp with a real, on-chain per-chunk output floor
 *         derived from a Chainlink fair-value read at execution, bounded by a user-signed
 *         `maxSlippageBps`; resolves the non-DCA `routerDataHash` landmine (P1c); and swaps the
 *         sequential per-owner nonce for a Permit2-style unordered bitmap (P1b) so a never-triggering
 *         low-nonce order can no longer block a higher-nonce stop-loss.
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
 * │    6. Output clears the signed floor (ADR-013 §1)                  │
 * │                                                                     │
 * │  Then executes the swap through the signed DEX router               │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * SECURITY (v3, on top of v2 hardening):
 * - ADR-013 §1: real per-chunk output floor — `max(oracleFloor, scaledMinAmountOut)`, revert on breach.
 *   The v2 `if (minOut == 0) minOut = 1` clamp is GONE; a scaled min that rounds to 0 reverts.
 * - ADR-013 §2: non-DCA orders MUST carry a real routerDataHash (no ZeroHash bypass).
 * - ADR-013 §3: Permit2-style unordered nonce bitmap.
 * - N1 feed integrity: answer>0, staleness window, answeredInRound>=roundId; L2 sequencer uptime +
 *   grace on Base. Stale/invalid feed ⇒ NO-FEED semantics (signed absolute min), never fill blind.
 * - N3: `maxSlippageBps <= MAX_ORDER_SLIPPAGE_BPS = 500` (immutable constant, no setter).
 * - v2 carried over: H-01 signed router + whitelist, H-02 ETH output, M-01 balance/allowance,
 *   M-02 48h timelock, executor allowlist, reentrancy guard, recipient == order.owner (R1).
 *
 * Self-hosted keeper: contracts/order-engine/executor/executor.js
 */
contract TeraSwapOrderExecutorV3 is ReentrancyGuard, EIP712 {
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
        uint256 minAmountOut;    // Minimum acceptable output (slippage protection / no-feed floor)
        uint16 maxSlippageBps;   // [ADR-013 §1/N3] Max output shortfall vs fair value, <= MAX_ORDER_SLIPPAGE_BPS
        OrderType orderType;     // LIMIT | STOP_LOSS | DCA
        PriceCondition condition;// ABOVE or BELOW
        uint256 targetPrice;     // Price threshold (8 decimals, like Chainlink)
        address priceFeed;       // Chainlink price feed address (trigger condition)
        uint256 expiry;          // Unix timestamp — order expires after this
        uint256 nonce;           // [ADR-013 §3] Unordered bitmap nonce (prevents replay)
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

    // EIP-712 type hash — v3: adds `maxSlippageBps` (ADR-013 §1). New domain (version "3") — a v2
    // signature can never be replayed against v3 and vice-versa. `verifyingContract` is this
    // contract's address, unique per chain, so no two chains share a domain either.
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,"
        "uint256 minAmountOut,uint16 maxSlippageBps,uint8 orderType,uint8 condition,"
        "uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router,"
        "bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)"
    );

    // ══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ══════════════════════════════════════════════════════════════════

    uint256 public constant FEE_BPS = 10;           // 0.1% fee
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_STALENESS = 300;      // [H-03] 5 min staleness for the trigger feed
    uint256 public constant TIMELOCK_ADMIN_TRANSFER = 7 days;   // [R-12] Admin transfer requires 7-day delay
    uint256 public constant TIMELOCK_ROUTER_CHANGE  = 48 hours; // [R-12] Router whitelist change delay
    uint256 public constant TIMELOCK_SWEEP          = 48 hours; // [R-12] Sweep action delay
    uint256 public constant TIMELOCK_EXECUTOR_CHANGE = 48 hours; // [SC-H-01] Executor whitelist change delay
    uint256 public constant TIMELOCK_ORACLE_CHANGE  = 48 hours; // [ADR-013/P6] Oracle-config change delay
    uint256 public constant TIMELOCK_GRACE = 7 days;            // [Audit M-03] Timelock expiry window
    uint256 public constant MIN_ORDER_AMOUNT = 10_000; // [Audit M-01] Min order to prevent zero-fee

    /// @notice [ADR-013 §1/N3] Hard cap on the user-signed slippage bound. Immutable constant — NO setter.
    ///         uint16 alone would allow 65535 bps (655%); this caps the on-chain floor to <= 5% loss.
    uint16 public constant MAX_ORDER_SLIPPAGE_BPS = 500;

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

    /// @notice [SC-L] Guard: only accept ETH during active order execution
    bool private _inExecution;

    /// @notice [SC-H-01] Pending executor whitelist change proposals
    struct ExecutorProposal {
        bool proposed;
        bool newStatus;
        uint256 executeAfter;
    }
    mapping(address => ExecutorProposal) public pendingExecutorChanges;

    // [HIGH-004] Per-feed oracle configuration (trigger-feed bounds, unchanged from v2)
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
    error SlippageTooHigh();         // [ADR-013 §1/N3] maxSlippageBps > MAX_ORDER_SLIPPAGE_BPS
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
    error ETHNotAccepted();         // [SC-L]

    // ══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════

    /// @notice Deploy TeraSwapOrderExecutor v3.
    /// @dev EIP-712 domain name "TeraSwapOrderExecutor" and version "3" are immutable by design.
    ///      Bumping the version from "2" isolates v3 signatures from the deployed v2 contract.
    ///      Changing them post-deploy would invalidate all existing signatures — intentional for a
    ///      non-upgradeable contract.
    constructor(
        address _feeRecipient,
        address _admin,
        address _weth
    ) EIP712("TeraSwapOrderExecutor", "3") {
        if (_feeRecipient == address(0) || _admin == address(0) || _weth == address(0)) {
            revert ZeroAddress();
        }
        feeRecipient = _feeRecipient;
        admin = _admin;
        WETH = _weth;
    }

    // ══════════════════════════════════════════════════════════════════
    //  CHECKER (view — called off-chain to determine if order can execute)
    // ══════════════════════════════════════════════════════════════════

    /**
     * @notice Check if an order can be executed right now (best-effort, advisory).
     * @dev The oracle output floor (§1) depends on the swap result and can only be enforced at
     *      execution; this view checks the cheap, pre-swap conditions the keeper can act on.
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

        // 4. [ADR-013 §1/N3] Slippage bound
        if (order.maxSlippageBps > MAX_ORDER_SLIPPAGE_BPS) return (false, "Slippage too high");

        // 5. [H-01] Check router is whitelisted
        if (!whitelistedRouters[order.router]) return (false, "Router not whitelisted");

        // 6. [H-03] Check nonce invalidation
        if (order.nonce < invalidatedNonces[order.owner]) {
            return (false, "Nonce invalidated");
        }

        // 7. Check nonce (non-DCA orders: single execution)
        if (order.orderType != OrderType.DCA && nonces[order.owner] != order.nonce) {
            return (false, "Nonce mismatch");
        }

        // 8. DCA checks
        if (order.orderType == OrderType.DCA) {
            // [Audit L-04] Explicit validation for invalid DCA params
            if (order.dcaTotal == 0) return (false, "DCA total must be > 0");
            if (order.dcaInterval == 0) return (false, "DCA interval must be > 0");
            if (dcaExecutions[orderHash] >= order.dcaTotal) return (false, "DCA complete");
            if (block.timestamp < dcaLastExecution[orderHash] + order.dcaInterval) {
                return (false, "DCA interval not reached");
            }
        }

        // 9. Check price condition
        (bool priceOk, string memory priceReason) = _checkPriceCondition(
            order.priceFeed,
            order.condition,
            order.targetPrice
        );
        if (!priceOk) return (false, priceReason);

        // 10. [M-01] Check user balance & allowance
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
     * @dev Router is part of the signed Order struct (H-01). The caller provides routerData (swap
     *      calldata) which is executed against order.router. Output is bounded by the ADR-013 §1
     *      floor (oracle fair-value × (1 − maxSlippageBps), or the signed absolute min for no-feed
     *      pairs), not by keeper-supplied calldata.
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

        // ── [ADR-013 §1/N3] Signed slippage bound must be within the immutable cap ──
        if (order.maxSlippageBps > MAX_ORDER_SLIPPAGE_BPS) revert SlippageTooHigh();

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

        // ── [C-01 / ADR-013 §2] Verify routerData matches the hash signed by the user ──
        // [MEDIUM-006] Non-DCA orders MUST commit to specific routerData (no bytes32(0) bypass)
        if (order.orderType != OrderType.DCA) {
            if (order.routerDataHash == bytes32(0)) revert RouterDataMismatch();
            if (keccak256(routerData) != order.routerDataHash) revert RouterDataMismatch();
        }
        // DCA orders: routerDataHash bypass (bytes32(0)) is safe because the ADR-013 §1 oracle
        // floor (or the scaled signed absolute min for no-feed pairs) is the binding output
        // constraint, recipient is always order.owner, nonReentrant blocks compound attacks, and the
        // router must be whitelisted.

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
            uint256 perExecution = order.amountIn / order.dcaTotal;
            // [Audit H-02] Per-execution amount must meet minimum to prevent zero-fee attack
            if (perExecution < MIN_ORDER_AMOUNT) revert DCAChunkTooSmall();
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

        // ── [ADR-013 §1] Compute the per-chunk output floor BEFORE the swap ──
        // scaledMin: the user's signed absolute minimum, scaled to this chunk. The v2 1-wei clamp
        // is GONE — a scaled min that rounds to 0 is unexecutable (revert), not silently unprotected.
        uint256 scaledMin;
        if (order.orderType == OrderType.DCA) {
            scaledMin = (order.minAmountOut * executeAmount) / order.amountIn;
        } else {
            scaledMin = order.minAmountOut;
        }
        if (scaledMin == 0) revert InvalidMinOutput();
        // Commit 1: floor is the signed absolute min. The Chainlink oracle floor
        // (max(oracleFloor, scaledMin)) is layered in by the fair-value commit (ADR-013 §1 full).
        uint256 floorOut = scaledMin;

        // ── Pull tokens from user ──
        IERC20(order.tokenIn).safeTransferFrom(order.owner, address(this), executeAmount);

        // ── Send fee ──
        IERC20(order.tokenIn).safeTransfer(feeRecipient, fee);

        // ── Execute swap via signed router ──
        IERC20(order.tokenIn).forceApprove(order.router, netAmount);

        uint256 ethBefore = address(this).balance;
        // [M-01] Record tokenOut balance BEFORE swap to use delta (not absolute)
        uint256 tokenOutBefore = IERC20(order.tokenOut).balanceOf(address(this));

        _inExecution = true;
        (bool ok, bytes memory result) = order.router.call(routerData);
        if (!ok) revert SwapFailed(result);
        _inExecution = false;

        // Revoke approval
        IERC20(order.tokenIn).forceApprove(order.router, 0);

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

        // ── [ADR-013 §1] Verify output meets the floor; deliver to order.owner (R1 unchanged) ──
        if (tokenOutBalance >= floorOut) {
            // Standard ERC-20 output
            IERC20(order.tokenOut).safeTransfer(order.owner, tokenOutBalance);
        } else if (order.tokenOut == WETH && ethReceived >= floorOut) {
            // Router returned native ETH — send ETH directly (WETH-equivalent), fallback to wrap
            (bool ethOk, ) = order.owner.call{value: ethReceived}("");
            if (!ethOk) {
                IWETH(WETH).deposit{value: ethReceived}();
                IERC20(WETH).safeTransfer(order.owner, ethReceived);
            }
        } else if (tokenOutBalance + ethReceived >= floorOut) {
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
    function invalidateNonces(uint256 newNonce) external {
        require(newNonce > invalidatedNonces[msg.sender], "Must increase");
        // [Audit M-04] Upper bound: cannot jump more than 1000 nonces ahead
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

    /// @notice Queue a router whitelist change (48h delay)
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
        if (block.timestamp > action.readyAt + TIMELOCK_GRACE) revert TimelockExpired();

        bytes32 expectedHash = keccak256(abi.encode("setRouter", router, status));
        if (action.actionHash != expectedHash) revert TimelockHashMismatch();

        delete timelockActions[actionId];
        whitelistedRouters[router] = status;

        emit TimelockExecuted(actionId, "setRouter", abi.encode(router, status));
        emit RouterWhitelisted(router, status);
    }

    /// @notice Queue an admin transfer (7d delay)
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
     * @param routers Array of router addresses to whitelist
     * @param executors Array of executor addresses to whitelist
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
    //  ORACLE CONFIGURATION [HIGH-004] — trigger-feed bounds (v2 parity)
    // ══════════════════════════════════════════════════════════════════

    /// @notice Register/update a Chainlink trigger price feed with per-feed bounds
    /// @dev [ADR-013/P6] In v3 the fair-value oracle config (token → USD feed, §1) is timelocked;
    ///      this trigger-feed registration keeps the v2 behaviour for the price-condition check only.
    function setOracleConfig(
        address feed,
        uint256 maxStaleness,
        int256 minPrice,
        int256 maxPrice
    ) external {
        if (msg.sender != admin) revert NotAdmin();
        if (feed == address(0)) revert ZeroAddress();

        uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
        require(feedDecimals == 8 || feedDecimals == 18, "Unexpected feed decimals");

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

        OracleConfig memory config = oracleConfigs[priceFeed];
        uint256 staleness = (config.registered && config.maxStaleness > 0)
            ? config.maxStaleness
            : MAX_STALENESS;
        if (block.timestamp - updatedAt > staleness) return (false, "Stale price feed");

        if (answeredInRound < roundId) return (false, "Incomplete round");

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
    /// @dev Includes maxSlippageBps (ADR-013 §1), router + routerDataHash (H-01/C-01 hardening).
    function getOrderHash(Order calldata order) public pure returns (bytes32) {
        return keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.owner,
            order.tokenIn,
            order.tokenOut,
            order.amountIn,
            order.minAmountOut,
            order.maxSlippageBps,    // [ADR-013 §1] signed slippage bound
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

    /// @notice Accept ETH only during active order execution (router ETH output / WETH unwrap)
    receive() external payable {
        if (!_inExecution) revert ETHNotAccepted();
    }
}
