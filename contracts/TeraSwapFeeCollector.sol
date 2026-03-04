// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
    uint256 public constant FEE_BPS = 10; // 0.1%
    uint256 public constant BPS_DENOMINATOR = 10_000;

    event SwapWithFee(
        address indexed user,
        address indexed router,
        address tokenIn,
        uint256 totalAmount,
        uint256 feeAmount
    );

    error ZeroAddress();
    error ZeroAmount();
    error FeeFailed();
    error SwapFailed(bytes reason);
    error RefundFailed();
    error NotAuthorized();

    constructor(address _feeRecipient) {
        if (_feeRecipient == address(0)) revert ZeroAddress();
        feeRecipient = _feeRecipient;
    }

    /// @notice Swap native ETH with fee collection
    /// @param router Target DEX router contract
    /// @param routerData Encoded swap calldata for the router
    function swapETHWithFee(
        address router,
        bytes calldata routerData
    ) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();

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
    ) external nonReentrant {
        if (totalAmount == 0) revert ZeroAmount();

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

    /// @notice Rescue stuck funds (only feeRecipient can call)
    function sweep(address token) external {
        if (msg.sender != feeRecipient) revert NotAuthorized();
        if (token == address(0)) {
            payable(feeRecipient).transfer(address(this).balance);
        } else {
            IERC20(token).safeTransfer(
                feeRecipient,
                IERC20(token).balanceOf(address(this))
            );
        }
    }

    /// @notice Accept ETH from routers (e.g. WETH unwrap, partial refunds)
    receive() external payable {}
}
