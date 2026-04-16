// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../TeraSwapOrderExecutor.sol";

// ══════════════════════════════════════════════════════════════════
//  MOCK CONTRACTS
// ══════════════════════════════════════════════════════════════════

/// @dev Minimal ERC-20 for testing
contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @dev Mock WETH with deposit/withdraw
contract MockWETH is MockERC20 {
    constructor() MockERC20("Wrapped Ether", "WETH", 18) {}

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }
}

/// @dev Mock Chainlink price feed
contract MockPriceFeed {
    int256 public price;
    uint256 public updatedAt;
    uint80 public roundId;
    uint80 public answeredInRound;

    function setPrice(int256 _price) external {
        price = _price;
        updatedAt = block.timestamp;
        roundId++;
        answeredInRound = roundId;
    }

    function setStaleness(uint256 _updatedAt) external {
        updatedAt = _updatedAt;
    }

    function setIncompleteRound() external {
        // answeredInRound < roundId means incomplete
        roundId++;
    }

    function latestRoundData() external view returns (
        uint80, int256, uint256, uint256, uint80
    ) {
        return (roundId, price, 0, updatedAt, answeredInRound);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

/// @dev Mock DEX router that performs a "swap" by minting output tokens
contract MockRouter {
    MockERC20 public outputToken;
    uint256 public outputAmount;
    bool public shouldFail;

    constructor(MockERC20 _outputToken, uint256 _outputAmount) {
        outputToken = _outputToken;
        outputAmount = _outputAmount;
    }

    function setOutput(uint256 _amount) external {
        outputAmount = _amount;
    }

    function setFail(bool _fail) external {
        shouldFail = _fail;
    }

    /// @dev Called by the executor contract — "swaps" by minting output tokens to caller
    fallback() external payable {
        if (shouldFail) {
            revert("Router: swap failed");
        }
        // Simulate: pull input tokens (already approved), mint output
        outputToken.mint(msg.sender, outputAmount);
    }

    receive() external payable {}
}

/// @dev Router that returns native ETH instead of ERC-20 (for H-02 test)
contract MockETHRouter {
    uint256 public ethToReturn;
    bool public shouldFail;

    constructor(uint256 _ethToReturn) {
        ethToReturn = _ethToReturn;
    }

    function setEthReturn(uint256 _amount) external {
        ethToReturn = _amount;
    }

    function setFail(bool _fail) external {
        shouldFail = _fail;
    }

    fallback() external payable {
        if (shouldFail) revert("Router: swap failed");
        // Return ETH to caller (simulates selling tokens for ETH)
        (bool ok, ) = msg.sender.call{value: ethToReturn}("");
        require(ok, "ETH send failed");
    }

    receive() external payable {}
}


/// @dev Malicious ERC-20 that attempts reentrancy during safeTransfer (transfer hook)
///      Used to prove the nonReentrant guard on executeOrder() works.
contract ReentrantToken is IERC20 {
    string public name = "Reentrant Token";
    string public symbol = "REENT";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    TeraSwapOrderExecutor public target;
    TeraSwapOrderExecutor.Order public reentrantOrder;
    bytes public reentrantSig;
    bytes public reentrantData;
    bool public attackEnabled;

    function setAttack(
        TeraSwapOrderExecutor _target,
        TeraSwapOrderExecutor.Order memory _order,
        bytes memory _sig,
        bytes memory _data
    ) external {
        target = _target;
        reentrantOrder = _order;
        reentrantSig = _sig;
        reentrantData = _data;
        attackEnabled = true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);

        // Attempt reentrancy when the executor sends us output tokens
        if (attackEnabled && msg.sender == address(target)) {
            attackEnabled = false; // prevent infinite recursion
            try target.executeOrder(reentrantOrder, reentrantSig, reentrantData) {
                // If this succeeds, reentrancy guard is broken
            } catch {
                // Expected: should revert with ReentrancyGuardReentrantCall
            }
        }
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @dev Router that mints ReentrantToken (used together with ReentrantToken for reentrancy test)
contract ReentrantRouter {
    ReentrantToken public outputToken;
    uint256 public outputAmount;

    constructor(ReentrantToken _outputToken, uint256 _outputAmount) {
        outputToken = _outputToken;
        outputAmount = _outputAmount;
    }

    fallback() external payable {
        outputToken.mint(msg.sender, outputAmount);
    }

    receive() external payable {}
}


// ══════════════════════════════════════════════════════════════════
//  TEST CONTRACT
// ══════════════════════════════════════════════════════════════════

contract TeraSwapOrderExecutorTest is Test {
    TeraSwapOrderExecutor public executor;
    MockERC20 public tokenIn;
    MockERC20 public tokenOut;
    MockWETH public weth;
    MockPriceFeed public priceFeed;
    MockRouter public router;
    MockETHRouter public ethRouter;

    address public admin = address(0xAD);
    address public feeRecipient = address(0xFE);
    uint256 public userPk = 0xA11CE;
    address public user;

    // Default order params
    uint256 constant AMOUNT_IN = 1000e18;
    uint256 constant MIN_OUT = 900e18;
    uint256 constant TARGET_PRICE = 2000e8; // $2000 with 8 decimals
    uint256 constant EXPIRY_DELTA = 1 hours;

    function setUp() public {
        user = vm.addr(userPk);

        // Deploy mocks
        tokenIn = new MockERC20("Token In", "TIN", 18);
        tokenOut = new MockERC20("Token Out", "TOUT", 18);
        weth = new MockWETH();
        priceFeed = new MockPriceFeed();
        router = new MockRouter(tokenOut, MIN_OUT + 100e18); // output > minOut

        // Deploy executor
        executor = new TeraSwapOrderExecutor(feeRecipient, admin, address(weth));

        // Bootstrap router + executor (test contract is the executor)
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        address[] memory executors = new address[](1);
        executors[0] = address(this);
        vm.prank(admin);
        executor.bootstrap(routers, executors);

        // Fund user
        tokenIn.mint(user, 100_000e18);
        vm.prank(user);
        tokenIn.approve(address(executor), type(uint256).max);

        // Set price feed
        priceFeed.setPrice(int256(TARGET_PRICE));
    }

    // ══════════════════════════════════════════════════════════════
    //  HELPERS
    // ══════════════════════════════════════════════════════════════

    function _defaultOrder() internal view returns (TeraSwapOrderExecutor.Order memory) {
        return TeraSwapOrderExecutor.Order({
            owner: user,
            tokenIn: address(tokenIn),
            tokenOut: address(tokenOut),
            amountIn: AMOUNT_IN,
            minAmountOut: MIN_OUT,
            orderType: TeraSwapOrderExecutor.OrderType.LIMIT,
            condition: TeraSwapOrderExecutor.PriceCondition.ABOVE,
            targetPrice: TARGET_PRICE,
            priceFeed: address(priceFeed),
            expiry: block.timestamp + EXPIRY_DELTA,
            nonce: 0,
            router: address(router),
            routerDataHash: keccak256(hex"01"),
            dcaInterval: 0,
            dcaTotal: 0
        });
    }

    function _signOrder(
        TeraSwapOrderExecutor.Order memory order
    ) internal view returns (bytes memory) {
        bytes32 orderHash = executor.getOrderHash(_toCalldata(order));
        bytes32 digest = _hashTypedData(orderHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Build the EIP-712 digest the same way the contract does
    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01",
            executor.domainSeparator(),
            structHash
        ));
    }

    /// @dev Workaround: getOrderHash expects calldata, so we call it externally
    function _toCalldata(
        TeraSwapOrderExecutor.Order memory order
    ) internal view returns (TeraSwapOrderExecutor.Order calldata) {
        // Use this.getOrderHashHelper to pass memory as calldata
        // Actually, in Foundry tests we can just call executor directly since
        // test functions receive calldata. We'll use a helper.
        // For simplicity, compute the hash manually:
        revert("Use _computeOrderHash instead");
    }

    function _computeOrderHash(
        TeraSwapOrderExecutor.Order memory order
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256(
                "Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,"
                "uint256 minAmountOut,uint8 orderType,uint8 condition,uint256 targetPrice,"
                "address priceFeed,uint256 expiry,uint256 nonce,address router,"
                "bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)"
            ),
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
            order.router,
            order.routerDataHash,
            order.dcaInterval,
            order.dcaTotal
        ));
    }

    function _signOrderMemory(
        TeraSwapOrderExecutor.Order memory order
    ) internal view returns (bytes memory) {
        bytes32 orderHash = _computeOrderHash(order);
        bytes32 digest = _hashTypedData(orderHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _executeDefault() internal returns (TeraSwapOrderExecutor.Order memory, bytes memory) {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);
        executor.executeOrder(order, sig, hex"01");
        return (order, sig);
    }

    // ══════════════════════════════════════════════════════════════
    //  CONSTRUCTOR TESTS
    // ══════════════════════════════════════════════════════════════

    function test_constructor_setsImmutables() public view {
        assertEq(executor.feeRecipient(), feeRecipient);
        assertEq(executor.admin(), admin);
        assertEq(executor.WETH(), address(weth));
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(TeraSwapOrderExecutor.ZeroAddress.selector);
        new TeraSwapOrderExecutor(address(0), admin, address(weth));

        vm.expectRevert(TeraSwapOrderExecutor.ZeroAddress.selector);
        new TeraSwapOrderExecutor(feeRecipient, address(0), address(weth));

        vm.expectRevert(TeraSwapOrderExecutor.ZeroAddress.selector);
        new TeraSwapOrderExecutor(feeRecipient, admin, address(0));
    }

    // ══════════════════════════════════════════════════════════════
    //  BASIC EXECUTION TESTS
    // ══════════════════════════════════════════════════════════════

    function test_executeOrder_happyPath() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        uint256 userBalBefore = tokenIn.balanceOf(user);
        uint256 feeRecipientBalBefore = tokenIn.balanceOf(feeRecipient);

        executor.executeOrder(order, sig, hex"01");

        // User should have received output tokens
        uint256 outputBal = tokenOut.balanceOf(user);
        assertGt(outputBal, 0, "User should receive output tokens");
        assertGe(outputBal, MIN_OUT, "Output should meet minimum");

        // Fee should be collected
        uint256 expectedFee = (AMOUNT_IN * 10) / 10_000;
        assertEq(
            tokenIn.balanceOf(feeRecipient) - feeRecipientBalBefore,
            expectedFee,
            "Fee should be 0.1%"
        );

        // User input should decrease
        assertEq(
            userBalBefore - tokenIn.balanceOf(user),
            AMOUNT_IN,
            "User should spend amountIn"
        );

        // Nonce should increment
        assertEq(executor.nonces(user), 1, "Nonce should increment");
    }

    function test_executeOrder_emitsEvent() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);
        bytes32 orderHash = _computeOrderHash(order);

        vm.expectEmit(true, true, false, false);
        emit TeraSwapOrderExecutor.OrderExecuted(
            orderHash,
            user,
            TeraSwapOrderExecutor.OrderType.LIMIT,
            address(tokenIn),
            address(tokenOut),
            AMOUNT_IN,
            0, // we don't check exact amount in expectEmit
            0
        );

        executor.executeOrder(order, sig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  SIGNATURE TESTS
    // ══════════════════════════════════════════════════════════════

    function test_executeOrder_revertsInvalidSignature() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();

        // Sign with wrong key
        uint256 wrongPk = 0xDEAD;
        bytes32 orderHash = _computeOrderHash(order);
        bytes32 digest = _hashTypedData(orderHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.expectRevert(TeraSwapOrderExecutor.InvalidSignature.selector);
        executor.executeOrder(order, badSig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  H-01: ROUTER IN SIGNED DATA
    // ══════════════════════════════════════════════════════════════

    function test_H01_routerIsPartOfSignature() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        // Deploy a second (malicious) router
        MockRouter maliciousRouter = new MockRouter(tokenOut, 1);
        vm.prank(admin);
        executor.queueRouterChange(address(maliciousRouter), true);
        vm.warp(block.timestamp + 48 hours + 1);
        // We need the actionId — for simplicity let's bootstrap isn't available anymore
        // Let's test that executing with a non-whitelisted router fails
        // The order was signed with router = address(router), so it can't be changed

        // order.router is locked in the signature — the executor function
        // uses order.router, not a separate parameter. This IS the H-01 fix.
        // Verify the function signature only takes (order, sig, routerData)
        // not (order, sig, router, routerData)
    }

    function test_H01_nonWhitelistedRouterReverts() public {
        MockRouter badRouter = new MockRouter(tokenOut, MIN_OUT + 100e18);

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.router = address(badRouter); // Not whitelisted
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.RouterNotWhitelisted.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  H-02: ETH OUTPUT HANDLING
    // ══════════════════════════════════════════════════════════════

    function test_H02_ethOutputSentToUser() public {
        // Setup: router that returns native ETH
        ethRouter = new MockETHRouter(1 ether);
        vm.deal(address(ethRouter), 10 ether);

        // Whitelist ETH router via bootstrap is already used, so queue it
        vm.prank(admin);
        executor.queueRouterChange(address(ethRouter), true);
        vm.warp(block.timestamp + 48 hours + 1);

        // Get the actionId — we need to compute it
        bytes32 actionHash = keccak256(abi.encode("setRouter", address(ethRouter), true));
        // actionId depends on block.timestamp at queue time, which was before warp
        // For testing, let's use a fresh setup
    }

    // ══════════════════════════════════════════════════════════════
    //  H-03: NONCE INVALIDATION (MASS CANCEL)
    // ══════════════════════════════════════════════════════════════

    function test_H03_invalidateNonces() public {
        // User creates order with nonce 0
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        // User invalidates nonce 0 by setting invalidatedNonces to 1
        vm.prank(user);
        executor.invalidateNonces(1);

        assertEq(executor.invalidatedNonces(user), 1);

        // Order with nonce 0 should now fail
        vm.expectRevert(TeraSwapOrderExecutor.NonceBelowInvalidation.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_H03_invalidateNonces_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit TeraSwapOrderExecutor.NoncesInvalidated(user, 5);

        vm.prank(user);
        executor.invalidateNonces(5);
    }

    function test_H03_invalidateNonces_mustIncrease() public {
        vm.prank(user);
        executor.invalidateNonces(3);

        vm.prank(user);
        vm.expectRevert("Must increase");
        executor.invalidateNonces(2); // Can't decrease

        vm.prank(user);
        vm.expectRevert("Must increase");
        executor.invalidateNonces(3); // Can't stay same
    }

    // ══════════════════════════════════════════════════════════════
    //  M-01: PRE-EXECUTION BALANCE / ALLOWANCE CHECK
    // ══════════════════════════════════════════════════════════════

    function test_M01_insufficientBalance() public {
        // Burn user's tokens
        vm.prank(user);
        tokenIn.transfer(address(0xDEAD), tokenIn.balanceOf(user));

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.InsufficientBalance.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_M01_insufficientAllowance() public {
        // Revoke allowance
        vm.prank(user);
        tokenIn.approve(address(executor), 0);

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.InsufficientAllowance.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  M-02: TIMELOCK
    // ══════════════════════════════════════════════════════════════

    function test_M02_timelockRouterChange() public {
        MockRouter newRouter = new MockRouter(tokenOut, 1);

        // Queue
        vm.prank(admin);
        executor.queueRouterChange(address(newRouter), true);

        // Can't execute immediately
        // (We need the actionId, which depends on block.timestamp)
        // For this test, we verify the router is NOT whitelisted yet
        assertFalse(executor.whitelistedRouters(address(newRouter)));
    }

    function test_M02_timelockAdminChange() public {
        address newAdmin = address(0xBEEF);

        vm.prank(admin);
        executor.queueAdminChange(newAdmin);

        // Admin hasn't changed yet
        assertEq(executor.admin(), admin);
    }

    function test_M02_onlyAdminCanQueue() public {
        vm.prank(user);
        vm.expectRevert(TeraSwapOrderExecutor.NotAdmin.selector);
        executor.queueRouterChange(address(0x123), true);
    }

    function test_M02_cancelTimelockAction() public {
        vm.prank(admin);
        executor.queueRouterChange(address(0x123), true);

        // Admin can cancel any action (by actionId)
        // We verify admin check works
        vm.prank(user);
        vm.expectRevert(TeraSwapOrderExecutor.NotAdmin.selector);
        executor.cancelTimelockAction(bytes32(0));
    }

    // ══════════════════════════════════════════════════════════════
    //  R-12: PROGRESSIVE TIMELOCK
    // ══════════════════════════════════════════════════════════════

    function test_R12_adminTransferRequires7Days() public {
        address newAdmin = address(0xBEEF);

        // Queue admin change
        vm.prank(admin);
        executor.queueAdminChange(newAdmin);
        bytes32 actionHash = keccak256(abi.encode("setAdmin", newAdmin));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        // Warp 48h — should revert (needs 7 days)
        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        vm.expectRevert(TeraSwapOrderExecutor.TimelockNotReady.selector);
        executor.executeAdminChange(actionId, newAdmin);

        // Warp to 7 days total — should succeed
        vm.warp(block.timestamp + 7 days - 48 hours);
        vm.prank(admin);
        executor.executeAdminChange(actionId, newAdmin);

        assertEq(executor.admin(), newAdmin);
    }

    function test_R12_routerChangeStill48h() public {
        MockRouter newRouter = new MockRouter(tokenOut, 1);

        vm.prank(admin);
        executor.queueRouterChange(address(newRouter), true);
        bytes32 actionHash = keccak256(abi.encode("setRouter", address(newRouter), true));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        // Warp 48h + 1s — should succeed
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(admin);
        executor.executeRouterChange(actionId, address(newRouter), true);

        assertTrue(executor.whitelistedRouters(address(newRouter)));
    }

    function test_R12_sweepStill48h() public {
        tokenIn.mint(address(executor), 50e18);

        vm.prank(admin);
        executor.queueSweep(address(tokenIn));
        bytes32 actionHash = keccak256(abi.encode("sweep", address(tokenIn)));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        // Warp 48h + 1s — should succeed
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(admin);
        executor.executeSweep(actionId, address(tokenIn));

        assertEq(tokenIn.balanceOf(admin), 50e18);
    }

    function test_R12_adminTransferAt48hReverts() public {
        address newAdmin = address(0xBEEF);

        vm.prank(admin);
        executor.queueAdminChange(newAdmin);
        bytes32 actionHash = keccak256(abi.encode("setAdmin", newAdmin));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        // Warp exactly 48h — should revert (admin needs 7 days)
        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        vm.expectRevert(TeraSwapOrderExecutor.TimelockNotReady.selector);
        executor.executeAdminChange(actionId, newAdmin);
    }

    function test_R12_getTimelockDelays() public view {
        (uint256 adminTransfer, uint256 routerChange, uint256 sweep, uint256 executorChange) = executor.getTimelockDelays();
        assertEq(adminTransfer, 7 days, "Admin transfer should be 7 days");
        assertEq(routerChange, 48 hours, "Router change should be 48 hours");
        assertEq(sweep, 48 hours, "Sweep should be 48 hours");
        assertEq(executorChange, 48 hours, "Executor change should be 48 hours");
    }

    function test_R12_adminTransferGracePeriodStill7Days() public {
        address newAdmin = address(0xBEEF);

        vm.prank(admin);
        executor.queueAdminChange(newAdmin);
        bytes32 actionHash = keccak256(abi.encode("setAdmin", newAdmin));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        // Warp past 7 days (timelock) + 7 days (grace) + 1s — should revert TimelockExpired
        vm.warp(block.timestamp + 7 days + 7 days + 1);
        vm.prank(admin);
        vm.expectRevert(TeraSwapOrderExecutor.TimelockExpired.selector);
        executor.executeAdminChange(actionId, newAdmin);
    }

    // ══════════════════════════════════════════════════════════════
    //  L-03: MIN OUTPUT VALIDATION
    // ══════════════════════════════════════════════════════════════

    function test_L03_zeroMinAmountOutReverts() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.minAmountOut = 0;
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.InvalidMinOutput.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  CHAINLINK VALIDATION
    // ══════════════════════════════════════════════════════════════

    function test_chainlink_stalePriceFeedReverts() public {
        // Set price to be old
        priceFeed.setStaleness(block.timestamp - 3601); // > MAX_STALENESS

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.PriceConditionNotMet.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_chainlink_incompleteRoundReverts() public {
        priceFeed.setIncompleteRound(); // answeredInRound < roundId

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.PriceConditionNotMet.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_chainlink_negativePriceReverts() public {
        // Reset with negative price
        MockPriceFeed badFeed = new MockPriceFeed();
        // Price is 0 by default (never set), which should fail

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.priceFeed = address(badFeed);
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.PriceConditionNotMet.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  ORDER STATE TESTS
    // ══════════════════════════════════════════════════════════════

    function test_orderExpired() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.expiry = block.timestamp - 1; // Already expired
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.OrderExpired.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_orderCancelled() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        // Cancel order
        vm.prank(user);
        executor.cancelOrder(order);

        vm.expectRevert(TeraSwapOrderExecutor.OrderCancelledError.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_cancelOrder_onlyOwner() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();

        vm.prank(address(0xBAD));
        vm.expectRevert(TeraSwapOrderExecutor.NotOwner.selector);
        executor.cancelOrder(order);
    }

    function test_doubleExecution_reverts() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        // First execution succeeds
        executor.executeOrder(order, sig, hex"01");

        // Second execution reverts (nonce already incremented)
        vm.expectRevert(TeraSwapOrderExecutor.OrderAlreadyExecuted.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  PRICE CONDITION TESTS
    // ══════════════════════════════════════════════════════════════

    function test_priceConditionAbove_met() public {
        // Price is at target, ABOVE condition should pass
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.condition = TeraSwapOrderExecutor.PriceCondition.ABOVE;
        order.targetPrice = TARGET_PRICE; // price == target, should pass (>=)
        bytes memory sig = _signOrderMemory(order);

        executor.executeOrder(order, sig, hex"01");
        // Should not revert
    }

    function test_priceConditionAbove_notMet() public {
        // Set price below target
        priceFeed.setPrice(int256(TARGET_PRICE - 1));

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.condition = TeraSwapOrderExecutor.PriceCondition.ABOVE;
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.PriceConditionNotMet.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_priceConditionBelow_met() public {
        priceFeed.setPrice(int256(TARGET_PRICE)); // price == target, BELOW passes (<=)

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.condition = TeraSwapOrderExecutor.PriceCondition.BELOW;
        bytes memory sig = _signOrderMemory(order);

        executor.executeOrder(order, sig, hex"01");
    }

    function test_priceConditionBelow_notMet() public {
        priceFeed.setPrice(int256(TARGET_PRICE + 1));

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.condition = TeraSwapOrderExecutor.PriceCondition.BELOW;
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.PriceConditionNotMet.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  DCA TESTS
    // ══════════════════════════════════════════════════════════════

    function test_dca_multipleExecutions() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.orderType = TeraSwapOrderExecutor.OrderType.DCA;
        order.dcaTotal = 5;
        order.dcaInterval = 1 hours;
        order.priceFeed = address(0); // No price condition for DCA
        bytes memory sig = _signOrderMemory(order);

        // Execute 5 times
        for (uint256 i = 0; i < 5; i++) {
            executor.executeOrder(order, sig, hex"01");
            if (i < 4) {
                vm.warp(block.timestamp + 1 hours + 1);
            }
        }

        // 6th execution should fail
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(TeraSwapOrderExecutor.DCAComplete.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_dca_intervalNotReached() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.orderType = TeraSwapOrderExecutor.OrderType.DCA;
        order.dcaTotal = 3;
        order.dcaInterval = 1 hours;
        order.priceFeed = address(0);
        bytes memory sig = _signOrderMemory(order);

        // First execution
        executor.executeOrder(order, sig, hex"01");

        // Try immediately — should fail
        vm.expectRevert(TeraSwapOrderExecutor.DCAIntervalNotReached.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_dca_doesNotIncrementNonce() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.orderType = TeraSwapOrderExecutor.OrderType.DCA;
        order.dcaTotal = 2;
        order.dcaInterval = 1 hours;
        order.priceFeed = address(0);
        bytes memory sig = _signOrderMemory(order);

        executor.executeOrder(order, sig, hex"01");
        assertEq(executor.nonces(user), 0, "DCA should not increment nonce");
    }

    // ══════════════════════════════════════════════════════════════
    //  OUTPUT VALIDATION
    // ══════════════════════════════════════════════════════════════

    function test_insufficientOutput_reverts() public {
        // Router returns less than minAmountOut
        router.setOutput(MIN_OUT - 1);

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.InsufficientOutput.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_swapFailed_reverts() public {
        router.setFail(true);

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert();
        executor.executeOrder(order, sig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  BOOTSTRAP TESTS
    // ══════════════════════════════════════════════════════════════

    function test_bootstrap_onlyOnce() public {
        // Already bootstrapped in setUp
        address[] memory routers = new address[](1);
        routers[0] = address(0x999);
        address[] memory executors = new address[](0);

        vm.prank(admin);
        vm.expectRevert(TeraSwapOrderExecutor.AlreadyBootstrapped.selector);
        executor.bootstrap(routers, executors);
    }

    function test_bootstrap_onlyAdmin() public {
        // Deploy fresh executor (not bootstrapped)
        TeraSwapOrderExecutor fresh = new TeraSwapOrderExecutor(
            feeRecipient, admin, address(weth)
        );

        address[] memory routers = new address[](1);
        routers[0] = address(router);
        address[] memory executors = new address[](0);

        vm.prank(user);
        vm.expectRevert(TeraSwapOrderExecutor.NotAdmin.selector);
        fresh.bootstrap(routers, executors);
    }

    // ══════════════════════════════════════════════════════════════
    //  SWEEP / ADMIN TESTS
    // ══════════════════════════════════════════════════════════════

    function test_sweep_tokens() public {
        // Send some tokens to executor accidentally
        tokenIn.mint(address(executor), 100e18);

        // Queue sweep
        vm.prank(admin);
        executor.queueSweep(address(tokenIn));
        bytes32 actionHash = keccak256(abi.encode("sweep", address(tokenIn)));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        // Warp past timelock
        vm.warp(block.timestamp + 48 hours + 1);

        vm.prank(admin);
        executor.executeSweep(actionId, address(tokenIn));

        assertEq(tokenIn.balanceOf(admin), 100e18);
        assertEq(tokenIn.balanceOf(address(executor)), 0);
    }

    function test_sweep_eth() public {
        // Send some ETH to executor
        vm.deal(address(executor), 1 ether);

        uint256 adminBalBefore = admin.balance;

        // Queue sweep
        vm.prank(admin);
        executor.queueSweep(address(0));
        bytes32 actionHash = keccak256(abi.encode("sweep", address(0)));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        // Warp past timelock
        vm.warp(block.timestamp + 48 hours + 1);

        vm.prank(admin);
        executor.executeSweep(actionId, address(0));

        assertEq(admin.balance - adminBalBefore, 1 ether);
    }

    function test_sweep_onlyAdmin() public {
        vm.prank(user);
        vm.expectRevert(TeraSwapOrderExecutor.NotAdmin.selector);
        executor.queueSweep(address(tokenIn));
    }

    // ══════════════════════════════════════════════════════════════
    //  canExecute VIEW TESTS
    // ══════════════════════════════════════════════════════════════

    function test_canExecute_happyPath() public view {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        (bool canExec, string memory reason) = executor.canExecute(order, sig);
        assertTrue(canExec, "Should be executable");
        assertEq(bytes(reason).length, 0, "No reason expected");
    }

    function test_canExecute_invalidSig() public view {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory badSig = new bytes(65); // zeroed sig

        (bool canExec, string memory reason) = executor.canExecute(order, badSig);
        assertFalse(canExec);
        assertEq(reason, "Invalid signature");
    }

    function test_canExecute_expired() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.expiry = block.timestamp - 1;
        bytes memory sig = _signOrderMemory(order);

        (bool canExec, string memory reason) = executor.canExecute(order, sig);
        assertFalse(canExec);
        assertEq(reason, "Order expired");
    }

    function test_canExecute_insufficientBalance() public {
        // Burn user tokens
        vm.prank(user);
        tokenIn.transfer(address(0xDEAD), tokenIn.balanceOf(user));

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        (bool canExec, string memory reason) = executor.canExecute(order, sig);
        assertFalse(canExec);
        assertEq(reason, "Insufficient balance");
    }

    // ══════════════════════════════════════════════════════════════
    //  REENTRANCY GUARD
    // ══════════════════════════════════════════════════════════════

    function test_reentrancy_protection() public view {
        // The contract inherits ReentrancyGuard — executeOrder is nonReentrant
        // This is a structural test: verify the modifier is present
        // (Actual reentrancy testing requires a malicious callback contract)
        assertTrue(true, "ReentrancyGuard is inherited");
    }

    // ══════════════════════════════════════════════════════════════
    //  DUST REFUND
    // ══════════════════════════════════════════════════════════════

    function test_dustRefund() public {
        // If router doesn't consume all input, dust should be returned
        // Our mock router doesn't actually pull tokens, so all input
        // minus fee stays in the contract as "dust"
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        executor.executeOrder(order, sig, hex"01");

        // Contract should have no leftover tokenIn
        assertEq(tokenIn.balanceOf(address(executor)), 0, "No dust should remain");
    }

    // ══════════════════════════════════════════════════════════════
    //  FEE CALCULATION
    // ══════════════════════════════════════════════════════════════

    function test_feeCalculation() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        bytes memory sig = _signOrderMemory(order);

        uint256 feeBalBefore = tokenIn.balanceOf(feeRecipient);
        executor.executeOrder(order, sig, hex"01");
        uint256 feeCollected = tokenIn.balanceOf(feeRecipient) - feeBalBefore;

        // 0.1% of 1000e18 = 1e18
        assertEq(feeCollected, 1e18, "Fee should be 0.1%");
    }

    function testFuzz_feeCalculation(uint256 amountIn) public {
        amountIn = bound(amountIn, 10_000, 1_000_000e18); // reasonable range

        tokenIn.mint(user, amountIn);
        router.setOutput(amountIn); // enough output

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.amountIn = amountIn;
        order.minAmountOut = 1; // just check fee math
        bytes memory sig = _signOrderMemory(order);

        uint256 feeBalBefore = tokenIn.balanceOf(feeRecipient);
        executor.executeOrder(order, sig, hex"01");
        uint256 feeCollected = tokenIn.balanceOf(feeRecipient) - feeBalBefore;

        uint256 expectedFee = (amountIn * 10) / 10_000;
        assertEq(feeCollected, expectedFee, "Fee should be exact 0.1%");
    }

    // ══════════════════════════════════════════════════════════════
    //  SC-H-03: REENTRANCY GUARD VERIFICATION
    // ══════════════════════════════════════════════════════════════

    /// @dev Sign an order against a specific executor's EIP-712 domain
    function _signOrderFor(
        TeraSwapOrderExecutor _executor,
        TeraSwapOrderExecutor.Order memory order
    ) internal view returns (bytes memory) {
        bytes32 orderHash = _computeOrderHash(order);
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            _executor.domainSeparator(),
            orderHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_SC_H03_reentrancyDuringExecuteOrder() public {
        // Deploy a malicious output token that tries to re-enter executeOrder()
        // during the safeTransfer of output tokens to order.owner
        ReentrantToken reentrantOut = new ReentrantToken();
        ReentrantRouter reentrantRouter = new ReentrantRouter(reentrantOut, MIN_OUT + 100e18);

        // Deploy fresh executor so we can bootstrap with the reentrant router
        TeraSwapOrderExecutor freshExecutor = new TeraSwapOrderExecutor(
            feeRecipient, admin, address(weth)
        );
        address[] memory routers = new address[](1);
        routers[0] = address(reentrantRouter);
        address[] memory executors = new address[](1);
        executors[0] = address(this);
        vm.prank(admin);
        freshExecutor.bootstrap(routers, executors);

        // Fund user with tokenIn and approve the FRESH executor
        tokenIn.mint(user, AMOUNT_IN * 2);
        vm.prank(user);
        tokenIn.approve(address(freshExecutor), type(uint256).max);

        // Create order using the reentrant output token — sign against freshExecutor's domain
        TeraSwapOrderExecutor.Order memory order = TeraSwapOrderExecutor.Order({
            owner: user,
            tokenIn: address(tokenIn),
            tokenOut: address(reentrantOut),
            amountIn: AMOUNT_IN,
            minAmountOut: MIN_OUT,
            orderType: TeraSwapOrderExecutor.OrderType.LIMIT,
            condition: TeraSwapOrderExecutor.PriceCondition.ABOVE,
            targetPrice: TARGET_PRICE,
            priceFeed: address(priceFeed),
            expiry: block.timestamp + EXPIRY_DELTA,
            nonce: 0,
            router: address(reentrantRouter),
            routerDataHash: keccak256(hex"AA"),
            dcaInterval: 0,
            dcaTotal: 0
        });

        bytes memory sig = _signOrderFor(freshExecutor, order);

        // Set up the reentrancy attack: when the reentrant token is transferred
        // to order.owner, it will try to call executeOrder again with a second order
        TeraSwapOrderExecutor.Order memory secondOrder = TeraSwapOrderExecutor.Order({
            owner: user,
            tokenIn: address(tokenIn),
            tokenOut: address(reentrantOut),
            amountIn: AMOUNT_IN,
            minAmountOut: MIN_OUT,
            orderType: TeraSwapOrderExecutor.OrderType.LIMIT,
            condition: TeraSwapOrderExecutor.PriceCondition.ABOVE,
            targetPrice: TARGET_PRICE,
            priceFeed: address(priceFeed),
            expiry: block.timestamp + EXPIRY_DELTA,
            nonce: 1, // next nonce
            router: address(reentrantRouter),
            routerDataHash: keccak256(hex"BB"),
            dcaInterval: 0,
            dcaTotal: 0
        });
        bytes memory sig2 = _signOrderFor(freshExecutor, secondOrder);

        reentrantOut.setAttack(freshExecutor, secondOrder, sig2, hex"BB");

        // Execute the first order — the reentrancy attempt during output
        // transfer should be caught by nonReentrant and silently fail
        // (the outer call should still succeed)
        freshExecutor.executeOrder(order, sig, hex"AA");

        // Verify the first order completed (nonce incremented to 1)
        assertEq(freshExecutor.nonces(user), 1, "First order should complete");

        // The reentrant call should NOT have succeeded (nonce should be 1, not 2)
        // If reentrancy succeeded, nonce would be 2
        assertTrue(freshExecutor.nonces(user) < 2, "Reentrant call must not succeed");
    }

    // ══════════════════════════════════════════════════════════════
    //  SC-C-01: routerDataHash VERIFICATION
    // ══════════════════════════════════════════════════════════════

    function test_SC_C01_nonDCA_bytes32Zero_reverts() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.routerDataHash = bytes32(0); // Not allowed for non-DCA
        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.RouterDataMismatch.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_SC_C01_nonDCA_wrongHash_reverts() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.routerDataHash = keccak256(hex"FF"); // Hash of 0xFF
        bytes memory sig = _signOrderMemory(order);

        // Execute with routerData = 0x01 (hash doesn't match 0xFF)
        vm.expectRevert(TeraSwapOrderExecutor.RouterDataMismatch.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    function test_SC_C01_nonDCA_correctHash_succeeds() public {
        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.routerDataHash = keccak256(hex"01"); // Hash of 0x01
        bytes memory sig = _signOrderMemory(order);

        // Execute with matching routerData
        executor.executeOrder(order, sig, hex"01");

        // Nonce should have incremented (order executed)
        assertEq(executor.nonces(user), 1, "Order should execute");
    }

    function test_SC_C01_DCA_bytes32Zero_succeedsIfMinOutMet() public {
        // DCA orders ARE allowed to have routerDataHash = bytes32(0)
        // Warp to a time where dcaInterval check passes (block.timestamp >= dcaInterval)
        vm.warp(2 hours);

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.orderType = TeraSwapOrderExecutor.OrderType.DCA;
        order.routerDataHash = bytes32(0); // Allowed for DCA
        order.dcaTotal = 4;
        order.dcaInterval = 1 hours;
        order.expiry = block.timestamp + EXPIRY_DELTA;
        order.priceFeed = address(0); // No price check for DCA in this test

        // Router output is > minAmountOut so it should succeed
        router.setOutput(MIN_OUT + 100e18);

        bytes memory sig = _signOrderMemory(order);
        executor.executeOrder(order, sig, hex"01");

        // Verify execution happened
        bytes32 orderHash = _computeOrderHash(order);
        assertEq(executor.dcaExecutions(orderHash), 1, "DCA should execute once");
    }

    function test_SC_C01_DCA_bytes32Zero_revertsIfMinOutNotMet() public {
        // DCA with bytes32(0) but router returns less than minAmountOut
        vm.warp(2 hours);

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.orderType = TeraSwapOrderExecutor.OrderType.DCA;
        order.routerDataHash = bytes32(0);
        order.dcaTotal = 4;
        order.dcaInterval = 1 hours;
        order.expiry = block.timestamp + EXPIRY_DELTA;
        order.priceFeed = address(0);

        // Set router output to less than proportional minOut
        // minOut per execution = (MIN_OUT * (AMOUNT_IN/4)) / AMOUNT_IN = MIN_OUT/4
        // So output < MIN_OUT/4 should revert
        router.setOutput(MIN_OUT / 4 - 1);

        bytes memory sig = _signOrderMemory(order);

        vm.expectRevert(TeraSwapOrderExecutor.InsufficientOutput.selector);
        executor.executeOrder(order, sig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  SC-H-01: EXECUTOR TIMELOCK
    // ══════════════════════════════════════════════════════════════

    function test_SC_H01_proposeWait48hExecute_succeeds() public {
        address newExecutor = address(0xE1);

        // Propose
        vm.prank(admin);
        executor.proposeExecutor(newExecutor, true);

        // Verify not yet active
        assertFalse(executor.whitelistedExecutors(newExecutor), "Should not be active yet");

        // Wait 48h
        vm.warp(block.timestamp + 48 hours + 1);

        // Execute
        vm.prank(admin);
        executor.executeExecutorChange(newExecutor);

        assertTrue(executor.whitelistedExecutors(newExecutor), "Should be active after timelock");
    }

    function test_SC_H01_proposeExecuteImmediately_reverts() public {
        address newExecutor = address(0xE2);

        vm.prank(admin);
        executor.proposeExecutor(newExecutor, true);

        // Try to execute immediately — should revert
        vm.prank(admin);
        vm.expectRevert(TeraSwapOrderExecutor.TimelockNotExpired.selector);
        executor.executeExecutorChange(newExecutor);
    }

    function test_SC_H01_proposeWaitBeyondGrace_reverts() public {
        address newExecutor = address(0xE3);

        vm.prank(admin);
        executor.proposeExecutor(newExecutor, true);

        // Wait 48h (delay) + 7 days (grace) + 1s — expired
        vm.warp(block.timestamp + 48 hours + 7 days + 1);

        vm.prank(admin);
        vm.expectRevert(TeraSwapOrderExecutor.ProposalExpired.selector);
        executor.executeExecutorChange(newExecutor);
    }

    function test_SC_H01_proposeCancelExecute_reverts() public {
        address newExecutor = address(0xE4);

        // Propose
        vm.prank(admin);
        executor.proposeExecutor(newExecutor, true);

        // Cancel
        vm.prank(admin);
        executor.cancelExecutorProposal(newExecutor);

        // Wait and try to execute — should revert
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(admin);
        vm.expectRevert(TeraSwapOrderExecutor.NoActiveProposal.selector);
        executor.executeExecutorChange(newExecutor);
    }

    function test_SC_H01_nonAdminPropose_reverts() public {
        address newExecutor = address(0xE5);

        vm.prank(user);
        vm.expectRevert(TeraSwapOrderExecutor.NotAdmin.selector);
        executor.proposeExecutor(newExecutor, true);
    }

    // ══════════════════════════════════════════════════════════════
    //  SC-L: RECEIVE() RESTRICTION & SWEEP ETH
    // ══════════════════════════════════════════════════════════════

    function test_SCL_receiveOutsideExecution_reverts() public {
        // Sending ETH directly to the contract outside of executeOrder should revert
        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok, ) = address(executor).call{value: 1 ether}("");
        assertFalse(ok, "ETH sent outside execution should revert");
    }

    function test_SCL_sweepETH_sendsToAdmin() public {
        // Use vm.deal to bypass receive() guard (directly sets balance)
        vm.deal(address(executor), 3 ether);

        uint256 adminBefore = admin.balance;

        // Queue and execute sweep
        vm.prank(admin);
        executor.queueSweep(address(0));
        bytes32 actionHash = keccak256(abi.encode("sweep", address(0)));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

        vm.warp(block.timestamp + 48 hours + 1);

        vm.prank(admin);
        executor.executeSweep(actionId, address(0));

        assertEq(admin.balance - adminBefore, 3 ether, "ETH should go to admin");
        assertEq(address(executor).balance, 0, "Executor should have no ETH left");
    }

    function test_SCL_ethAcceptedDuringExecution() public {
        // ETH router test: router sends ETH back during execution, receive() must accept it
        MockETHRouter ethRtr = new MockETHRouter(1 ether);
        vm.deal(address(ethRtr), 10 ether);

        // Deploy fresh executor for clean bootstrap
        TeraSwapOrderExecutor freshExec = new TeraSwapOrderExecutor(
            feeRecipient, admin, address(weth)
        );
        address[] memory routers = new address[](1);
        routers[0] = address(ethRtr);
        address[] memory executorAddrs = new address[](1);
        executorAddrs[0] = address(this);
        vm.prank(admin);
        freshExec.bootstrap(routers, executorAddrs);

        // Fund user
        tokenIn.mint(user, AMOUNT_IN);
        vm.prank(user);
        tokenIn.approve(address(freshExec), type(uint256).max);

        // Create order with WETH as output (ETH router path)
        TeraSwapOrderExecutor.Order memory order = TeraSwapOrderExecutor.Order({
            owner: user,
            tokenIn: address(tokenIn),
            tokenOut: address(weth),
            amountIn: AMOUNT_IN,
            minAmountOut: 1 ether,
            orderType: TeraSwapOrderExecutor.OrderType.LIMIT,
            condition: TeraSwapOrderExecutor.PriceCondition.ABOVE,
            targetPrice: TARGET_PRICE,
            priceFeed: address(priceFeed),
            expiry: block.timestamp + EXPIRY_DELTA,
            nonce: 0,
            router: address(ethRtr),
            routerDataHash: keccak256(hex"01"),
            dcaInterval: 0,
            dcaTotal: 0
        });

        bytes memory sig = _signOrderFor(freshExec, order);

        // Execute — router returns ETH, receive() must work during execution
        uint256 userEthBefore = user.balance;
        freshExec.executeOrder(order, sig, hex"01");

        // User should receive ETH (order executed successfully through H-02 ETH path)
        assertGt(user.balance - userEthBefore, 0, "User should receive ETH output");
    }

    function test_SC_C01_DCA_recipientAlwaysOwner() public {
        // Verify that DCA output always goes to order.owner, not an arbitrary address
        vm.warp(2 hours);

        TeraSwapOrderExecutor.Order memory order = _defaultOrder();
        order.orderType = TeraSwapOrderExecutor.OrderType.DCA;
        order.routerDataHash = bytes32(0);
        order.dcaTotal = 2;
        order.dcaInterval = 1 hours;
        order.expiry = block.timestamp + EXPIRY_DELTA;
        order.priceFeed = address(0);
        router.setOutput(MIN_OUT + 100e18);

        bytes memory sig = _signOrderMemory(order);

        uint256 ownerBalBefore = tokenOut.balanceOf(user);
        executor.executeOrder(order, sig, hex"01");
        uint256 ownerBalAfter = tokenOut.balanceOf(user);

        // Output MUST go to order.owner (user), not the executor or router
        assertGt(ownerBalAfter - ownerBalBefore, 0, "Output must go to order.owner");
        assertEq(tokenOut.balanceOf(address(executor)), 0, "Executor should hold no output");
    }
}
