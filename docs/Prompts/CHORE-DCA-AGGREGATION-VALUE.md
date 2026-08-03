# CHORE-DCA-AGGREGATION-VALUE — show the value TeraSwap's aggregation delivered per DCA buy

> **Source:** owner decision 2026-07-23. Keeper writes additive telemetry it already has (does NOT
> change what/how a fill executes) → Auditor NOTE in the PR body, not a full gate. Forward-only by
> design. Branch `chore/dca-aggregation-value`, worktree under `.claude/worktrees/`.

## Goal
Show the user the VALUE our aggregation delivered per DCA buy = best route vs the next-best
source, gross-vs-gross (always ≥ 0), with the 0.1% protocol fee on its own separate line.
Baseline = next-best source quote (not oracle fair value, which a taker always lands below).
Accuracy invariant: honest, from recorded data, never overstated; no runner-up → "—".

## Commit 1 — keeper records the baseline (forward-only, best-effort, non-blocking)
`fetchBestQuote` (executor.js) already GETs the unconstrained `/api/quote` meta-quote every DCA
cycle for the deviation guard — the response already includes `all` (every source, sorted
best-first). Extended to also return the runner-up (`all[1]`) from that SAME response (one HTTP
call, one quote round — never a second fetch that could land in a different round). Threaded via
per-order-scoped `dcaNextBestOut`/`dcaNextBestSource` variables from the pre-execution
deviation-guard block to the POST-execution recording call (`buildExecutionRow` /
`recordExecutionRow`), which already runs after the fill is confirmed on-chain and whose failure
was already non-fatal to the fill (`executed++` runs unconditionally after).

New nullable `order_executions` columns `next_best_out` / `next_best_source`
(`supabase/migrations/20260723231005_dca_aggregation_value.sql`, mirrored in `schema.sql`).
`buildExecutionRow` only sets them when BOTH are present together (a malformed amount-without-
source pair is dropped, not persisted half-formed). `price_at_execution` untouched.

**Bug found and fixed while proving "recording never blocks a fill":** `recordExecutionRow`'s
insert POST was the one call in that function not wrapped in try/catch — a hard network failure
(as opposed to a non-ok HTTP response, already handled) would have thrown out of
`recordExecutionRow` into executor.js's unguarded call site, right after a real, confirmed,
already-executed fill. Fixed to resolve `{recorded:false, error}` on every failure mode, matching
the idempotency check's existing posture. Proven with a test that a rejecting fetch never throws.

## Commit 2 — settlement receipt UI
`settlement-receipt.ts`: `FillSource`/`FillReceipt` carry `nextBestOutRaw`/`nextBestSource`
(passed through verbatim — no on-chain event carries them, unlike every other figure in this
resolver). New `computeAggregationValueRaw(amountOutRaw, nextBestOutRaw)` = `max(0, amountOut −
nextBestOut)`, clamped at 0 rather than allowed negative (the deviation guard bounds drift but
does not guarantee our committed route beats literally every quote every round — 0 is the honest
statement, not a fabricated positive or a demoralizing/dishonest-looking negative). `null` when no
runner-up existed. `computeSettlementTotals.totalAggregationValueRaw` is `null` (not "0") when NO
fill in the position has any comparison data.

`SettlementReceiptModal.tsx`: new "Aggregation value" row in the Totals block (total, or "—") and
a per-fill line: *"Best route: {label} → {amount}. Next-best: {source} → {amount}. Aggregation
value: +{delta}."* — or *"Aggregation value: —"* when `nextBestOutRaw` is null. The protocol fee
stays on its own pre-existing line, never folded in. "Best route" label is resolved from the
ORDER's own committed router address against the chain's whitelisted-router registry (no new
column needed — the router is fixed per order). Never "free", never a guaranteed/absolute claim,
never a named external competitor.

## Commit 3 — tests
Keeper: runner-up recorded when present, both columns omitted when absent or malformed-paired,
network failure during recording resolves (never throws) — proving the fill is unaffected.
UI: exact delta math against a fixture, "—" per-fill and total when no data, fee stays separate,
no "free"/guaranteed/named-competitor language. Existing keeper (240 tests) + receipt (38) + DCA
suites untouched-green.

## Do NOT
Change routing/execution/gas/retry logic; compare to oracle fair value or named competitors;
overstate; block the fill on the recording; add deps; open a PR.
