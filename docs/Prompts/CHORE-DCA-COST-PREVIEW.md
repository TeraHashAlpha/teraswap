# CHORE-DCA-COST-PREVIEW — per-buy fee + network cost preview at DCA creation

> **Source:** transparency-brand follow-up to FILL-ECONOMICS-CALIBRATION.md. Display + one backlog
> bug-fix; no fund-flow, no Auditor gate. Branch `chore/dca-cost-preview`, worktree under
> `.claude/worktrees/`.

## Commit 0 — verify-first
Grepped DCAPanel + DCA components for any existing per-buy cost/fee preview. **Absent** — the
existing "Per buy" summary line shows only the token amount (`perPart`), never a fee/network-cost
breakdown. Proceeding to build.

Separately checked item 2 (the `/api/orders/stats` `recentExecutions24h` column bug): **already
fixed** in commit `79bd6ec` ("fix(api): correct order_executions schema in /api/orders/stats"),
with an existing regression test (`route.test.ts`) covering both the `created_at` (not
`executed_at`) filter and the `orders!inner(wallet)` join (not a `wallet` column on
`order_executions`). No action taken — rebuilding it would duplicate shipped work.

## Requirement 1 — cost preview
New pure module `src/lib/order-engine/dca-cost-preview.ts`:
- `computeDcaCostPreview({ perChunkNotionalUsd })`: fee = `perChunkNotionalUsd × ORDER_FEE_BPS /
  ORDER_BPS_DENOMINATOR` (the SAME constants `canonical-route.ts` already mirrors from the
  deployed contract's `FEE_BPS`, imported — not a new literal). Returns `null` for
  null/NaN/zero/negative/Infinity input (hidden, never fabricated).
- `DCA_NETWORK_COST_ESTIMATE_USD = 0.07`: sourced from FILL-ECONOMICS-CALIBRATION.md's measured
  aggregator gas (1,364,707/1,347,595 units) applied to the keeper's post-fix Base NORMAL tier
  (`gas-tier.js`, 0.02 gwei priority + baseFee×2), landing at the upper end of the report's stated
  $0.03–$0.07 post-fix range — the conservative choice for a line that says "covered by TeraSwap".
- `DCA_NETWORK_COST_COVERAGE_LABEL = 'covered by TeraSwap'`: single source for the v3-truth phrase
  (keeper pays gas today); v4 (ADR-015 D2) changes this to a user-paid, capped charge — one
  constant to update then, not a grep-and-replace.

Wired into `DCAPanel.tsx`'s Summary block: a `data-testid="dca-cost-preview"` line, shown only
once `costPreview` is non-null (whole-DCA total priced AND buy count known), reading "0.1%
protocol fee (~$X) + network cost (~$Y, covered by TeraSwap)". Never the word "free"/"gasless".

## Requirement 2 — stats bug
Already fixed (see commit 0). No change.

## Tests
`dca-cost-preview.test.ts` (11): fee math traced to `ORDER_FEE_BPS` (not an independent 0.001
literal), linear scaling, network-cost constant flat across sizes + within the stated range,
coverage label sourced, no "free"/"gasless" anywhere in the serialized output, null on every
invalid input shape. `DCAPanel.cost-preview.test.tsx` (5): hidden with no amount, correct fee math
against the real `DEFAULT_TOKENS`/`APPROX_PRICES`/`DCA_TOTAL_PRESETS` (WETH @ $3500, default 10
buys), scales with a smaller chunk, no "free"/"gasless" in the preview or anywhere on the page.
Existing DCAPanel suites (44 tests, 5 files) and the stats route test untouched-green.

## Do NOT
Touched: `src/lib/order-engine/dca-cost-preview.ts` (+test), `index.ts` (barrel export),
`DCAPanel.tsx` (+test), this spec. Nothing else — no keeper/contract/signing/order-creation logic,
no reintroduction of the reverted `$` budget field, no new deps, no un-sourced magic numbers.
