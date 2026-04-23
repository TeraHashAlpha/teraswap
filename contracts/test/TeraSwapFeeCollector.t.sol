// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../TeraSwapFeeCollector.sol";

// ══════════════════════════════════════════════════════════════
//  [H-04] Test helpers — mock ERC-20 and mock router
// ══════════════════════════════════════════════════════════════

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Minimal router used only for tests. Configures a fixed payout,
///      pulls input tokens (if any) from the caller, and delivers the
///      payout to the declared recipient. Silent on value/payload —
///      the test sets what it returns via setPayout before the swap.
contract MockRouter {
    address public payoutToken;
    uint256 public payoutAmount;

    function setPayout(address token, uint256 amount) external {
        payoutToken = token;
        payoutAmount = amount;
    }

    function execute(address tokenIn, uint256 pullAmount, address recipient) external payable {
        if (tokenIn != address(0) && pullAmount > 0) {
            IERC20(tokenIn).transferFrom(msg.sender, address(this), pullAmount);
        }
        if (payoutToken == address(0)) {
            (bool ok, ) = recipient.call{value: payoutAmount}("");
            require(ok, "ETH payout failed");
        } else {
            require(IERC20(payoutToken).transfer(recipient, payoutAmount), "Token payout failed");
        }
    }

    receive() external payable {}
}

contract TeraSwapFeeCollectorTest is Test {
    TeraSwapFeeCollector public collector;

    address public admin = address(0xAD);
    address public feeRecipient = address(0xFE);
    address public routerAddr = address(0x1111);
    address public user = address(0xABC);

    function setUp() public {
        collector = new TeraSwapFeeCollector(feeRecipient, admin);

        // Bootstrap a router
        address[] memory routers = new address[](1);
        routers[0] = routerAddr;
        vm.prank(admin);
        collector.bootstrapRouters(routers);
    }

    // ══════════════════════════════════════════════════════════════
    //  HELPERS
    // ══════════════════════════════════════════════════════════════

    function _queueRouterChange(address router, bool status) internal returns (bytes32 actionId) {
        vm.prank(admin);
        collector.queueRouterChange(router, status);
        bytes32 actionHash = keccak256(abi.encode("setRouter", router, status));
        actionId = keccak256(abi.encode(actionHash, block.timestamp));
    }

    // ══════════════════════════════════════════════════════════════
    //  R-12: FEECOLLECTOR TIMELOCK TESTS
    // ══════════════════════════════════════════════════════════════

    function test_R12_queueRouterChange() public {
        address newRouter = address(0x2222);

        vm.prank(admin);
        collector.queueRouterChange(newRouter, true);

        // Router should NOT be whitelisted yet
        assertFalse(collector.whitelistedRouters(newRouter));
    }

    function test_R12_executeRouterChangeAfter48h() public {
        address newRouter = address(0x2222);
        bytes32 actionId = _queueRouterChange(newRouter, true);

        // Warp past 48h
        vm.warp(block.timestamp + 48 hours + 1);

        vm.prank(admin);
        collector.executeRouterChange(actionId, newRouter, true);

        assertTrue(collector.whitelistedRouters(newRouter));
    }

    function test_R12_executeBeforeDelayReverts() public {
        address newRouter = address(0x2222);
        bytes32 actionId = _queueRouterChange(newRouter, true);

        // Warp only 24h (less than 48h)
        vm.warp(block.timestamp + 24 hours);

        vm.prank(admin);
        vm.expectRevert(TeraSwapFeeCollector.TimelockNotReady.selector);
        collector.executeRouterChange(actionId, newRouter, true);
    }

    function test_R12_executeAfterGraceReverts() public {
        address newRouter = address(0x2222);
        bytes32 actionId = _queueRouterChange(newRouter, true);

        // Warp past 48h + 7 days grace + 1s
        vm.warp(block.timestamp + 48 hours + 7 days + 1);

        vm.prank(admin);
        vm.expectRevert(TeraSwapFeeCollector.TimelockExpired.selector);
        collector.executeRouterChange(actionId, newRouter, true);
    }

    function test_R12_cancelTimelockAction() public {
        address newRouter = address(0x2222);
        bytes32 actionId = _queueRouterChange(newRouter, true);

        // Admin cancels
        vm.prank(admin);
        collector.cancelTimelockAction(actionId);

        // Trying to execute should fail
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(admin);
        vm.expectRevert(TeraSwapFeeCollector.TimelockNotQueued.selector);
        collector.executeRouterChange(actionId, newRouter, true);
    }

    function test_R12_onlyAdminCanQueue() public {
        vm.prank(user);
        vm.expectRevert(TeraSwapFeeCollector.NotAuthorized.selector);
        collector.queueRouterChange(address(0x2222), true);
    }

    function test_R12_hashMismatchReverts() public {
        address newRouter = address(0x2222);
        bytes32 actionId = _queueRouterChange(newRouter, true);

        vm.warp(block.timestamp + 48 hours + 1);

        // Try to execute with different parameters
        vm.prank(admin);
        vm.expectRevert(TeraSwapFeeCollector.TimelockHashMismatch.selector);
        collector.executeRouterChange(actionId, address(0x3333), true);
    }

    function test_R12_pauseRemainsImmediate() public {
        // Pause should work immediately (no timelock)
        vm.prank(admin);
        collector.pause();
        assertTrue(collector.paused());

        // Unpause should also be immediate
        vm.prank(admin);
        collector.unpause();
        assertFalse(collector.paused());
    }

    // ══════════════════════════════════════════════════════════════
    //  SC-L: RECEIVE() RESTRICTION & SWEEP ETH
    // ══════════════════════════════════════════════════════════════

    function test_SCL_receiveOutsideSwap_reverts() public {
        // Sending ETH directly to the contract outside of a swap should revert
        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok, ) = address(collector).call{value: 1 ether}("");
        assertFalse(ok, "ETH sent outside swap should revert");
    }

    function test_SCL_sweepETH_sendsToFeeRecipient() public {
        // Use vm.deal to bypass receive() guard (directly sets balance)
        vm.deal(address(collector), 2 ether);

        uint256 recipientBefore = feeRecipient.balance;

        vm.prank(admin);
        collector.sweep(address(0));

        assertEq(feeRecipient.balance - recipientBefore, 2 ether, "ETH should go to feeRecipient");
        assertEq(address(collector).balance, 0, "Collector should have no ETH left");
    }

    function test_R12_bootstrapRouters() public {
        // Deploy fresh collector (not bootstrapped)
        TeraSwapFeeCollector fresh = new TeraSwapFeeCollector(feeRecipient, admin);

        address[] memory routers = new address[](2);
        routers[0] = address(0xA111);
        routers[1] = address(0xA222);

        vm.prank(admin);
        fresh.bootstrapRouters(routers);

        assertTrue(fresh.whitelistedRouters(address(0xA111)));
        assertTrue(fresh.whitelistedRouters(address(0xA222)));

        // Cannot bootstrap again
        vm.prank(admin);
        vm.expectRevert(TeraSwapFeeCollector.AlreadyBootstrapped.selector);
        fresh.bootstrapRouters(routers);
    }

    // ══════════════════════════════════════════════════════════════
    //  [H-04] minimumOutput validation tests
    // ══════════════════════════════════════════════════════════════

    /// Build a fresh collector + mock router pair for each H-04 test
    function _setupH04() internal returns (TeraSwapFeeCollector c, MockRouter r) {
        c = new TeraSwapFeeCollector(feeRecipient, admin);
        r = new MockRouter();
        address[] memory routers = new address[](1);
        routers[0] = address(r);
        vm.prank(admin);
        c.bootstrapRouters(routers);
    }

    // ── Token→Token: fee deducted, router delivers output ─────

    function test_H04_tokenToToken_outputAboveMin_succeeds() public {
        (TeraSwapFeeCollector c, MockRouter r) = _setupH04();
        MockERC20 tokenIn = new MockERC20("In", "IN");
        MockERC20 tokenOut = new MockERC20("Out", "OUT");

        // Mint inputs to user, outputs to router
        tokenIn.mint(user, 1_000 ether);
        tokenOut.mint(address(r), 950 ether);

        // Router is configured to deliver 950 tokenOut
        r.setPayout(address(tokenOut), 950 ether);

        // User approves collector for full 1000 (includes fee)
        vm.prank(user);
        tokenIn.approve(address(c), 1_000 ether);

        // netAmount = 1000 - (1000 * 10 / 10000) = 1000 - 1 = 999
        bytes memory data = abi.encodeWithSelector(
            MockRouter.execute.selector, address(tokenIn), uint256(999 ether), user
        );

        vm.prank(user);
        c.swapTokenWithFee(address(tokenIn), 1_000 ether, address(r), data, address(tokenOut), 900 ether);

        assertEq(tokenOut.balanceOf(user), 950 ether, "user should receive 950 out");
        assertEq(tokenIn.balanceOf(feeRecipient), 1 ether, "feeRecipient should receive 1 in (0.1%)");
    }

    function test_H04_tokenToToken_outputBelowMin_reverts() public {
        (TeraSwapFeeCollector c, MockRouter r) = _setupH04();
        MockERC20 tokenIn = new MockERC20("In", "IN");
        MockERC20 tokenOut = new MockERC20("Out", "OUT");

        tokenIn.mint(user, 1_000 ether);
        tokenOut.mint(address(r), 800 ether);

        // Router only delivers 800 — below user's minimumOutput of 900
        r.setPayout(address(tokenOut), 800 ether);

        vm.prank(user);
        tokenIn.approve(address(c), 1_000 ether);

        bytes memory data = abi.encodeWithSelector(
            MockRouter.execute.selector, address(tokenIn), uint256(999 ether), user
        );

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(TeraSwapFeeCollector.InsufficientOutput.selector, 800 ether, 900 ether)
        );
        c.swapTokenWithFee(address(tokenIn), 1_000 ether, address(r), data, address(tokenOut), 900 ether);
    }

    function test_H04_tokenToToken_minOutputZero_skipsCheck() public {
        // Backward-compat path: when minimumOutput == 0, the check is disabled
        // even if the router returns less than anything.
        (TeraSwapFeeCollector c, MockRouter r) = _setupH04();
        MockERC20 tokenIn = new MockERC20("In", "IN");
        MockERC20 tokenOut = new MockERC20("Out", "OUT");

        tokenIn.mint(user, 1_000 ether);
        tokenOut.mint(address(r), 1 wei); // router delivers essentially nothing

        r.setPayout(address(tokenOut), 1 wei);

        vm.prank(user);
        tokenIn.approve(address(c), 1_000 ether);

        bytes memory data = abi.encodeWithSelector(
            MockRouter.execute.selector, address(tokenIn), uint256(999 ether), user
        );

        vm.prank(user);
        c.swapTokenWithFee(address(tokenIn), 1_000 ether, address(r), data, address(tokenOut), 0);

        assertEq(tokenOut.balanceOf(user), 1 wei, "user receives the (tiny) router output; no check enforced");
    }

    // ── ETH→Token: user sends ETH, expects ERC-20 output ──────

    function test_H04_ethToToken_outputAboveMin_succeeds() public {
        (TeraSwapFeeCollector c, MockRouter r) = _setupH04();
        MockERC20 tokenOut = new MockERC20("Out", "OUT");
        tokenOut.mint(address(r), 2_900 ether);

        vm.deal(user, 1 ether);

        // Router delivers 2900 tokenOut for 1 ETH input
        r.setPayout(address(tokenOut), 2_900 ether);

        // ETH input: router doesn't need to pullAmount an ERC-20, so tokenIn=0
        bytes memory data = abi.encodeWithSelector(
            MockRouter.execute.selector, address(0), uint256(0), user
        );

        vm.prank(user);
        c.swapETHWithFee{value: 1 ether}(address(r), data, address(tokenOut), 2_800 ether);

        assertEq(tokenOut.balanceOf(user), 2_900 ether, "user should receive 2900 out");
        assertEq(feeRecipient.balance, 0.001 ether, "fee: 1 ETH * 0.1% = 0.001 ETH");
    }

    function test_H04_ethToToken_outputBelowMin_reverts() public {
        (TeraSwapFeeCollector c, MockRouter r) = _setupH04();
        MockERC20 tokenOut = new MockERC20("Out", "OUT");
        tokenOut.mint(address(r), 2_000 ether);

        vm.deal(user, 1 ether);

        // Router delivers only 2000 — below minimumOutput of 2800
        r.setPayout(address(tokenOut), 2_000 ether);

        bytes memory data = abi.encodeWithSelector(
            MockRouter.execute.selector, address(0), uint256(0), user
        );

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(TeraSwapFeeCollector.InsufficientOutput.selector, 2_000 ether, 2_800 ether)
        );
        c.swapETHWithFee{value: 1 ether}(address(r), data, address(tokenOut), 2_800 ether);
    }

    // ── Token→ETH: ERC-20 input, ETH output ────────────────────

    function test_H04_tokenToEth_outputAboveMin_succeeds() public {
        (TeraSwapFeeCollector c, MockRouter r) = _setupH04();
        MockERC20 tokenIn = new MockERC20("In", "IN");
        tokenIn.mint(user, 1_000 ether);

        // Fund the router with ETH so it can pay out
        vm.deal(address(r), 1 ether);
        r.setPayout(address(0), 0.5 ether);

        vm.prank(user);
        tokenIn.approve(address(c), 1_000 ether);

        bytes memory data = abi.encodeWithSelector(
            MockRouter.execute.selector, address(tokenIn), uint256(999 ether), user
        );

        uint256 ethBefore = user.balance;
        vm.prank(user);
        c.swapTokenWithFee(address(tokenIn), 1_000 ether, address(r), data, address(0), 0.4 ether);

        assertEq(user.balance - ethBefore, 0.5 ether, "user should receive 0.5 ETH");
    }

    function test_H04_tokenToEth_outputBelowMin_reverts() public {
        (TeraSwapFeeCollector c, MockRouter r) = _setupH04();
        MockERC20 tokenIn = new MockERC20("In", "IN");
        tokenIn.mint(user, 1_000 ether);

        vm.deal(address(r), 1 ether);
        r.setPayout(address(0), 0.3 ether); // only 0.3 ETH delivered

        vm.prank(user);
        tokenIn.approve(address(c), 1_000 ether);

        bytes memory data = abi.encodeWithSelector(
            MockRouter.execute.selector, address(tokenIn), uint256(999 ether), user
        );

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(TeraSwapFeeCollector.InsufficientOutput.selector, 0.3 ether, 0.5 ether)
        );
        c.swapTokenWithFee(address(tokenIn), 1_000 ether, address(r), data, address(0), 0.5 ether);
    }

    // ── Event payload includes tokenOut and actual output ─────

    function test_H04_eventEmitsOutputFields() public {
        (TeraSwapFeeCollector c, MockRouter r) = _setupH04();
        MockERC20 tokenIn = new MockERC20("In", "IN");
        MockERC20 tokenOut = new MockERC20("Out", "OUT");

        tokenIn.mint(user, 1_000 ether);
        tokenOut.mint(address(r), 950 ether);
        r.setPayout(address(tokenOut), 950 ether);

        vm.prank(user);
        tokenIn.approve(address(c), 1_000 ether);

        bytes memory data = abi.encodeWithSelector(
            MockRouter.execute.selector, address(tokenIn), uint256(999 ether), user
        );

        vm.expectEmit(true, true, false, true, address(c));
        emit TeraSwapFeeCollector.SwapWithFee(
            user, address(r), address(tokenIn), 1_000 ether, 1 ether, address(tokenOut), 950 ether
        );

        vm.prank(user);
        c.swapTokenWithFee(address(tokenIn), 1_000 ether, address(r), data, address(tokenOut), 900 ether);
    }
}
