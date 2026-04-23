// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title TeraSwapFeeCollector
 * @notice Universal fee collection proxy for TeraSwap DEX meta-aggregator.
 *         Collects a flat 0.1% (10 bps) fee on every swap, then forwards
 *         the remaining funds to the target DEX router.
 *
 * Flow (ETH input):
 *   1. User calls swapETHWithFee{value: totalAmount}(router, routerData)
 *   2. Contract sends fee to feeRecipient
 *   3. Contract forwards netAmount to router via routerData calldata
 *   4. Any leftover ETH/tokens refunded to user
 *
 * Flow (ERC-20 input):
 *   1. User approves this contract for totalAmount
 *   2. User calls swapTokenWithFee(token, totalAmount, router, routerData)
 *   3. Contract pulls tokens, sends fee, approves router, executes swap
 *   4. Revokes approval and refunds leftovers
 */
contract TeraSwapFeeCollector is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable feeRecipient;
    address public admin;
    uint256 public constant FEE_BPS = 10; // 0.1%
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice [Audit L-01] Emergency pause
    bool public paused;

    /// @notice [SC-L] Guard: only accept ETH during active swap execution
    bool private _inSwap;

    /// @notice [Audit] Router whitelist for FeeCollector
    mapping(address => bool) public whitelistedRouters;

    /// @notice [R-12] Timelock constants for router changes
    uint256 public constant TIMELOCK_DELAY = 48 hours;
    uint256 public constant TIMELOCK_GRACE = 7 days;

    /// @notice Pending timelock action
    struct TimelockAction {
        bytes32 actionHash;
        uint256 readyAt;
        bool exists;
    }

    /// @notice Timelock actions: actionId => TimelockAction
    mapping(bytes32 => TimelockAction) public timelockActions;

    /// @notice Whether initial bootstrap has been used (one-time router setup)
    bool public bootstrapped;

    event SwapWithFee(
        address indexed user,
        address indexed router,
        address tokenIn,
        uint256 totalAmount,
        uint256 feeAmount,
        address tokenOut,
        uint256 outputAmount
    );
    event Paused(address indexed admin);
    event Unpaused(address indexed admin);
    event RouterWhitelisted(address indexed router, bool status);
    event Sweep(address indexed token);
    event TimelockQueued(bytes32 indexed actionId, bytes32 actionHash, uint256 readyAt);
    event TimelockExecuted(bytes32 indexed actionId, string actionType, bytes data);
    event TimelockCancelled(bytes32 indexed actionId);
    event Bootstrap(address indexed router);

    error ZeroAddress();
    error ZeroAmount();
    error FeeFailed();
    error SwapFailed(bytes reason);
    error RefundFailed();
    error NotAuthorized();
    error ContractPaused();
    error RouterNotWhitelisted();
    error TimelockAlreadyQueued();
    error TimelockNotQueued();
    error TimelockNotReady();
    error TimelockExpired();
    error TimelockHashMismatch();
    error AlreadyBootstrapped();
    error ETHNotAccepted();
    /// @notice [H-04] Router returned less than the user's declared minimumOutput
    error InsufficientOutput(uint256 actual, uint256 minimum);

    constructor(address _feeRecipient, address _admin) {
        if (_feeRecipient == address(0) || _admin == address(0)) revert ZeroAddress();
        feeRecipient = _feeRecipient;
        admin = _admin;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAuthorized();
        _;
    }

    /// @notice [R-12] Queue a router whitelist change (48h delay)
    function queueRouterChange(address router, bool status) external onlyAdmin {
        if (router == address(0)) revert ZeroAddress();

        bytes32 actionHash = keccak256(abi.encode("setRouter", router, status));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        if (timelockActions[actionId].exists) revert TimelockAlreadyQueued();

        timelockActions[actionId] = TimelockAction({
            actionHash: actionHash,
            readyAt: block.timestamp + TIMELOCK_DELAY,
            exists: true
        });

        emit TimelockQueued(actionId, actionHash, block.timestamp + TIMELOCK_DELAY);
    }

    /// @notice Execute a queued router whitelist change after timelock
    function executeRouterChange(bytes32 actionId, address router, bool status) external onlyAdmin {
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

    /// @notice Cancel a queued timelock action
    function cancelTimelockAction(bytes32 actionId) external onlyAdmin {
        if (!timelockActions[actionId].exists) revert TimelockNotQueued();
        delete timelockActions[actionId];
        emit TimelockCancelled(actionId);
    }

    /// @notice One-time bootstrap: whitelist initial routers without timelock
    /// @param routers Array of router addresses to whitelist
    function bootstrapRouters(address[] calldata routers) external onlyAdmin {
        if (bootstrapped) revert AlreadyBootstrapped();
        bootstrapped = true;

        for (uint256 i = 0; i < routers.length; i++) {
            if (routers[i] == address(0)) revert ZeroAddress();
            whitelistedRouters[routers[i]] = true;
            emit Bootstrap(routers[i]);
        }
    }

    /// @notice Emergency pause
    function pause() external onlyAdmin {
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Unpause
    function unpause() external onlyAdmin {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Swap native ETH with fee collection
    /// @param router Target DEX router contract
    /// @param routerData Encoded swap calldata for the router
    /// @param tokenOut Output token address (address(0) for ETH — only meaningful for circular refunds)
    /// @param minimumOutput Minimum tokens the user expects to receive; 0 disables the check
    function swapETHWithFee(
        address router,
        bytes calldata routerData,
        address tokenOut,
        uint256 minimumOutput
    ) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        if (!whitelistedRouters[router]) revert RouterNotWhitelisted();

        // [H-04] Snapshot user's output balance BEFORE router call
        uint256 ethBefore = msg.sender.balance;
        uint256 tokenOutBefore = tokenOut != address(0)
            ? IERC20(tokenOut).balanceOf(msg.sender)
            : 0;

        uint256 fee = (msg.value * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netValue = msg.value - fee;

        // Send fee
        (bool feeOk, ) = feeRecipient.call{value: fee}("");
        if (!feeOk) revert FeeFailed();

        // Forward to router (enable receive() for router ETH refunds)
        _inSwap = true;
        (bool swapOk, bytes memory result) = router.call{value: netValue}(routerData);
        if (!swapOk) revert SwapFailed(result);
        _inSwap = false;

        // Refund any leftover ETH (e.g. from partial fills)
        uint256 remaining = address(this).balance;
        if (remaining > 0) {
            (bool refundOk, ) = msg.sender.call{value: remaining}("");
            if (!refundOk) revert RefundFailed();
        }

        // [H-04] Validate output AFTER router call + refunds
        uint256 actualOutput;
        if (tokenOut == address(0)) {
            actualOutput = msg.sender.balance - ethBefore;
        } else {
            actualOutput = IERC20(tokenOut).balanceOf(msg.sender) - tokenOutBefore;
        }
        if (minimumOutput > 0 && actualOutput < minimumOutput) {
            revert InsufficientOutput(actualOutput, minimumOutput);
        }

        emit SwapWithFee(msg.sender, router, address(0), msg.value, fee, tokenOut, actualOutput);
    }

    /// @notice Swap ERC-20 tokens with fee collection
    /// @param token Input token address
    /// @param totalAmount Total amount to pull from user (includes fee)
    /// @param router Target DEX router contract
    /// @param routerData Encoded swap calldata for the router
    /// @param tokenOut Output token address (address(0) for ETH)
    /// @param minimumOutput Minimum tokens the user expects to receive; 0 disables the check
    function swapTokenWithFee(
        address token,
        uint256 totalAmount,
        address router,
        bytes calldata routerData,
        address tokenOut,
        uint256 minimumOutput
    ) external nonReentrant whenNotPaused {
        if (totalAmount == 0) revert ZeroAmount();
        if (!whitelistedRouters[router]) revert RouterNotWhitelisted();

        // [H-04] Snapshot user's output balance BEFORE any state changes
        uint256 ethBefore = msg.sender.balance;
        uint256 tokenOutBefore = tokenOut != address(0)
            ? IERC20(tokenOut).balanceOf(msg.sender)
            : 0;

        uint256 fee = (totalAmount * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netAmount = totalAmount - fee;

        // Pull tokens from user
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalAmount);

        // Send fee to recipient
        IERC20(token).safeTransfer(feeRecipient, fee);

        // Approve router for net amount and execute swap
        IERC20(token).forceApprove(router, netAmount);

        _inSwap = true;
        (bool ok, bytes memory result) = router.call(routerData);
        if (!ok) revert SwapFailed(result);
        _inSwap = false;

        // Revoke leftover approval (safety)
        IERC20(token).forceApprove(router, 0);

        // Return any leftover input tokens
        uint256 tokenBalance = IERC20(token).balanceOf(address(this));
        if (tokenBalance > 0) {
            IERC20(token).safeTransfer(msg.sender, tokenBalance);
        }

        // Return any ETH received (e.g. selling tokens for ETH)
        uint256 ethBalance = address(this).balance;
        if (ethBalance > 0) {
            (bool refundOk, ) = msg.sender.call{value: ethBalance}("");
            if (!refundOk) revert RefundFailed();
        }

        // [H-04] Validate output AFTER router call + refunds
        uint256 actualOutput;
        if (tokenOut == address(0)) {
            actualOutput = msg.sender.balance - ethBefore;
        } else {
            actualOutput = IERC20(tokenOut).balanceOf(msg.sender) - tokenOutBefore;
        }
        if (minimumOutput > 0 && actualOutput < minimumOutput) {
            revert InsufficientOutput(actualOutput, minimumOutput);
        }

        emit SwapWithFee(msg.sender, router, token, totalAmount, fee, tokenOut, actualOutput);
    }

    /// @notice [Audit F-09] Sweep with admin-only + pause check (prevents instant drain)
    /// @dev Admin-gated instead of feeRecipient-gated. Funds always go to feeRecipient.
    ///      Pause check ensures sweep cannot happen during an emergency pause.
    function sweep(address token) external onlyAdmin whenNotPaused {
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) {
                (bool ok, ) = feeRecipient.call{value: bal}("");
                require(ok, "ETH sweep failed");
            }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) {
                IERC20(token).safeTransfer(feeRecipient, bal);
            }
        }
        emit Sweep(token);
    }

    /// @notice Accept ETH from routers only during active swap execution
    /// @dev Reverts if called outside of swapETHWithFee/swapTokenWithFee to prevent
    ///      accidental ETH deposits that would be silently swallowed.
    receive() external payable {
        if (!_inSwap) revert ETHNotAccepted();
    }
}
