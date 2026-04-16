// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../TeraSwapFeeCollector.sol";

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
}
