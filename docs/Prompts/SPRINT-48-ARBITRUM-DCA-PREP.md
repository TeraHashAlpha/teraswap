# SPRINT-48-ARBITRUM-DCA-PREP — DCA-on-Arbitrum groundwork: v3 executor plumbing + gate generalization + deploy runbook (DARK)

> **Source:** owner greenlight 2026-07-21, parallel with the P1b design gate (ADR-014). Goal: everything
> needed so the OWNER can later deploy OrderExecutorV3 on Arbitrum One (42161) and flip DCA live there —
> shipped DARK (no deploy, no env flips, no keeper changes in this sprint). Mirrors the PROVEN Base arc
> (SPRINT-V3-P4 + 46/47 patterns). **Keeper multi-chain work is explicitly OUT (sequenced after the P1b
> keeper decision to avoid executor.js conflicts).** Per [[feedback_address_hygiene]]: every 42161 address
> flows from `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` or fresh two-RPC verified reads — zero
> hand-typed hex. Gate-adjacent (isDcaLive generalization) but strictly fail-closed → Auditor note in the
> PR body; the DEPLOY itself gets its own pre-deploy Auditor gate later (pattern: AUDIT-V3-PREDEPLOY).
> SSH-signed; branch `sprint/48-arbitrum-dca-prep`, dedicated worktree; 4 droppable commits.
> **Exit = push + compare link; owner opens the PR.** NOTE: expect a trivial merge overlap with P1b work
> in `src/lib/order-engine/config.ts` — keep this sprint's touch surgical (map entry + gate only).

## Requirements (per-commit)
1. **Executor plumbing (dark):** `ORDER_EXECUTOR_V3_BY_CHAIN[42161]` = env
   `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM` with `|| null` fail-closed default (exact Base
   pattern); domain builders/registry accept 42161 when non-null. Unset ⇒ byte-identical dark state
   (regression evidence in tests).
2. **Gate generalization:** replace the `isDcaLive` hard pin `chainId===8453` with an explicit
   compile-time allowlist `DCA_CHAINS = [8453, 42161]` AND-ed with `getOrderExecutorV3(chainId) !== null`
   AND the existing `NEXT_PUBLIC_DCA_ENABLED` flag semantics. Mainnet MUST remain excluded even though a
   v2 executor exists there (the original leak the pin prevented — encode as a test). All fail-closed.
3. **Deploy runbook `docs/Runbooks/ARBITRUM-V3-EXECUTOR-DEPLOY.md`** adapted from V3-EXECUTOR-DEPLOY.md:
   §0 inputs from the MANIFEST (Arbitrum WETH, sequencer uptime feed 42161, feeRecipient, admin), router
   whitelist = EXACTLY 2 (Augustus V6.2 + SwapRouter02-42161 from the manifest — M-C rationale: only what
   /api/swap serves AND the keeper can build), bootstrap incl. KMS keeper executor; oracle config
   queue/execute for the 5 feed-covered launch tokens (feeds from the manifest) with the 48h timelock +
   the DAI-saga lesson baked in (actionIds re-extracted from receipts programmatically at use time, never
   from tables); verifier script invocation chain-parameterized; §cutover notes keeper env
   (`ORDER_EXECUTOR_V3_ADDRESS` is per-chain? document the multi-chain keeper dependency as a BLOCKER
   box: "requires the post-P1b keeper multi-chain sprint"); real-domain-smoke lesson; rollback = unset
   frontend env only. Pre-deploy hard gates listed: manifest verification fresh-block pass + Auditor
   pre-deploy pass (0C/0H) + keeper multi-chain merged.
4. **Verifier/scripts chain-awareness + tests:** whatever `VerifyOrderExecutorV3` / deploy scripts assume
   Base (RPC, sequencer feed, router set) becomes parameterized (script args, no hardcoded chain values);
   tests: 42161 dark-state regression, gate allowlist matrix (1/8453/42161 × env set/unset × flag),
   existing suites untouched-green.

## Do NOT
Deploy; flip any env; touch executor.js/keeper, DCAPanel UX, v2 paths, mainnet config; widen the router
set beyond 2; hand-type hex; open a PR.

## Files affected (read ONLY these + new)
`src/lib/order-engine/config.ts` (map entry + gate — surgical), gate tests,
`contracts/order-engine/script/*` (parameterization only), NEW `docs/Runbooks/ARBITRUM-V3-EXECUTOR-DEPLOY.md`,
`docs/Prompts/SPRINT-48-ARBITRUM-DCA-PREP.md`. Read-only: `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json`,
`docs/Runbooks/V3-EXECUTOR-DEPLOY.md`, `src/lib/chains/**` (no edits).

## Expected output
Branch pushed + compare link. FEEDBACK ≤1 screen: the map+gate diff summary, the runbook §0 table (values
← manifest), scripts parameterized, test matrix. Auditor note for the PR body (dark, fail-closed, deploy
separately gated).
