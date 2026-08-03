# CHORE-ANALYTICS-DCA-EXECUTIONS — include DCA/order executions in Analytics

## Context
A DCA chunk executed on-chain (order 4ed3d6de, WETH→UNI via Velora/Augustus, tx
`0x4691b42a570290c84c63c23f702d258e2bc766f5078dc312eb32400d169d7fac`) but it does NOT appear in the Analytics
tab — Protocol Volume, # trades, Best Routes, Popular Pairs, Volume Trend, and Recent Activity only reflect
**instant swaps**. Keeper `executeOrder` runs through a different path and isn't recorded in the source
Analytics reads from. DCA (and limit / stop-loss) executions are real protocol volume and must be counted.

## Objective
Include order-engine executions (DCA + limit + SL) in Analytics across all periods (All Time / 24H / 7D / 30D),
with correct USD volume, trade count, route/source, pair, and a Recent-Activity entry — without double-counting
instant swaps.

## Requirements
1. **Map the data flow:** find where Analytics reads (the analytics API/query + its table(s) — likely a
   `swaps`/trades table) AND where a keeper execution is currently recorded (keeper → Supabase; e.g.
   `order_executions`).
2. **Record each successful order execution as an analytics trade** — choose the cleaner of: (a) the keeper
   writes a trade row on `executeOrder` success into the table Analytics reads, or (b) the analytics query
   UNIONs `order_executions`. Each execution must carry: **USD volume** (use the SAME valuation method as
   instant swaps — no fabricated values), **source/route** actually used (e.g. Velora/Augustus), tokenIn/
   tokenOut **pair**, wallet, **tx hash**, timestamp, chainId. **No double-counting** with instant swaps.
3. **Recent Activity** shows DCA executions, labelled distinctly (e.g. "DCA" vs "Swap"), with route + time +
   tx link.
4. **Best Routes, Popular Pairs, Volume Trend, totals** all include order executions.
5. **Backfill** the already-executed chunk (4ed3d6de, tx `0x4691b42a…d7fac`) if feasible so it shows
   retroactively.
6. **Chain-aware:** Base executions count + are labelled with the right chain.

## Do NOT
- Don't change the contract. Don't double-count executions vs instant swaps. No fabricated USD values (reuse
  the instant-swap valuation). Don't regress the instant-swap analytics.

## Files affected (verify on main)
- The Analytics API/query + the table(s) it reads.
- The keeper's execution recording (`contracts/order-engine/executor/executor.js`) + the Supabase schema
  (`order_executions` / a unified trades table).

## Expected output
- Branch `chore/analytics-dca-executions` off latest `origin/main`; SSH-signed; CI green; tests (a DCA
  execution appears in volume/trades/routes/pairs/recent-activity once, not twice); FEEDBACK with the data-flow
  map + whether backfill was applied. No Auditor (reporting/read-side; flag if any write touches fund-flow).

## Quality criteria
A DCA chunk execution shows in Analytics exactly once with correct USD volume, route, pair, and a Recent-Activity
entry; instant-swap analytics unchanged; chain-correct.
