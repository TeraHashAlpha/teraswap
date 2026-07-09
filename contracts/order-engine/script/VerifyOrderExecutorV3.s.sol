// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
}

interface IOrderExecutorV3 {
    function admin() external view returns (address);
    function feeRecipient() external view returns (address);
    function WETH() external view returns (address);
    function sequencerUptimeFeed() external view returns (address);
    function paused() external view returns (bool);
    function bootstrapped() external view returns (bool);
    function whitelistedRouters(address) external view returns (bool);
    function MAX_ORDER_SLIPPAGE_BPS() external view returns (uint16);
    function domainSeparator() external view returns (bytes32);
    function tokenUsdFeeds(address token) external view returns (
        address feed, uint8 feedDecimals, uint8 tokenDecimals, uint256 maxStaleness, bool registered
    );
}

/**
 * @title VerifyOrderExecutorV3
 * @notice [SPRINT-V3-P4 / ADR-013 deploy step] READ-ONLY post-deploy verifier — no state-changing calls,
 *         no --broadcast needed. The owner runs this at EVERY runbook checkpoint (post-deploy, post-
 *         oracle-config) per docs/Runbooks/V3-EXECUTOR-DEPLOY.md.
 *
 * Deliberately takes every "should be X" value as an INPUT to check against, never hardcodes an address
 * the runbook says must be re-verified (the Sprint-46 "labels lie" lesson — a script that embeds a router
 * address is exactly as trustable as a doc citation; a script that CHECKS a caller-supplied address
 * against on-chain state is not). Reverts with a descriptive message and a non-zero exit code on the
 * FIRST failing assertion — run it again after fixing to confirm the rest.
 *
 * Usage (see the runbook for the full invocation with real values):
 *   forge script script/VerifyOrderExecutorV3.s.sol:VerifyOrderExecutorV3 \
 *     --rpc-url <chain rpc> \
 *     --sig "run(address,address,address[],address,uint256)" \
 *     <executor> <expectedAdmin> "[<expectedRouter1>,...]" <expectedSequencerFeed> <expectedChainId>
 *
 * A second entrypoint, checkOracleFeed, is provided for the post-oracle-config checkpoint (run once per
 * configured token — see the runbook §4).
 */
contract VerifyOrderExecutorV3 is Script {
    // EIP-712 domain typehash (standard, matches OZ's EIP712 base the contract inherits).
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    string internal constant DOMAIN_NAME = "TeraSwapOrderExecutor";
    string internal constant DOMAIN_VERSION = "3";
    uint16 internal constant EXPECTED_MAX_SLIPPAGE_BPS = 500;

    /// @notice Core post-deploy checks: owner/admin, immutable cap, router whitelist, sequencer feed,
    ///         init/pause state, EIP-712 domain. Run after §2 (Deploy) and again after §3 (Verify) —
    ///         idempotent, no state changes.
    /// @param executor The deployed TeraSwapOrderExecutorV3 address.
    /// @param expectedAdmin The admin address the runbook says this deploy should have (§0 input).
    /// @param expectedRouters EVERY router this deploy's bootstrap should have whitelisted — checked
    ///        individually. This script does NOT enumerate "every other address is false" (that requires
    ///        an off-chain event scan of the Bootstrap/RouterWhitelisted events, a manual runbook step,
    ///        not a single on-chain read) — it only confirms the EXPECTED set is present.
    /// @param expectedSequencerFeed The Chainlink L2 sequencer-uptime feed the runbook says this chain
    ///        should use (address(0) for mainnet).
    /// @param expectedChainId The chain this deploy is supposed to be on.
    function run(
        address executor,
        address expectedAdmin,
        address[] calldata expectedRouters,
        address expectedSequencerFeed,
        uint256 expectedChainId
    ) external view {
        require(executor.code.length > 0, "VERIFY FAIL: executor has no code at this address");
        require(block.chainid == expectedChainId, "VERIFY FAIL: connected RPC chain does not match expectedChainId");

        IOrderExecutorV3 oe = IOrderExecutorV3(executor);

        require(oe.admin() == expectedAdmin, "VERIFY FAIL: admin() != expectedAdmin");
        console2.log("[OK] admin ==", expectedAdmin);

        require(oe.MAX_ORDER_SLIPPAGE_BPS() == EXPECTED_MAX_SLIPPAGE_BPS, "VERIFY FAIL: MAX_ORDER_SLIPPAGE_BPS != 500");
        console2.log("[OK] MAX_ORDER_SLIPPAGE_BPS == 500 (compile-time constant, no setter)");

        for (uint256 i = 0; i < expectedRouters.length; i++) {
            require(oe.whitelistedRouters(expectedRouters[i]), "VERIFY FAIL: expected router not whitelisted");
            console2.log("[OK] router whitelisted:", expectedRouters[i]);
        }
        require(expectedRouters.length > 0, "VERIFY FAIL: no expected routers supplied - refusing to pass trivially");

        require(oe.sequencerUptimeFeed() == expectedSequencerFeed, "VERIFY FAIL: sequencerUptimeFeed != expected");
        console2.log("[OK] sequencerUptimeFeed ==", expectedSequencerFeed);

        require(oe.bootstrapped(), "VERIFY FAIL: bootstrapped() is false - bootstrap() has not run yet");
        console2.log("[OK] bootstrapped == true");

        require(!oe.paused(), "VERIFY FAIL: paused() is true - contract is emergency-paused");
        console2.log("[OK] paused == false");

        bytes32 expectedDomainSeparator = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes(DOMAIN_NAME)),
            keccak256(bytes(DOMAIN_VERSION)),
            block.chainid,
            executor
        ));
        require(
            oe.domainSeparator() == expectedDomainSeparator,
            "VERIFY FAIL: domainSeparator() does not match the expected (name,version,chainId,verifyingContract) tuple - frontend signing would silently fail"
        );
        console2.log("[OK] EIP-712 domain separator matches (name, version 3, chainId, verifyingContract)");

        console2.log("ALL CHECKS PASSED for", executor);
    }

    /// @notice Post-oracle-config checkpoint (runbook §4, after each executeTokenUsdFeed): confirms a
    ///         registered token->USD feed answers with a fresh round and the recorded decimals actually
    ///         match what the feed itself reports right now (catches a feed that was valid at
    ///         registration time but has since been redeployed/changed behind the same address).
    /// @param executor The deployed TeraSwapOrderExecutorV3 address.
    /// @param token The token whose feed was just configured.
    /// @param maxAgeSeconds Fail if the feed's last update is older than this (use the same staleness
    ///        bound the runbook queued, or MAX_STALENESS's 300s default if maxStaleness was 0).
    function checkOracleFeed(address executor, address token, uint256 maxAgeSeconds) external view {
        IOrderExecutorV3 oe = IOrderExecutorV3(executor);
        (address feed, uint8 feedDecimals, uint8 tokenDecimals, , bool registered) = oe.tokenUsdFeeds(token);

        require(registered, "VERIFY FAIL: token not registered in tokenUsdFeeds (executeTokenUsdFeed did not run, or reverted)");
        console2.log("[OK] token registered:", token);

        require(feed != address(0), "VERIFY FAIL: registered feed is the zero address");
        require(feedDecimals == 8 || feedDecimals == 18, "VERIFY FAIL: recorded feedDecimals is neither 8 nor 18");
        require(tokenDecimals >= 1 && tokenDecimals <= 18, "VERIFY FAIL: recorded tokenDecimals out of ERC-20 range");

        uint8 liveFeedDecimals = IAggregatorV3(feed).decimals();
        require(liveFeedDecimals == feedDecimals, "VERIFY FAIL: feed's live decimals() no longer matches what was registered - feed may have been redeployed");
        console2.log("[OK] feed decimals match:", feedDecimals);

        (, int256 answer, , uint256 updatedAt, ) = IAggregatorV3(feed).latestRoundData();
        require(answer > 0, "VERIFY FAIL: feed's latestRoundData answer <= 0");
        require(block.timestamp - updatedAt <= maxAgeSeconds, "VERIFY FAIL: feed's last update is stale beyond maxAgeSeconds");
        console2.log("[OK] feed answers positively and freshly, answer =", uint256(answer));

        console2.log("ALL ORACLE CHECKS PASSED for token", token);
    }
}
