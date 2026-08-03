# CHORE-KEEPER-RECORD-EXECUTIONS — keeper must record each on-chain execution to the DB (fixes analytics + UI progress)

## Context
A DCA chunk executed on-chain (order 4ed3d6de, tx
`0x4691b42a570290c84c63c23f702d258e2bc766f5078dc312eb32400d169d7fac`) but it does NOT appear in Analytics, and
the UI still shows **"0 of 3 buys"**. Both symptoms share one root cause: **the keeper executes `executeOrder`
on-chain but does not record the execution back to the DB** — neither an `order_executions` row nor the order's
exec-count/status. #228 (analytics) correctly reads `order_executions`, but that table is empty for keeper
executions, so analytics + UI progress are both blind. (This is the #226 FEEDBACK "DB↔on-chain execCount
discrepancy" — but it's not just a display lag; nothing is written.)

## Objective
After a successful on-chain `executeOrder`, the keeper records the execution to the DB so that (a) the order's
on-chain progress is reflected (UI "N of M"), and (b) Analytics counts the fill (via the #228 `order_executions`
read).

## Requirements
1. **On executeOrder success, the keeper writes an `order_executions` row** with everything #228 + the UI need:
   order id, chunk index / exec count, tokenIn/tokenOut, amountIn (per-chunk), amountOut received, source/route
   used, **tx hash**, block/timestamp, chainId, and the USD value fields #228 expects (or the inputs it derives
   USD from — keep it consistent with #228's valuation, no double-count).
2. **Update the parent order's progress**: increment exec count / set status (active → completed when the last
   chunk fills) so the UI shows "N of M" correctly and the order closes when done.
3. **Idempotent / no double-write**: keyed by tx hash (or order+execIndex) so a retry or re-confirm doesn't
   insert twice. Only record CONFIRMED executions (tx mined + success), not "tx sent".
4. **Backfill** the already-executed chunk (order 4ed3d6de, tx `0x4691b42a…d7fac`) so it shows retroactively in
   both Analytics and the order's progress.
5. **Verify end-to-end**: a fresh Base DCA chunk executes → an `order_executions` row appears → the UI shows
   "1 of 3" → Analytics counts the fill once (volume/trades/Best Routes/Recent Activity). Confirm chunks 2/3
   advance the count.

## Do NOT
- Don't change the contract. Don't double-count vs #228 / instant swaps. Don't record un-confirmed txs. Keep
  the USD valuation consistent with #228 (no fabrication).

## Files affected (verify on main)
- `contracts/order-engine/executor/executor.js` (the post-executeOrder recording path + order-status update).
- Supabase schema (`order_executions` columns the analytics read needs; the order's exec-count/status fields).
- Cross-check `/api/analytics` (#228) reads what the keeper now writes; the UI order-progress read.

## Expected output
- Branch `chore/keeper-record-executions` off latest `origin/main`; SSH-signed; CI green (keeper-tests); tests
  for the recording (idempotent, confirmed-only, status transition); FEEDBACK with the verified Analytics + UI
  result. **Deploy:** keeper `git pull` + `pm2 restart` on EC2 (+ frontend if the UI read changed).

## Quality criteria
A keeper execution writes exactly one `order_executions` row + advances the order's progress; the UI shows real
"N of M"; Analytics counts the fill once; the existing 4ed3d6de chunk is backfilled; idempotent + confirmed-only.
