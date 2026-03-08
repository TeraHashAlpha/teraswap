// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

/**
 * @title TeraSwapOrderExecutor
 * @author TeraSwap
 * @notice Executes conditional swap orders (Limit, Stop-Loss, DCA) signed by users via EIP-712.
 *         Orders are stored off-chain (Supabase) and executed by Gelato Automate
 *         when price conditions are met.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                         ARCHITECTURE                               │
 * │                                                                     │
 * │  User signs EIP-712 order ──► Stored in Supabase                   │
 * │                                     │                               │
 * │  Gelato cron (30s) ──► checker() ──► canExec? ──► executeOrder()   │
 * │                                                                     │
 * │  Contract verifies:                                                 │
 * │    1. Signature is valid (EIP-712)                                  │
 * │    2. Order not expired / not cancelled                             │
 * │    3. Price condition met (Chainlink oracle)                        │
 * │    4. User has sufficient balance + allowance                       │
 * │                                                                     │
 * │  Then executes the swap through the specified DEX router            │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * SECURITY NOTES:
 * - Users approve THIS contract (not individual routers)
 * - Orders can only be executed once (nonce tracking)
 * - Users can cancel by calling cancelOrder() or revoking approval
 * - Only whitelisted routers can be used as swap targets
 * - Chainlink oracle prices verified with staleness check
 *
 * FUTURE: Replace Gelato with custom keeper network (Roadmap Phase 2)
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
        // DCA-specific fields
        uint256 dcaInterval;     // Seconds between DCA executions (0 for non-DCA)
        uint256 dcaTotal;        // Total number of DCA executions planned
    }

    // EIP-712 type hash
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,"
        "uint256 minAmountOut,uint8 orderType,uint8 condition,uint256 targetPrice,"
        "address priceFeed,uint256 expiry,uint256 nonce,uint256 dcaInterval,uint256 dcaTotal)"
    );

    // ══════════════════════════════════════════════════════════════════
    //  STATE
    // ══════════════════════════════════════════════════════════════════

    address public immutable feeRecipient;
    uint256 public constant FEE_BPS = 10; // 0.1% fee
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_STALENESS = 3600; // 1 hour for Chainlink data

    /// @notice Per-user nonce (increments after each execution)
    mapping(address => uint256) public nonces;

    /// @notice Cancelled order hashes
    mapping(bytes32 => bool) public cancelledOrders;

    /// @notice DCA execution counts: orderHash => timesExecuted
    mapping(bytes32 => uint256) public dcaExecutions;

    /// @notice DCA last execution time: orderHash => timestamp
    mapping(bytes32 => uint256) public dcaLastExecution;

    /// @notice Whitelisted DEX routers (security: prevent routing to malicious contracts)
    mapping(address => bool) public whitelistedRouters;

    /// @notice Admin (for router whitelist management)
    address public admin;

    // ══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ══════════════════════════════════════════════════════════════════

    event OrderExecuted(
        bytes32 indexed orderHash,
        address indexed owner,
        OrderType orderType,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );

    event OrderCancelled(bytes32 indexed orderHash, address indexed owner);
    event RouterWhitelisted(address indexed router, bool status);

    // ══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ══════════════════════════════════════════════════════════════════

    error InvalidSignature();
    error OrderExpired();
    error OrderCancelledError();
    error OrderAlreadyExecuted();
    error PriceConditionNotMet();
    error StalePriceFeed();
    error InsufficientOutput();
    error RouterNotWhitelisted();
    error DCAIntervalNotReached();
    error DCAComplete();
    error NotAdmin();
    error NotOwner();
    error SwapFailed(bytes reason);
    error ZeroAddress();

    // ══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════

    constructor(
        address _feeRecipient,
        address _admin
    ) EIP712("TeraSwapOrderExecutor", "1") {
        if (_feeRecipient == address(0) || _admin == address(0)) revert ZeroAddress();
        feeRecipient = _feeRecipient;
        admin = _admin;
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

        // 4. Check nonce (non-DCA orders: single execution)
        if (order.orderType != OrderType.DCA && nonces[order.owner] != order.nonce) {
            return (false, "Nonce mismatch");
        }

        // 5. DCA checks
        if (order.orderType == OrderType.DCA) {
            if (dcaExecutions[orderHash] >= order.dcaTotal) return (false, "DCA complete");
            if (block.timestamp < dcaLastExecution[orderHash] + order.dcaInterval) {
                return (false, "DCA interval not reached");
            }
        }

        // 6. Check price condition
        (bool priceOk, string memory priceReason) = _checkPriceCondition(
            order.priceFeed,
            order.condition,
            order.targetPrice
        );
        if (!priceOk) return (false, priceReason);

        // 7. Check user balance & allowance
        uint256 balance = IERC20(order.tokenIn).balanceOf(order.owner);
        uint256 allowance = IERC20(order.tokenIn).allowance(order.owner, address(this));
        uint256 requiredAmount = order.orderType == OrderType.DCA
            ? order.amountIn / order.dcaTotal  // DCA: divide by total executions
            : order.amountIn;

        if (balance < requiredAmount) return (false, "Insufficient balance");
        if (allowance < requiredAmount) return (false, "Insufficient allowance");

        return (true, "");
    }

    // ══════════════════════════════════════════════════════════════════
    //  EXECUTE ORDER (called by Gelato or any keeper)
    // ══════════════════════════════════════════════════════════════════

    /**
     * @notice Execute a signed order when conditions are met.
     * @param order The order struct (must match the signed data)
     * @param signature EIP-712 signature from order.owner
     * @param router Target DEX router for the swap
     * @param routerData Encoded swap calldata for the router
     */
    function executeOrder(
        Order calldata order,
        bytes calldata signature,
        address router,
        bytes calldata routerData
    ) external nonReentrant {
        bytes32 orderHash = getOrderHash(order);

        // ── Verify signature ──
        address signer = ECDSA.recover(_hashTypedDataV4(orderHash), signature);
        if (signer != order.owner) revert InvalidSignature();

        // ── Check order state ──
        if (cancelledOrders[orderHash]) revert OrderCancelledError();
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (!whitelistedRouters[router]) revert RouterNotWhitelisted();

        // ── Nonce / DCA checks ──
        uint256 executeAmount;

        if (order.orderType == OrderType.DCA) {
            if (dcaExecutions[orderHash] >= order.dcaTotal) revert DCAComplete();
            if (block.timestamp < dcaLastExecution[orderHash] + order.dcaInterval) {
                revert DCAIntervalNotReached();
            }
            executeAmount = order.amountIn / order.dcaTotal; // per-execution amount
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

        // ── Calculate fee ──
        uint256 fee = (executeAmount * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netAmount = executeAmount - fee;

        // ── Pull tokens from user ──
        IERC20(order.tokenIn).safeTransferFrom(order.owner, address(this), executeAmount);

        // ── Send fee ──
        IERC20(order.tokenIn).safeTransfer(feeRecipient, fee);

        // ── Execute swap ──
        IERC20(order.tokenIn).forceApprove(router, netAmount);

        (bool ok, bytes memory result) = router.call(routerData);
        if (!ok) revert SwapFailed(result);

        // Revoke approval
        IERC20(order.tokenIn).forceApprove(router, 0);

        // ── Verify output ──
        // For DCA, minAmountOut is per-execution
        uint256 minOut = order.orderType == OrderType.DCA
            ? order.minAmountOut / order.dcaTotal
            : order.minAmountOut;

        uint256 outputBalance = IERC20(order.tokenOut).balanceOf(address(this));
        if (outputBalance < minOut) revert InsufficientOutput();

        // ── Send output to user ──
        IERC20(order.tokenOut).safeTransfer(order.owner, outputBalance);

        // ── Update state ──
        if (order.orderType == OrderType.DCA) {
            dcaExecutions[orderHash]++;
            dcaLastExecution[orderHash] = block.timestamp;
        } else {
            nonces[order.owner]++;
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
            outputBalance,
            fee
        );
    }

    // ══════════════════════════════════════════════════════════════════
    //  USER ACTIONS
    // ══════════════════════════════════════════════════════════════════

    /// @notice Cancel a pending order (only the order owner can call)
    function cancelOrder(Order calldata order) external {
        if (msg.sender != order.owner) revert NotOwner();
        bytes32 orderHash = getOrderHash(order);
        cancelledOrders[orderHash] = true;
        emit OrderCancelled(orderHash, msg.sender);
    }

    /// @notice Get the current nonce for a user
    function getNonce(address user) external view returns (uint256) {
        return nonces[user];
    }

    // ══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ══════════════════════════════════════════════════════════════════

    function setRouter(address router, bool status) external {
        if (msg.sender != admin) revert NotAdmin();
        whitelistedRouters[router] = status;
        emit RouterWhitelisted(router, status);
    }

    function setAdmin(address newAdmin) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newAdmin == address(0)) revert ZeroAddress();
        admin = newAdmin;
    }

    /// @notice Rescue stuck tokens (admin only, safety net)
    function sweep(address token) external {
        if (msg.sender != admin) revert NotAdmin();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(admin, bal);
    }

    // ══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ══════════════════════════════════════════════════════════════════

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
        (, int256 price, , uint256 updatedAt, ) = feed.latestRoundData();

        if (price <= 0) return (false, "Invalid price");
        if (block.timestamp - updatedAt > MAX_STALENESS) return (false, "Stale price feed");

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
