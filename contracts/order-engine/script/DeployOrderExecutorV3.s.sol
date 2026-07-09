// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../TeraSwapOrderExecutorV3.sol";

/**
 * @title DeployOrderExecutorV3
 * @notice [SPRINT-V3-P4 / ADR-013 deploy step] Foundry deploy script for TeraSwapOrderExecutorV3.
 *
 * RUNBOOK ONLY — see docs/Runbooks/V3-EXECUTOR-DEPLOY.md for the full pre-flight gate, oracle-config
 * timelock steps, cutover, and rollback. This script does exactly one thing: broadcast the constructor
 * call with explicit, environment-supplied parameters. It does NOT bootstrap routers/executors or
 * configure oracle feeds — those are separate, explicit runbook steps (bootstrap is one-shot and oracle
 * config is timelocked; neither belongs in an unattended script).
 *
 * Every constructor input is read from an environment variable BY NAME (never hardcoded, never a default
 * that silently picks a production address) — the runbook is the single source of truth for what those
 * values should be, verified fresh at deploy time, not baked into this file.
 *
 * Signing: use `--account <keystore>` (or `--ledger`) with `forge script ... --broadcast`, exactly like
 * the existing BASE-ORDEREXECUTOR-DEPLOY.md / AWS-KMS-EXECUTOR-SETUP.md runbooks. This script refuses to
 * run if it detects a plaintext PRIVATE_KEY env var (the CHORE-EXECUTOR-KEY-GUARD posture, ported to the
 * deploy path — a deploy tx is exactly the kind of high-stakes signature a plaintext key should never
 * produce on a production chain) unless explicitly overridden via ALLOW_PLAINTEXT_KEY /
 * ALLOW_PLAINTEXT_KEY_MAINNET, mirroring the keeper's own env-var names.
 */
contract DeployOrderExecutorV3 is Script {
    function run() external returns (TeraSwapOrderExecutorV3 executor) {
        // ── Plaintext-key guard (mirrors executor.js's CHORE-EXECUTOR-KEY-GUARD) ──
        // forge script's own --account/--ledger flags never pass through env vars, so this only ever
        // fires on the specific footgun of ALSO setting PRIVATE_KEY (e.g. copy-pasted from a keeper
        // .env.executor) — the exact mistake this guard exists to catch before it signs a deploy tx.
        try vm.envString("PRIVATE_KEY") returns (string memory pk) {
            if (bytes(pk).length > 0) {
                bool allowPlaintext = vm.envOr("ALLOW_PLAINTEXT_KEY", false)
                    || vm.envOr("ALLOW_PLAINTEXT_KEY_MAINNET", false);
                require(
                    allowPlaintext,
                    "PRIVATE_KEY env var set - use --account <keystore> or --ledger instead. "
                    "Set ALLOW_PLAINTEXT_KEY=true to override (DANGEROUS, do not use on a production chain)."
                );
            }
        } catch {
            // PRIVATE_KEY not set at all - the expected, safe path (signing via --account/--ledger).
        }

        // ── Chain-id assertion — never deploy to the wrong chain from a misconfigured --rpc-url ──
        uint256 expectedChainId = vm.envUint("EXPECTED_CHAIN_ID");
        require(block.chainid == expectedChainId, "chain-id mismatch: --rpc-url does not match EXPECTED_CHAIN_ID");

        // ── Constructor params — by NAME, from env, no defaults ──
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        address admin = vm.envAddress("ADMIN");
        address weth = vm.envAddress("WETH_ADDRESS");
        // Mainnet has no L2 sequencer: pass SEQUENCER_UPTIME_FEED=0x0000000000000000000000000000000000000000
        // explicitly (per the runbook's mainnet deferred-template table) — never silently defaulted here.
        address sequencerUptimeFeed = vm.envAddress("SEQUENCER_UPTIME_FEED");

        vm.startBroadcast();
        executor = new TeraSwapOrderExecutorV3(feeRecipient, admin, weth, sequencerUptimeFeed);
        vm.stopBroadcast();

        console2.log("TeraSwapOrderExecutorV3 deployed:", address(executor));
        console2.log("  feeRecipient:", feeRecipient);
        console2.log("  admin:", admin);
        console2.log("  WETH:", weth);
        console2.log("  sequencerUptimeFeed:", sequencerUptimeFeed);
        console2.log("  chainId:", block.chainid);
        console2.log("NEXT: bootstrap(routers, executors) once (see the runbook, Step 2/3) - NOT done by this script.");
    }
}
