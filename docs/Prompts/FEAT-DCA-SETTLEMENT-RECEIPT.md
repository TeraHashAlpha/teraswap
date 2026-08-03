# FEAT-DCA-SETTLEMENT-RECEIPT — the exact-costs receipt when a DCA completes or is cancelled

> **Source:** owner product decision 2026-07-23 (execution-economics round): radical fee transparency's
> closing loop — estimates upfront, **EXACT realized numbers at the end**. When a DCA position completes
> (all fills) or is cancelled, the user gets a settlement receipt: per-fill and total, every number from
> the CHAIN, not recomputed. v4-INDEPENDENT — ships now on v3 data (Supabase fills + OrderExecuted events).
> Read-only/display feature → no Auditor gate; **accuracy invariant: fee figures come from the on-chain
> OrderExecuted `fee` field, never recomputed client-side** (a transparency brand cannot show derived
> numbers as facts). SSH-signed; branch `feat/dca-settlement-receipt`, worktree UNDER `.claude/worktrees/`;
> 3 droppable commits. **Exit = push + suite green + compare link; owner opens the PR.**

## Requirements
1. **Data:** a small resolver that, for a completed/cancelled DCA position, assembles per-fill rows from
   Supabase (fill txs) enriched from on-chain receipts/logs: executed amountIn, amountOut, effective price,
   **protocol fee (the OrderExecuted event `fee` field, exact)**, fill tx hash + link, timestamp; plus the
   network cost of each fill tx (receipt gasUsed × effectiveGasPrice + l1Fee) labelled per the v3 truth:
   **"Network cost — covered by TeraSwap"** (in v3 the keeper pays; when v4 ships this line becomes
   "paid by you, capped at $X" — leave the label source in ONE place with a comment). Cache results (the
   data is immutable once final).
2. **UI:** in DCA → Positions history, a completed/cancelled card gains "View receipt": totals (invested,
   received, average price, total protocol fee — exact, total network cost), per-fill table, and
   **"vs your upfront estimate"** where the order's signed budget/bps is shown next to the realized all-in
   %. Copy tone per the transparency brand: plain numbers, no "free", every figure traceable (tx links).
   Export/share: simple "copy as text" only (no PDF machinery in this slice).
3. **Tests:** resolver math against fixture receipts (fee taken from event, NEVER recomputed; totals sum);
   cancelled-position receipt (partial fills); zero-fill cancelled (receipt shows creation+cancel only);
   UI renders totals + rows; existing DCA suites untouched-green.

## Do NOT
Touch keeper, contracts, signing, order creation, fees logic; recompute fees client-side; add heavy deps
(PDF/export libs); open a PR.

## Files affected (read ONLY these + new)
New resolver module under `src/lib/dca/` + tests, the Positions history components (extend) + tests,
`docs/Prompts/FEAT-DCA-SETTLEMENT-RECEIPT.md`. Read-only: OrderExecuted ABI/decoders, Supabase order/fill
schema, `src/lib/order-engine/budget-slippage.ts` (for the estimate comparison).

## Expected output
Branch + compare link. FEEDBACK ≤1 screen: the receipt fields as landed (sample), where each number comes
from (event field / receipt field), the estimate-vs-realized comparison, tests. Owner validates visually on
Preview with his real completed/cancelled positions.
