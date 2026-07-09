// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../TeraSwapOrderExecutorV3.sol";

// ══════════════════════════════════════════════════════════════════
//  MOCKS
// ══════════════════════════════════════════════════════════════════

/// @dev Minimal ERC-20 with configurable decimals
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

/// @dev Chainlink-style USD feed with configurable decimals + integrity controls
contract MockUsdFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    uint80 public answeredInRound;
    uint8 internal _dec;

    constructor(uint8 dec_, int256 answer_) {
        _dec = dec_;
        _set(answer_);
    }

    function _set(int256 a) internal {
        answer = a;
        updatedAt = block.timestamp;
        roundId++;
        answeredInRound = roundId;
    }

    function setAnswer(int256 a) external { _set(a); }
    function setUpdatedAt(uint256 t) external { updatedAt = t; }
    function setIncompleteRound() external { roundId++; } // answeredInRound < roundId

    function decimals() external view returns (uint8) { return _dec; }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, 0, updatedAt, answeredInRound);
    }
}

/// @dev Chainlink L2 sequencer-uptime feed (answer 0 = up, 1 = down)
contract MockSequencerFeed {
    int256 public answer;
    uint256 public startedAt;

    constructor(int256 answer_, uint256 startedAt_) {
        answer = answer_;
        startedAt = startedAt_;
    }

    function set(int256 a, uint256 s) external { answer = a; startedAt = s; }
    function decimals() external pure returns (uint8) { return 0; }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, startedAt, 1);
    }
}

/// @dev Mock DEX router: mints a fixed output and consumes the approved input (like a real router)
contract MockRouter {
    MockERC20 public outputToken;
    uint256 public outputAmount;
    bool public shouldFail;
    MockERC20 public inputToken;

    constructor(MockERC20 _outputToken, uint256 _outputAmount) {
        outputToken = _outputToken;
        outputAmount = _outputAmount;
    }

    function setOutput(uint256 _amount) external { outputAmount = _amount; }
    function setFail(bool _fail) external { shouldFail = _fail; }
    function setInputToken(MockERC20 _t) external { inputToken = _t; }
    function setOutputToken(MockERC20 _t) external { outputToken = _t; }

    fallback() external payable {
        if (shouldFail) revert("Router: swap failed");
        if (address(inputToken) != address(0)) {
            uint256 amt = inputToken.allowance(msg.sender, address(this));
            if (amt > 0) inputToken.transferFrom(msg.sender, address(this), amt);
        }
        outputToken.mint(msg.sender, outputAmount);
    }

    receive() external payable {}
}

/// @dev Router that returns native ETH (H-02 path)
contract MockETHRouter {
    uint256 public ethToReturn;
    constructor(uint256 _ethToReturn) { ethToReturn = _ethToReturn; }
    function setEthReturn(uint256 _amount) external { ethToReturn = _amount; }
    fallback() external payable {
        (bool ok, ) = msg.sender.call{value: ethToReturn}("");
        require(ok, "ETH send failed");
    }
    receive() external payable {}
}

/// @dev Malicious ERC-20 that attempts reentrancy during output safeTransfer
contract ReentrantToken is IERC20 {
    string public name = "Reentrant Token";
    string public symbol = "REENT";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    TeraSwapOrderExecutorV3 public target;
    TeraSwapOrderExecutorV3.Order public reentrantOrder;
    bytes public reentrantSig;
    bytes public reentrantData;
    bool public attackEnabled;

    function setAttack(
        TeraSwapOrderExecutorV3 _target,
        TeraSwapOrderExecutorV3.Order memory _order,
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
        if (attackEnabled && msg.sender == address(target)) {
            attackEnabled = false;
            try target.executeOrder(reentrantOrder, reentrantSig, reentrantData) {
                // if this succeeds, the guard is broken
            } catch {
                // expected: ReentrancyGuardReentrantCall
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

contract ReentrantRouter {
    ReentrantToken public outputToken;
    uint256 public outputAmount;
    constructor(ReentrantToken _outputToken, uint256 _outputAmount) {
        outputToken = _outputToken;
        outputAmount = _outputAmount;
    }
    fallback() external payable { outputToken.mint(msg.sender, outputAmount); }
    receive() external payable {}
}

/// @dev Test harness — exposes the internal fair-value helper for the decimals fuzz.
contract V3Harness is TeraSwapOrderExecutorV3 {
    constructor(address _feeRecipient, address _admin, address _weth, address _seq)
        TeraSwapOrderExecutorV3(_feeRecipient, _admin, _weth, _seq)
    {}

    function fairValueOut(address tokenIn, address tokenOut, uint256 amountIn)
        external view returns (uint256, bool)
    {
        return _fairValueOut(tokenIn, tokenOut, amountIn);
    }
}

// ══════════════════════════════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════════════════════════════

contract TeraSwapOrderExecutorV3Test is Test {
    V3Harness public executor;
    MockERC20 public tokenIn;
    MockERC20 public tokenOut;
    MockWETH public weth;
    MockRouter public router;
    MockUsdFeed public feedIn;
    MockUsdFeed public feedOut;

    address public admin = address(0xAD);
    address public feeRecipient = address(0xFE);
    uint256 public userPk = 0xA11CE;
    address public user;
    bytes32 public domainSep; // cached so _sign() makes no external call (would trip vm.expectRevert)

    uint256 constant AMOUNT_IN = 1000e18;
    uint256 constant MIN_OUT = 1e18;          // low signed min so the oracle floor dominates by default
    uint256 constant EXPIRY_DELTA = 7 days;
    uint16 constant SLIP = 500;               // 5%
    uint256 constant FEED_STALENESS = 30 days;

    string constant TYPESTRING =
        "Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,"
        "uint256 minAmountOut,uint16 maxSlippageBps,uint8 orderType,uint8 condition,"
        "uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router,"
        "bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)";

    function setUp() public {
        vm.warp(1_700_000_000);
        user = vm.addr(userPk);

        tokenIn = new MockERC20("Token In", "TIN", 18);
        tokenOut = new MockERC20("Token Out", "TOUT", 18);
        weth = new MockWETH();
        router = new MockRouter(tokenOut, 999e18);
        router.setInputToken(tokenIn);

        // mainnet-style: no sequencer feed
        executor = new V3Harness(feeRecipient, admin, address(weth), address(0));

        address[] memory routers = new address[](1);
        routers[0] = address(router);
        address[] memory executors = new address[](1);
        executors[0] = address(this);
        vm.prank(admin);
        executor.bootstrap(routers, executors);
        domainSep = executor.domainSeparator();

        tokenIn.mint(user, 1_000_000e18);
        vm.prank(user);
        tokenIn.approve(address(executor), type(uint256).max);
    }

    // ── helpers ──────────────────────────────────────────────────────

    function _order() internal view returns (TeraSwapOrderExecutorV3.Order memory) {
        return TeraSwapOrderExecutorV3.Order({
            owner: user,
            tokenIn: address(tokenIn),
            tokenOut: address(tokenOut),
            amountIn: AMOUNT_IN,
            minAmountOut: MIN_OUT,
            maxSlippageBps: SLIP,
            orderType: TeraSwapOrderExecutorV3.OrderType.LIMIT,
            condition: TeraSwapOrderExecutorV3.PriceCondition.ABOVE,
            targetPrice: 0,
            priceFeed: address(0),           // no trigger condition — isolate the output floor
            expiry: block.timestamp + EXPIRY_DELTA,
            nonce: 0,
            router: address(router),
            routerDataHash: keccak256(hex"01"),
            dcaInterval: 0,
            dcaTotal: 0
        });
    }

    function _hash(TeraSwapOrderExecutorV3.Order memory o) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256(bytes(TYPESTRING)),
            o.owner, o.tokenIn, o.tokenOut, o.amountIn, o.minAmountOut, o.maxSlippageBps,
            o.orderType, o.condition, o.targetPrice, o.priceFeed, o.expiry, o.nonce,
            o.router, o.routerDataHash, o.dcaInterval, o.dcaTotal
        ));
    }

    function _sign(TeraSwapOrderExecutorV3.Order memory o) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, _hash(o)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _net(uint256 amountIn) internal pure returns (uint256) {
        return amountIn - (amountIn * 10) / 10_000;
    }

    /// @dev Register a token→USD feed through the 48h timelock (queue → warp → refresh → execute).
    function _registerFeed(MockUsdFeed feed, address token, uint8 tokenDec) internal {
        uint256 qt = block.timestamp;
        vm.prank(admin);
        executor.queueTokenUsdFeed(token, address(feed), tokenDec, FEED_STALENESS);
        bytes32 actionHash = keccak256(abi.encode("setTokenUsdFeed", token, address(feed), tokenDec, FEED_STALENESS));
        bytes32 actionId = keccak256(abi.encode(actionHash, qt));
        vm.warp(qt + 48 hours + 1);
        feed.setAnswer(feed.answer()); // refresh updatedAt so the deadness check passes
        vm.prank(admin);
        executor.executeTokenUsdFeed(actionId, token, address(feed), tokenDec, FEED_STALENESS);
    }

    /// @dev Register $1/$1 8-decimal feeds for the default TIN/TOUT pair.
    function _registerDefaultFeeds() internal {
        feedIn = new MockUsdFeed(8, 1e8);
        feedOut = new MockUsdFeed(8, 1e8);
        _registerFeed(feedIn, address(tokenIn), 18);
        _registerFeed(feedOut, address(tokenOut), 18);
    }

    // ══════════════════════════════════════════════════════════════
    //  C1 — maxSlippageBps + kill the 1-wei clamp
    // ══════════════════════════════════════════════════════════════

    function test_maxSlippage_501_reverts() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.maxSlippageBps = 501;
        vm.expectRevert(TeraSwapOrderExecutorV3.SlippageTooHigh.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_maxSlippage_65535_reverts() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.maxSlippageBps = 65535;
        vm.expectRevert(TeraSwapOrderExecutorV3.SlippageTooHigh.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_maxSlippage_500_ok() public {
        // No feeds → floor = signed min; router mints > min → executes at the 5% boundary.
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.maxSlippageBps = 500;
        executor.executeOrder(o, _sign(o), hex"01");
        assertTrue(executor.isNonceUsed(user, 0));
    }

    function test_zeroMinAmountOut_reverts() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.minAmountOut = 0;
        vm.expectRevert(TeraSwapOrderExecutorV3.InvalidMinOutput.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_scaledMinRoundsToZero_reverts() public {
        // DCA: scaledMin = minAmountOut * chunk / amountIn. minAmountOut=1, dcaTotal=2
        // => scaledMin = 1 * (amountIn/2) / amountIn = 0 => revert (no 1-wei clamp anymore).
        vm.warp(block.timestamp + 2 hours);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.orderType = TeraSwapOrderExecutorV3.OrderType.DCA;
        o.minAmountOut = 1;
        o.dcaTotal = 2;
        o.dcaInterval = 1 hours;
        o.expiry = block.timestamp + EXPIRY_DELTA;
        vm.expectRevert(TeraSwapOrderExecutorV3.InvalidMinOutput.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  C2/C3 — fair-value floor
    // ══════════════════════════════════════════════════════════════

    function test_floor_feeded_subFloor_reverts() public {
        _registerDefaultFeeds();
        (uint256 fair, bool has) = executor.fairValueOut(address(tokenIn), address(tokenOut), _net(AMOUNT_IN));
        assertTrue(has, "feeded pair");
        uint256 floor = (fair * (10_000 - SLIP)) / 10_000;

        router.setOutput(floor - 1);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.expiry = block.timestamp + EXPIRY_DELTA;
        vm.expectRevert(TeraSwapOrderExecutorV3.InsufficientOutput.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_floor_feeded_atFloor_ok() public {
        _registerDefaultFeeds();
        (uint256 fair, ) = executor.fairValueOut(address(tokenIn), address(tokenOut), _net(AMOUNT_IN));
        uint256 floor = (fair * (10_000 - SLIP)) / 10_000;

        router.setOutput(floor);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.expiry = block.timestamp + EXPIRY_DELTA;
        executor.executeOrder(o, _sign(o), hex"01");
        assertGe(tokenOut.balanceOf(user), floor);
    }

    function test_floor_oracleDominatesSignedMin() public {
        // signedMin tiny; oracle floor higher. Output between the two => revert (oracle binds).
        _registerDefaultFeeds();
        (uint256 fair, ) = executor.fairValueOut(address(tokenIn), address(tokenOut), _net(AMOUNT_IN));
        uint256 oracleFloor = (fair * (10_000 - SLIP)) / 10_000;

        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.minAmountOut = 1e18; // far below oracleFloor (~949e18)
        o.expiry = block.timestamp + EXPIRY_DELTA;
        router.setOutput(oracleFloor - 1);
        vm.expectRevert(TeraSwapOrderExecutorV3.InsufficientOutput.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_floor_signedMinDominatesOracle() public {
        // signedMin above oracle floor => max() picks signedMin. Output between oracleFloor and
        // signedMin => revert (proves the signed absolute min is respected as the higher bound).
        _registerDefaultFeeds();
        (uint256 fair, ) = executor.fairValueOut(address(tokenIn), address(tokenOut), _net(AMOUNT_IN));
        uint256 oracleFloor = (fair * (10_000 - SLIP)) / 10_000; // ~949e18

        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.minAmountOut = 980e18; // above oracleFloor
        o.expiry = block.timestamp + EXPIRY_DELTA;
        router.setOutput(970e18); // >= oracleFloor but < signedMin
        vm.expectRevert(TeraSwapOrderExecutorV3.InsufficientOutput.selector);
        executor.executeOrder(o, _sign(o), hex"01");

        // and clearing signedMin succeeds
        router.setOutput(981e18);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_noFeed_absoluteMin_path() public {
        // No feeds registered => floor = signed min.
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.minAmountOut = 500e18;

        router.setOutput(500e18 - 1);
        vm.expectRevert(TeraSwapOrderExecutorV3.InsufficientOutput.selector);
        executor.executeOrder(o, _sign(o), hex"01");

        router.setOutput(500e18);
        executor.executeOrder(o, _sign(o), hex"01");
        assertGe(tokenOut.balanceOf(user), 500e18);
    }

    function test_staleFeed_fallsBackToAbsoluteMin() public {
        _registerDefaultFeeds();
        // Make tokenIn feed stale => NO-FEED semantics => floor = signed min.
        feedIn.setUpdatedAt(1);

        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.minAmountOut = 400e18;
        o.expiry = block.timestamp + EXPIRY_DELTA;

        // An output far below the oracle floor (~949e18) but >= signed min now SUCCEEDS.
        router.setOutput(400e18);
        executor.executeOrder(o, _sign(o), hex"01");
        assertGe(tokenOut.balanceOf(user), 400e18);
    }

    function test_staleFeed_belowSignedMin_reverts() public {
        _registerDefaultFeeds();
        feedIn.setUpdatedAt(1);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.minAmountOut = 400e18;
        o.expiry = block.timestamp + EXPIRY_DELTA;
        router.setOutput(400e18 - 1);
        vm.expectRevert(TeraSwapOrderExecutorV3.InsufficientOutput.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_incompleteRound_fallsBackToAbsoluteMin() public {
        _registerDefaultFeeds();
        feedOut.setIncompleteRound(); // answeredInRound < roundId => NO-FEED
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.minAmountOut = 300e18;
        o.expiry = block.timestamp + EXPIRY_DELTA;
        router.setOutput(300e18); // below oracle floor but >= signed min
        executor.executeOrder(o, _sign(o), hex"01");
        assertGe(tokenOut.balanceOf(user), 300e18);
    }

    // ── sequencer (Base) ─────────────────────────────────────────────

    function _deploySequencerExecutor(int256 seqAnswer, uint256 seqStartedAt)
        internal returns (V3Harness ex, MockSequencerFeed seq)
    {
        seq = new MockSequencerFeed(seqAnswer, seqStartedAt);
        ex = new V3Harness(feeRecipient, admin, address(weth), address(seq));
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        address[] memory executors = new address[](1);
        executors[0] = address(this);
        vm.prank(admin);
        ex.bootstrap(routers, executors);
    }

    function test_sequencerDown_noFeed() public {
        // Sequencer DOWN => NO-FEED even with valid price feeds => floor = signed min.
        (V3Harness ex, MockSequencerFeed seq) = _deploySequencerExecutor(0, 1);
        // register feeds on THIS executor (registration warps time forward)
        _registerFeedOn(ex, new MockUsdFeed(8, 1e8), address(tokenIn), 18);
        _registerFeedOn(ex, new MockUsdFeed(8, 1e8), address(tokenOut), 18);
        seq.set(1, block.timestamp - 2 hours); // down, relative to the post-registration clock

        (uint256 fair, bool has) = ex.fairValueOut(address(tokenIn), address(tokenOut), _net(AMOUNT_IN));
        assertFalse(has, "sequencer down => no feed");
        assertEq(fair, 0);
    }

    function test_sequencerWithinGrace_noFeed() public {
        // Sequencer UP but recovered < grace ago => NO-FEED.
        (V3Harness ex, MockSequencerFeed seq) = _deploySequencerExecutor(0, 1);
        _registerFeedOn(ex, new MockUsdFeed(8, 1e8), address(tokenIn), 18);
        _registerFeedOn(ex, new MockUsdFeed(8, 1e8), address(tokenOut), 18);
        seq.set(0, block.timestamp - 100); // up, 100s < 3600s grace

        (, bool has) = ex.fairValueOut(address(tokenIn), address(tokenOut), _net(AMOUNT_IN));
        assertFalse(has, "within grace => no feed");
    }

    function test_sequencerUp_afterGrace_usesFeed() public {
        (V3Harness ex, MockSequencerFeed seq) = _deploySequencerExecutor(0, 1);
        _registerFeedOn(ex, new MockUsdFeed(8, 1e8), address(tokenIn), 18);
        _registerFeedOn(ex, new MockUsdFeed(8, 1e8), address(tokenOut), 18);
        seq.set(0, block.timestamp - 2 hours); // up, > grace

        (uint256 fair, bool has) = ex.fairValueOut(address(tokenIn), address(tokenOut), _net(AMOUNT_IN));
        assertTrue(has, "up + past grace => feed");
        assertGt(fair, 0);
    }

    /// @dev Register a feed on an arbitrary executor instance (for the sequencer executors).
    function _registerFeedOn(V3Harness ex, MockUsdFeed feed, address token, uint8 tokenDec) internal {
        uint256 qt = block.timestamp;
        vm.prank(admin);
        ex.queueTokenUsdFeed(token, address(feed), tokenDec, FEED_STALENESS);
        bytes32 actionHash = keccak256(abi.encode("setTokenUsdFeed", token, address(feed), tokenDec, FEED_STALENESS));
        bytes32 actionId = keccak256(abi.encode(actionHash, qt));
        vm.warp(qt + 48 hours + 1);
        feed.setAnswer(feed.answer());
        vm.prank(admin);
        ex.executeTokenUsdFeed(actionId, token, address(feed), tokenDec, FEED_STALENESS);
    }

    // ── decimals fuzz (6/8/18 legs × 8/18 feed) ─────────────────────

    function testFuzz_fairValue_decimals(uint8 tSeed, uint8 tOutSeed, bool feedIn18, bool feedOut18, uint256 amt) public {
        uint8[3] memory opts = [6, 8, 18];
        uint8 tInDec = opts[tSeed % 3];
        uint8 tOutDec = opts[tOutSeed % 3];
        uint8 fInDec = feedIn18 ? 18 : 8;
        uint8 fOutDec = feedOut18 ? 18 : 8;

        MockERC20 tIn = new MockERC20("FIn", "FI", tInDec);
        MockERC20 tOut = new MockERC20("FOut", "FO", tOutDec);
        // $1..$100000, at each feed's decimals
        MockUsdFeed fIn = new MockUsdFeed(fInDec, int256(1 * 10 ** uint256(fInDec)));
        MockUsdFeed fOut = new MockUsdFeed(fOutDec, int256(3 * 10 ** uint256(fOutDec)));

        _registerFeed(fIn, address(tIn), tInDec);
        _registerFeed(fOut, address(tOut), tOutDec);

        // amount: 1 .. 1e9 whole tokens, raw
        amt = bound(amt, 10 ** uint256(tInDec), 1_000_000_000 * 10 ** uint256(tInDec));

        (uint256 fair, bool has) = executor.fairValueOut(address(tIn), address(tOut), amt);
        assertTrue(has, "both legs feeded");
        // fair value = amt(real) * $1 / $3, in tOut decimals => strictly positive, no rounding-to-zero
        assertGt(fair, 0, "no rounding-to-zero floor");
        // Cross-check magnitude: real in-value $ = amt / 10^tInDec ; out = value/3 tokens.
        uint256 expectedReal = (amt * 1) / (3 * 10 ** uint256(tInDec)); // whole tOut tokens, floored
        if (expectedReal > 0) {
            uint256 fairReal = fair / 10 ** uint256(tOutDec);
            // allow ±1 token rounding across the decimal normalisations
            assertApproxEqAbs(fairReal, expectedReal, 1, "fair value within rounding");
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  C4 — routerDataHash resolution
    // ══════════════════════════════════════════════════════════════

    function test_nonDCA_zeroHash_reverts() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.routerDataHash = bytes32(0);
        vm.expectRevert(TeraSwapOrderExecutorV3.RouterDataRequired.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_nonDCA_wrongHash_reverts() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.routerDataHash = keccak256(hex"FF");
        vm.expectRevert(TeraSwapOrderExecutorV3.RouterDataMismatch.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_nonDCA_correctHash_ok() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.routerDataHash = keccak256(hex"01");
        executor.executeOrder(o, _sign(o), hex"01");
        assertTrue(executor.isNonceUsed(user, 0));
    }

    function test_DCA_zeroHash_ok_boundByFloor() public {
        vm.warp(block.timestamp + 2 hours);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.orderType = TeraSwapOrderExecutorV3.OrderType.DCA;
        o.routerDataHash = bytes32(0);
        o.minAmountOut = 100e18;
        o.dcaTotal = 4;
        o.dcaInterval = 1 hours;
        o.expiry = block.timestamp + EXPIRY_DELTA;
        router.setOutput(300e18);
        executor.executeOrder(o, _sign(o), hex"01");
        assertEq(executor.dcaExecutions(_hash(o)), 1);
    }

    // ══════════════════════════════════════════════════════════════
    //  C5 — unordered nonce bitmap
    // ══════════════════════════════════════════════════════════════

    function test_bitmap_outOfOrderExecution() public {
        // Execute nonce 5 first, then nonce 2 — both independent, both succeed.
        TeraSwapOrderExecutorV3.Order memory o5 = _order();
        o5.nonce = 5;
        executor.executeOrder(o5, _sign(o5), hex"01");
        assertTrue(executor.isNonceUsed(user, 5));
        assertFalse(executor.isNonceUsed(user, 2));

        TeraSwapOrderExecutorV3.Order memory o2 = _order();
        o2.nonce = 2;
        executor.executeOrder(o2, _sign(o2), hex"01");
        assertTrue(executor.isNonceUsed(user, 2));
    }

    function test_bitmap_replayRejected() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        executor.executeOrder(o, _sign(o), hex"01");
        vm.expectRevert(TeraSwapOrderExecutorV3.InvalidNonce.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_bitmap_invalidation_blocksNonce() public {
        // Invalidate nonce 3 (wordPos 0, bit 3), then try to execute it.
        vm.prank(user);
        executor.invalidateUnorderedNonces(0, 1 << 3);
        assertTrue(executor.isNonceUsed(user, 3));

        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.nonce = 3;
        vm.expectRevert(TeraSwapOrderExecutorV3.InvalidNonce.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_bitmap_invalidationDoesNotBlockOthers() public {
        vm.prank(user);
        executor.invalidateUnorderedNonces(0, 1 << 1); // cancel nonce 1
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.nonce = 2; // different nonce still works
        executor.executeOrder(o, _sign(o), hex"01");
        assertTrue(executor.isNonceUsed(user, 2));
    }

    function test_bitmap_massCancelWholeWord() public {
        vm.prank(user);
        executor.invalidateUnorderedNonces(0, type(uint256).max); // cancel nonces 0..255
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.nonce = 200;
        vm.expectRevert(TeraSwapOrderExecutorV3.InvalidNonce.selector);
        executor.executeOrder(o, _sign(o), hex"01");
        // nonce 256 lives in word 1 — unaffected
        assertFalse(executor.isNonceUsed(user, 256));
    }

    function test_bitmapPositions_and_isNonceUsed() public view {
        (uint256 wp, uint256 bp) = executor.bitmapPositions(258);
        assertEq(wp, 1);
        assertEq(bp, 2);
        assertFalse(executor.isNonceUsed(user, 258));
    }

    // ══════════════════════════════════════════════════════════════
    //  DCA counters (parity)
    // ══════════════════════════════════════════════════════════════

    function test_dca_counters_and_complete() public {
        vm.warp(block.timestamp + 2 hours);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.orderType = TeraSwapOrderExecutorV3.OrderType.DCA;
        o.routerDataHash = bytes32(0);
        o.minAmountOut = 40e18;
        o.dcaTotal = 3;
        o.dcaInterval = 1 hours;
        o.expiry = block.timestamp + EXPIRY_DELTA;
        router.setOutput(300e18);
        bytes memory sig = _sign(o);

        for (uint256 i = 0; i < 3; i++) {
            executor.executeOrder(o, sig, hex"01");
            assertEq(executor.dcaExecutions(_hash(o)), i + 1);
            if (i < 2) vm.warp(block.timestamp + 1 hours + 1);
        }
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(TeraSwapOrderExecutorV3.DCAComplete.selector);
        executor.executeOrder(o, sig, hex"01");
    }

    function test_dca_doesNotConsumeBitmap() public {
        vm.warp(block.timestamp + 2 hours);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.orderType = TeraSwapOrderExecutorV3.OrderType.DCA;
        o.routerDataHash = bytes32(0);
        o.minAmountOut = 40e18;
        o.dcaTotal = 2;
        o.dcaInterval = 1 hours;
        o.nonce = 7;
        o.expiry = block.timestamp + EXPIRY_DELTA;
        router.setOutput(300e18);
        executor.executeOrder(o, _sign(o), hex"01");
        // DCA must not touch the bitmap — nonce 7 stays unused.
        assertFalse(executor.isNonceUsed(user, 7));
    }

    function test_dca_intervalNotReached() public {
        vm.warp(block.timestamp + 2 hours);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.orderType = TeraSwapOrderExecutorV3.OrderType.DCA;
        o.routerDataHash = bytes32(0);
        o.minAmountOut = 40e18;
        o.dcaTotal = 3;
        o.dcaInterval = 1 hours;
        o.expiry = block.timestamp + EXPIRY_DELTA;
        router.setOutput(300e18);
        bytes memory sig = _sign(o);
        executor.executeOrder(o, sig, hex"01");
        vm.expectRevert(TeraSwapOrderExecutorV3.DCAIntervalNotReached.selector);
        executor.executeOrder(o, sig, hex"01");
    }

    // ══════════════════════════════════════════════════════════════
    //  v2 parity — recipient, whitelist, access control, fee
    // ══════════════════════════════════════════════════════════════

    function test_parity_recipientAlwaysOwner() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.minAmountOut = 500e18;
        router.setOutput(600e18);
        uint256 before = tokenOut.balanceOf(user);
        executor.executeOrder(o, _sign(o), hex"01");
        assertEq(tokenOut.balanceOf(user) - before, 600e18, "output to owner");
        assertEq(tokenOut.balanceOf(address(executor)), 0, "executor holds nothing");
    }

    function test_parity_nonWhitelistedRouter_reverts() public {
        MockRouter bad = new MockRouter(tokenOut, 999e18);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.router = address(bad);
        vm.expectRevert(TeraSwapOrderExecutorV3.RouterNotWhitelisted.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_parity_chainCorrectRouterWhitelist() public {
        // ADR-011 whitelist gate preserved: the chain-correct Augustus routers are whitelistable.
        address augustusV5Mainnet = 0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57;
        address augustusV6Base = 0x6A000F20005980200259B80c5102003040001068;
        vm.etch(augustusV5Mainnet, hex"6001"); // non-empty code => passes the NotAContract guard
        vm.etch(augustusV6Base, hex"6001");

        V3Harness fresh = new V3Harness(feeRecipient, admin, address(weth), address(0));
        address[] memory routers = new address[](2);
        routers[0] = augustusV5Mainnet;
        routers[1] = augustusV6Base;
        address[] memory execs = new address[](0);
        vm.prank(admin);
        fresh.bootstrap(routers, execs);

        assertTrue(fresh.whitelistedRouters(augustusV5Mainnet), "mainnet Augustus V5 whitelisted");
        assertTrue(fresh.whitelistedRouters(augustusV6Base), "Base Augustus V6 whitelisted");
        assertFalse(fresh.whitelistedRouters(address(0xBEEF)), "default-deny holds");
    }

    function test_parity_onlyWhitelistedExecutor() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        bytes memory sig = _sign(o);
        vm.prank(address(0xBAD));
        vm.expectRevert(TeraSwapOrderExecutorV3.NotExecutor.selector);
        executor.executeOrder(o, sig, hex"01");
    }

    function test_parity_pauseBlocksExecution() public {
        vm.prank(admin);
        executor.pause();
        TeraSwapOrderExecutorV3.Order memory o = _order();
        bytes memory sig = _sign(o);
        vm.expectRevert("Contract paused");
        executor.executeOrder(o, sig, hex"01");
    }

    function test_parity_invalidSignature() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", executor.domainSeparator(), _hash(o)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xDEAD), digest);
        vm.expectRevert(TeraSwapOrderExecutorV3.InvalidSignature.selector);
        executor.executeOrder(o, abi.encodePacked(r, s, v), hex"01");
    }

    function test_parity_expired() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.expiry = block.timestamp - 1;
        vm.expectRevert(TeraSwapOrderExecutorV3.OrderExpired.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_parity_cancelled() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        bytes memory sig = _sign(o);
        vm.prank(user);
        executor.cancelOrder(o);
        vm.expectRevert(TeraSwapOrderExecutorV3.OrderCancelledError.selector);
        executor.executeOrder(o, sig, hex"01");
    }

    function test_parity_fee() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.minAmountOut = 500e18;
        uint256 before = tokenIn.balanceOf(feeRecipient);
        executor.executeOrder(o, _sign(o), hex"01");
        assertEq(tokenIn.balanceOf(feeRecipient) - before, (AMOUNT_IN * 10) / 10_000);
    }

    function test_parity_insufficientBalance() public {
        uint256 bal = tokenIn.balanceOf(user);
        vm.prank(user);
        tokenIn.transfer(address(0xDEAD), bal);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        vm.expectRevert(TeraSwapOrderExecutorV3.InsufficientBalance.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_parity_insufficientAllowance() public {
        vm.prank(user);
        tokenIn.approve(address(executor), 0);
        TeraSwapOrderExecutorV3.Order memory o = _order();
        vm.expectRevert(TeraSwapOrderExecutorV3.InsufficientAllowance.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    function test_parity_orderTooSmall() public {
        TeraSwapOrderExecutorV3.Order memory o = _order();
        o.amountIn = 9_999; // < MIN_ORDER_AMOUNT
        vm.expectRevert(TeraSwapOrderExecutorV3.OrderTooSmall.selector);
        executor.executeOrder(o, _sign(o), hex"01");
    }

    // ── oracle config is timelocked (P6) ─────────────────────────────

    function test_oracleConfig_isTimelocked() public {
        MockUsdFeed f = new MockUsdFeed(8, 1e8);
        // queue only — not yet registered
        vm.prank(admin);
        executor.queueTokenUsdFeed(address(tokenIn), address(f), 18, FEED_STALENESS);
        (, , , , bool registered) = executor.tokenUsdFeeds(address(tokenIn));
        assertFalse(registered, "must not register before timelock elapses");

        bytes32 actionHash = keccak256(abi.encode("setTokenUsdFeed", address(tokenIn), address(f), uint8(18), FEED_STALENESS));
        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));
        // executing early reverts
        vm.prank(admin);
        vm.expectRevert(TeraSwapOrderExecutorV3.TimelockNotReady.selector);
        executor.executeTokenUsdFeed(actionId, address(tokenIn), address(f), 18, FEED_STALENESS);
    }

    function test_oracleConfig_onlyAdmin() public {
        MockUsdFeed f = new MockUsdFeed(8, 1e8);
        vm.prank(user);
        vm.expectRevert(TeraSwapOrderExecutorV3.NotAdmin.selector);
        executor.queueTokenUsdFeed(address(tokenIn), address(f), 18, FEED_STALENESS);
    }

    // ══════════════════════════════════════════════════════════════
    //  reentrancy
    // ══════════════════════════════════════════════════════════════

    function test_reentrancy_blocked() public {
        ReentrantToken rout = new ReentrantToken();
        ReentrantRouter rrouter = new ReentrantRouter(rout, 600e18);

        V3Harness ex = new V3Harness(feeRecipient, admin, address(weth), address(0));
        address[] memory routers = new address[](1);
        routers[0] = address(rrouter);
        address[] memory execs = new address[](1);
        execs[0] = address(this);
        vm.prank(admin);
        ex.bootstrap(routers, execs);

        tokenIn.mint(user, AMOUNT_IN * 2);
        vm.prank(user);
        tokenIn.approve(address(ex), type(uint256).max);

        TeraSwapOrderExecutorV3.Order memory o1 = _order();
        o1.tokenOut = address(rout);
        o1.minAmountOut = 500e18;
        o1.router = address(rrouter);
        o1.routerDataHash = keccak256(hex"AA");
        bytes32 d1 = keccak256(abi.encodePacked("\x19\x01", ex.domainSeparator(), _hash(o1)));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(userPk, d1);
        bytes memory sig1 = abi.encodePacked(r1, s1, v1);

        TeraSwapOrderExecutorV3.Order memory o2 = _order();
        o2.tokenOut = address(rout);
        o2.minAmountOut = 500e18;
        o2.router = address(rrouter);
        o2.routerDataHash = keccak256(hex"BB");
        o2.nonce = 1;
        bytes32 d2 = keccak256(abi.encodePacked("\x19\x01", ex.domainSeparator(), _hash(o2)));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(userPk, d2);
        bytes memory sig2 = abi.encodePacked(r2, s2, v2);

        rout.setAttack(ex, o2, sig2, hex"BB");
        ex.executeOrder(o1, sig1, hex"AA");

        // Outer order completed; the reentrant nonce-1 order must NOT have executed.
        assertTrue(ex.isNonceUsed(user, 0), "outer order consumed nonce 0");
        assertFalse(ex.isNonceUsed(user, 1), "reentrant order must not execute");
    }
}
