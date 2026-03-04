// SPDX-License-Identifier: MIT
// TeraSwapFeeCollector — flattened for Remix deployment
// OpenZeppelin Contracts v5.0 (minimal excerpts)
pragma solidity ^0.8.20;

// ═══════════════════════════════════════════════════════════
//  OpenZeppelin: IERC20
// ═══════════════════════════════════════════════════════════
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

// ═══════════════════════════════════════════════════════════
//  OpenZeppelin: SafeERC20
// ═══════════════════════════════════════════════════════════
library SafeERC20 {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeCall(token.transfer, (to, value)));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeCall(token.transferFrom, (from, to, value)));
    }

    function forceApprove(IERC20 token, address spender, uint256 value) internal {
        bytes memory approvalCall = abi.encodeCall(token.approve, (spender, value));
        if (!_callOptionalReturnBool(token, approvalCall)) {
            _callOptionalReturn(token, abi.encodeCall(token.approve, (spender, 0)));
            _callOptionalReturn(token, approvalCall);
        }
    }

    function _callOptionalReturn(IERC20 token, bytes memory data) private {
        (bool success, bytes memory returndata) = address(token).call(data);
        require(success, "SafeERC20: low-level call failed");
        if (returndata.length > 0) {
            require(abi.decode(returndata, (bool)), "SafeERC20: ERC20 operation did not succeed");
        }
    }

    function _callOptionalReturnBool(IERC20 token, bytes memory data) private returns (bool) {
        (bool success, bytes memory returndata) = address(token).call(data);
        return success && (returndata.length == 0 || abi.decode(returndata, (bool)));
    }
}

// ═══════════════════════════════════════════════════════════
//  OpenZeppelin: ReentrancyGuard
// ═══════════════════════════════════════════════════════════
abstract contract ReentrancyGuard {
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private _status;

    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = NOT_ENTERED;
    }

    modifier nonReentrant() {
        if (_status == ENTERED) revert ReentrancyGuardReentrantCall();
        _status = ENTERED;
        _;
        _status = NOT_ENTERED;
    }
}

// ═══════════════════════════════════════════════════════════
//  TeraSwapFeeCollector
// ═══════════════════════════════════════════════════════════

/**
 * @title TeraSwapFeeCollector
 * @notice Universal fee collection proxy for TeraSwap DEX meta-aggregator.
 *         Collects 0.1% (10 bps) on every swap, forwards rest to DEX router.
 */
contract TeraSwapFeeCollector is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable feeRecipient;
    uint256 public constant FEE_BPS = 10;           // 0.1%
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
    function swapETHWithFee(
        address router,
        bytes calldata routerData
    ) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();

        uint256 fee = (msg.value * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netValue = msg.value - fee;

        (bool feeOk, ) = feeRecipient.call{value: fee}("");
        if (!feeOk) revert FeeFailed();

        (bool swapOk, bytes memory result) = router.call{value: netValue}(routerData);
        if (!swapOk) revert SwapFailed(result);

        uint256 remaining = address(this).balance;
        if (remaining > 0) {
            (bool refundOk, ) = msg.sender.call{value: remaining}("");
            if (!refundOk) revert RefundFailed();
        }

        emit SwapWithFee(msg.sender, router, address(0), msg.value, fee);
    }

    /// @notice Swap ERC-20 tokens with fee collection
    function swapTokenWithFee(
        address token,
        uint256 totalAmount,
        address router,
        bytes calldata routerData
    ) external nonReentrant {
        if (totalAmount == 0) revert ZeroAmount();

        uint256 fee = (totalAmount * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netAmount = totalAmount - fee;

        IERC20(token).safeTransferFrom(msg.sender, address(this), totalAmount);
        IERC20(token).safeTransfer(feeRecipient, fee);

        IERC20(token).forceApprove(router, netAmount);
        (bool ok, bytes memory result) = router.call(routerData);
        if (!ok) revert SwapFailed(result);

        IERC20(token).forceApprove(router, 0);

        uint256 tokenBalance = IERC20(token).balanceOf(address(this));
        if (tokenBalance > 0) {
            IERC20(token).safeTransfer(msg.sender, tokenBalance);
        }

        uint256 ethBalance = address(this).balance;
        if (ethBalance > 0) {
            (bool refundOk, ) = msg.sender.call{value: ethBalance}("");
            if (!refundOk) revert RefundFailed();
        }

        emit SwapWithFee(msg.sender, router, token, totalAmount, fee);
    }

    /// @notice Rescue stuck funds (only feeRecipient)
    function sweep(address token) external {
        if (msg.sender != feeRecipient) revert NotAuthorized();
        if (token == address(0)) {
            (bool ok, ) = feeRecipient.call{value: address(this).balance}("");
            require(ok, "ETH sweep failed");
        } else {
            IERC20(token).safeTransfer(
                feeRecipient,
                IERC20(token).balanceOf(address(this))
            );
        }
    }

    receive() external payable {}
}
