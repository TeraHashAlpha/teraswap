// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

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

    /// @notice [Audit] Router whitelist for FeeCollector
    mapping(address => bool) public whitelistedRouters;

    event SwapWithFee(
        address indexed user,
        address indexed router,
        address tokenIn,
        uint256 totalAmount,
        uint256 feeAmount
    );
    event Paused(address indexed admin);
    event Unpaused(address indexed admin);
    event RouterWhitelisted(address indexed router, bool status);
    event Sweep(address indexed token);

    error ZeroAddress();
    error ZeroAmount();
    error FeeFailed();
    error SwapFailed(bytes reason);
    error RefundFailed();
    error NotAuthorized();
    error ContractPaused();
    error RouterNotWhitelisted();

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

    /// @notice Whitelist routers for FeeCollector
    function setRouter(address router, bool status) external onlyAdmin {
        if (router == address(0)) revert ZeroAddress();
        whitelistedRouters[router] = status;
        emit RouterWhitelisted(router, status);
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
    function swapETHWithFee(
        address router,
        bytes calldata routerData
    ) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        if (!whitelistedRouters[router]) revert RouterNotWhitelisted();

        uint256 fee = (msg.value * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netValue = msg.value - fee;

        // Send fee
        (bool feeOk, ) = feeRecipient.call{value: fee}("");
        if (!feeOk) revert FeeFailed();

        // Forward to router
        (bool swapOk, bytes memory result) = router.call{value: netValue}(routerData);
        if (!swapOk) revert SwapFailed(result);

        // Refund any leftover ETH (e.g. from partial fills)
        uint256 remaining = address(this).balance;
        if (remaining > 0) {
            (bool refundOk, ) = msg.sender.call{value: remaining}("");
            if (!refundOk) revert RefundFailed();
        }

        emit SwapWithFee(msg.sender, router, address(0), msg.value, fee);
    }

    /// @notice Swap ERC-20 tokens with fee collection
    /// @param token Input token address
    /// @param totalAmount Total amount to pull from user (includes fee)
    /// @param router Target DEX router contract
    /// @param routerData Encoded swap calldata for the router
    function swapTokenWithFee(
        address token,
        uint256 totalAmount,
        address router,
        bytes calldata routerData
    ) external nonReentrant whenNotPaused {
        if (totalAmount == 0) revert ZeroAmount();
        if (!whitelistedRouters[router]) revert RouterNotWhitelisted();

        uint256 fee = (totalAmount * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netAmount = totalAmount - fee;

        // Pull tokens from user
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalAmount);

        // Send fee to recipient
        IERC20(token).safeTransfer(feeRecipient, fee);

        // Approve router for net amount and execute swap
        IERC20(token).forceApprove(router, netAmount);

        (bool ok, bytes memory result) = router.call(routerData);
        if (!ok) revert SwapFailed(result);

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

        emit SwapWithFee(msg.sender, router, token, totalAmount, fee);
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

    /// @notice Accept ETH from routers (e.g. WETH unwrap, partial refunds)
    receive() external payable {}
}
