// SPDX-License-Identifier: MIT
// TeraSwapFeeCollector V2 — Hardened per Pre-Audit Report (March 2026)
// Fixes: CRITICAL-001, CRITICAL-002, HIGH-001, HIGH-002, MEDIUM-001, MEDIUM-002, LOW-001, LOW-002
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
//  TeraSwapFeeCollector V2 — Hardened
// ═══════════════════════════════════════════════════════════

/**
 * @title TeraSwapFeeCollector V2
 * @notice Universal fee collection proxy for TeraSwap DEX meta-aggregator.
 *         Collects 0.1% (10 bps) on every swap, forwards rest to DEX router.
 *
 * V2 Security Hardening (Pre-Audit Report fixes):
 * - [CRITICAL-001] Function selector whitelist on router calls
 * - [CRITICAL-002] CEI pattern: router call before fee transfer in ETH path
 * - [HIGH-001] Balance-delta verification around router calls
 * - [HIGH-002] 48h timelock on sweep()
 * - [MEDIUM-001] Fee-on-transfer token support via balance-delta
 * - [MEDIUM-002] Rebasing token handling via actual balance for refunds
 * - [LOW-001] Pausable mechanism
 * - [LOW-002] Router address validation (must be contract)
 */
contract TeraSwapFeeCollectorV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════
    //  CONSTANTS & IMMUTABLES
    // ══════════════════════════════════════════════════════════

    address public immutable feeRecipient;
    address public admin;
    uint256 public constant FEE_BPS = 10;           // 0.1%
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant TIMELOCK_DELAY = 48 hours;  // [HIGH-002]
    uint256 public constant MIN_SWAP_AMOUNT = 1000;     // [MEDIUM-003] Min to avoid zero-fee

    // ══════════════════════════════════════════════════════════
    //  STATE
    // ══════════════════════════════════════════════════════════

    bool public paused;  // [LOW-001]

    // [CRITICAL-001] Function selector whitelist: router => selector => allowed
    mapping(address => mapping(bytes4 => bool)) public allowedSelectors;

    // [HIGH-002] Timelocked sweep
    struct PendingSweep {
        address token;
        address recipient;
        uint256 executeAfter;
        bool exists;
    }
    mapping(bytes32 => PendingSweep) public pendingSweeps;

    // ══════════════════════════════════════════════════════════
    //  EVENTS
    // ══════════════════════════════════════════════════════════

    event SwapWithFee(
        address indexed user,
        address indexed router,
        address tokenIn,
        uint256 totalAmount,
        uint256 feeAmount
    );
    event SelectorWhitelisted(address indexed router, bytes4 indexed selector, bool allowed);
    event SweepRequested(bytes32 indexed sweepId, address token, address recipient, uint256 executeAfter);
    event SweepExecuted(bytes32 indexed sweepId, address token, address recipient, uint256 amount);
    event SweepCancelled(bytes32 indexed sweepId);
    event PauseToggled(bool paused);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ══════════════════════════════════════════════════════════
    //  ERRORS
    // ══════════════════════════════════════════════════════════

    error ZeroAddress();
    error ZeroAmount();
    error FeeFailed();
    error SwapFailed(bytes reason);
    error RefundFailed();
    error NotAuthorized();
    error ContractPaused();
    error SelectorNotWhitelisted(address router, bytes4 selector);
    error RouterNotContract(address router);
    error RouterTookTooMuch(uint256 expected, uint256 actual);
    error AmountTooSmall();
    error SweepNotReady();
    error SweepNotFound();

    // ══════════════════════════════════════════════════════════
    //  MODIFIERS
    // ══════════════════════════════════════════════════════════

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAuthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    // ══════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ══════════════════════════════════════════════════════════

    constructor(address _feeRecipient, address _admin) {
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();
        feeRecipient = _feeRecipient;
        admin = _admin;
    }

    // ══════════════════════════════════════════════════════════
    //  ADMIN: SELECTOR WHITELIST [CRITICAL-001]
    // ══════════════════════════════════════════════════════════

    /// @notice Whitelist a function selector for a specific router
    function setAllowedSelector(
        address router,
        bytes4 selector,
        bool allowed
    ) external onlyAdmin {
        // [LOW-002] Validate router is a contract
        if (router.code.length == 0) revert RouterNotContract(router);
        allowedSelectors[router][selector] = allowed;
        emit SelectorWhitelisted(router, selector, allowed);
    }

    /// @notice Batch whitelist selectors (for initial setup)
    function batchWhitelistSelectors(
        address router,
        bytes4[] calldata selectors
    ) external onlyAdmin {
        if (router.code.length == 0) revert RouterNotContract(router);
        for (uint256 i = 0; i < selectors.length; i++) {
            allowedSelectors[router][selectors[i]] = true;
            emit SelectorWhitelisted(router, selectors[i], true);
        }
    }

    // ══════════════════════════════════════════════════════════
    //  CORE: SWAP WITH FEE (ETH)
    // ══════════════════════════════════════════════════════════

    /// @notice Swap native ETH with fee collection
    /// [CRITICAL-002] CEI pattern: router.call() BEFORE feeRecipient.call()
    function swapETHWithFee(
        address router,
        bytes calldata routerData
    ) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value < MIN_SWAP_AMOUNT) revert AmountTooSmall();

        // [CRITICAL-001] Validate function selector
        bytes4 selector = bytes4(routerData[:4]);
        if (!allowedSelectors[router][selector]) {
            revert SelectorNotWhitelisted(router, selector);
        }

        uint256 fee = (msg.value * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netValue = msg.value - fee;

        // [CRITICAL-002] Router call FIRST (CEI pattern)
        (bool swapOk, bytes memory result) = router.call{value: netValue}(routerData);
        if (!swapOk) revert SwapFailed(result);

        // Fee transfer AFTER router call succeeds
        (bool feeOk, ) = feeRecipient.call{value: fee}("");
        if (!feeOk) revert FeeFailed();

        // Refund any remaining ETH
        uint256 remaining = address(this).balance;
        if (remaining > 0) {
            (bool refundOk, ) = msg.sender.call{value: remaining}("");
            if (!refundOk) revert RefundFailed();
        }

        emit SwapWithFee(msg.sender, router, address(0), msg.value, fee);
    }

    // ══════════════════════════════════════════════════════════
    //  CORE: SWAP WITH FEE (ERC-20)
    // ══════════════════════════════════════════════════════════

    /// @notice Swap ERC-20 tokens with fee collection
    /// [MEDIUM-001] Balance-delta pattern for fee-on-transfer tokens
    /// [HIGH-001] Post-swap balance verification
    function swapTokenWithFee(
        address token,
        uint256 totalAmount,
        address router,
        bytes calldata routerData
    ) external nonReentrant whenNotPaused {
        if (totalAmount == 0) revert ZeroAmount();
        if (totalAmount < MIN_SWAP_AMOUNT) revert AmountTooSmall();

        // [CRITICAL-001] Validate function selector
        bytes4 selector = bytes4(routerData[:4]);
        if (!allowedSelectors[router][selector]) {
            revert SelectorNotWhitelisted(router, selector);
        }

        // [MEDIUM-001] Balance-delta: handle fee-on-transfer tokens
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalAmount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;

        // Calculate fee on ACTUALLY received amount (not input amount)
        uint256 fee = (received * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netAmount = received - fee;

        // Send fee to recipient
        IERC20(token).safeTransfer(feeRecipient, fee);

        // [HIGH-001] Record balance before router call
        uint256 tokenBalBefore = IERC20(token).balanceOf(address(this));

        // Approve and execute router swap
        IERC20(token).forceApprove(router, netAmount);
        (bool ok, bytes memory result) = router.call(routerData);
        if (!ok) revert SwapFailed(result);

        // [HIGH-001] Verify router didn't take more than approved
        uint256 tokenBalAfter = IERC20(token).balanceOf(address(this));
        uint256 spent = tokenBalBefore - tokenBalAfter;
        if (spent > netAmount + 1) revert RouterTookTooMuch(netAmount, spent);

        // Always revoke approval after swap
        IERC20(token).forceApprove(router, 0);

        // [MEDIUM-002] Refund remaining using actual balance (rebasing token safe)
        uint256 tokenBalance = IERC20(token).balanceOf(address(this));
        if (tokenBalance > 0) {
            IERC20(token).safeTransfer(msg.sender, tokenBalance);
        }

        // Refund any ETH received from swap (e.g., ETH output via WETH unwrap)
        uint256 ethBalance = address(this).balance;
        if (ethBalance > 0) {
            (bool refundOk, ) = msg.sender.call{value: ethBalance}("");
            if (!refundOk) revert RefundFailed();
        }

        emit SwapWithFee(msg.sender, router, token, totalAmount, fee);
    }

    // ══════════════════════════════════════════════════════════
    //  ADMIN: SWEEP WITH TIMELOCK [HIGH-002]
    // ══════════════════════════════════════════════════════════

    /// @notice Request a sweep (48h delay)
    function requestSweep(address token) external onlyAdmin {
        bytes32 sweepId = keccak256(abi.encode(token, block.timestamp));
        uint256 executeAfter = block.timestamp + TIMELOCK_DELAY;
        pendingSweeps[sweepId] = PendingSweep({
            token: token,
            recipient: feeRecipient,
            executeAfter: executeAfter,
            exists: true
        });
        emit SweepRequested(sweepId, token, feeRecipient, executeAfter);
    }

    /// @notice Execute a sweep after timelock expires
    function executeSweep(bytes32 sweepId) external onlyAdmin {
        PendingSweep storage s = pendingSweeps[sweepId];
        if (!s.exists) revert SweepNotFound();
        if (block.timestamp < s.executeAfter) revert SweepNotReady();

        address token = s.token;
        address recipient = s.recipient;
        delete pendingSweeps[sweepId];

        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            (bool ok, ) = recipient.call{value: amount}("");
            require(ok, "ETH sweep failed");
        } else {
            amount = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransfer(recipient, amount);
        }

        emit SweepExecuted(sweepId, token, recipient, amount);
    }

    /// @notice Cancel a pending sweep
    function cancelSweep(bytes32 sweepId) external onlyAdmin {
        if (!pendingSweeps[sweepId].exists) revert SweepNotFound();
        delete pendingSweeps[sweepId];
        emit SweepCancelled(sweepId);
    }

    // ══════════════════════════════════════════════════════════
    //  ADMIN: PAUSE [LOW-001]
    // ══════════════════════════════════════════════════════════

    function pause() external onlyAdmin {
        paused = true;
        emit PauseToggled(true);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit PauseToggled(false);
    }

    // ══════════════════════════════════════════════════════════
    //  ADMIN: TRANSFER
    // ══════════════════════════════════════════════════════════

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // ══════════════════════════════════════════════════════════
    //  FALLBACK
    // ══════════════════════════════════════════════════════════

    receive() external payable {}
}
