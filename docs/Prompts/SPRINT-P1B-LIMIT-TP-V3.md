# SPRINT-P1B-LIMIT-TP-V3 — Limit + Take-Profit on OrderExecutorV3 via ADR-014 option (a) (pinned quote-free canonical route)

> **Source:** ADR-014 (2026-07-22) adjudicated by the Architect + owner: **P1b = Limit + Take-Profit NOW on
> option (a)** — pin a QUOTE-FREE canonical UniV3 route at signing (deterministic amounts; what kills
> pinning is quote-derived calldata content, which canonical exactInput lacks); contract unchanged; the
> binding floor stays `max(oracleFloor, signed minAmountOut)` on-chain. **Stop-Loss is DEFERRED to the v4
> contract (owner decision 2026-07-22): its failure mode is inverted (not filling in a crash IS the loss)
> — SL creation must be blocked fail-closed with that reason.** Opportunistic orders (Limit/TP) accept
> "did not fill" as an outcome; the UI says so honestly. Base (8453) only; keeper route-pin work lands
> HERE FIRST (the Arbitrum multi-chain keeper sprint is sequenced after, per SPRINT-48's blocker box).
> **Fund-flow (signing + keeper execution): full Auditor gate — PR UNMERGED until 0C/0H.** SSH-signed;
> branch `sprint/p1b-limit-tp-v3`, dedicated worktree; 5 droppable commits.
> **Exit = push + local suite green + compare link; owner opens the PR.**

## Requirements (per-commit)
1. **Canonical route builder (frontend lib):** deterministic SwapRouter02 exactInput/exactInputSingle
   calldata for the order pair at signing — amountIn = order.amountIn (net path per contract fee
   semantics — read the contract's execute flow to mirror exactly), amountOutMinimum = the SIGNED
   minAmountOut, deadline = order.expiry, recipient = the executor's expected flow (read the contract:
   funds route through the executor; mirror what executeOrder requires), fee tier = the pool chosen at
   creation (documented: pinned tier). ZERO quote-derived bytes. `routerDataHash = keccak256(calldata)`
   goes into the signed struct; the FULL routerData is persisted in Supabase `order_data.routerData`.
   Router = SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481` (already whitelisted on OE_V3 —
   assert against the 2-router set, never widen).
2. **Frontend orders:** re-enable the Limit tab + TP condition path on Base, v3-signed only
   (`resolveSigningExecutor` + the ADR-013 domain): orderType/condition per the contract's enums;
   `minAmountOut` derived from the user's target price × (1 − maxSlippageBps); the $5-economic-floor
   pre-flight runs BEFORE approve (fold the lesson from BUG order-of-operations). **SL creation blocked**
   (UI hides it + API rejects with "Stop-Loss ships with the v4 executor" — test-pinned). Honest copy:
   "executes when your price is met IF the pinned route is viable; otherwise stays open".
3. **Keeper (executor.js + executor-routing):** non-DCA v3 execution — when `_checkPriceCondition` would
   pass (keeper-side pre-check via the order's feed), submit `executeOrder` with the STORED routerData
   verbatim (hash must match — never rebuild); revert at trigger ⇒ order stays active, retry next cycles
   with backoff + `alertOps` after N consecutive route reverts (liveness telemetry, not silent);
   respect existing gas tiers + Phase-0 policies. No changes to the DCA path.
4. **API/verification:** `/api/orders` accepts non-DCA v3 orders only with a routerDataHash that matches
   the stored routerData, router ∈ the served 2-router set, SL rejected; signature verification unchanged
   (same resolver).
5. **Tests (invariant-grade):** route builder determinism (same inputs ⇒ same bytes, no Date/quote
   inputs); hash-match enforcement (tampered routerData rejected API-side and revert-verified against the
   contract in a fork test if the harness exists — else unit-level); SL blocked at UI + API; predicate
   parity (approve spender == signing executor for non-DCA v3 — extend the PASS2 invariant tests);
   keeper retry/backoff/alerting; DCA paths byte-identical; full suite + tsc + eslint green.

## Do NOT
Touch the contract; widen the router whitelist; enable SL anywhere; touch DCA execution logic, Arbitrum
config (SPRINT-48 owns it), mainnet paths; quote-derived calldata of ANY kind in pinned routes; open a PR.

## Files affected (read ONLY these + new)
`src/lib/order-engine/**` (route builder NEW + config surgical), `src/components/LimitOrderPanel.tsx` +
`ConditionalOrderPanel.tsx` (TP path) + their tests, `src/hooks/useOrderEngine.ts` (non-DCA signing),
`src/app/api/orders/route.ts`, `contracts/order-engine/executor/executor.js` + `executor-routing.js` +
keeper tests, `docs/Prompts/SPRINT-P1B-LIMIT-TP-V3.md`. Read-only: TeraSwapOrderExecutorV3.sol (ground
truth for §2b/fees/flow), ADR-014, PR #301/#299 FEEDBACK.

## Expected output
Branch pushed + compare link. FEEDBACK ≤1 screen: the canonical calldata layout (fields + why each is
deterministic), keeper retry/alert design, SL block evidence, test list. **Flag for the FULL Auditor gate
(0C/0H before merge; Opus).**

## Quality criteria
Deterministic pinned routes (provably quote-free); hash-match enforced end-to-end; SL fail-closed with
the ADR reason; honest liveness copy; DCA untouched; keeper telemetry on route reverts; suite green.
