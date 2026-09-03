# Feedback — perf/keeper-idle-backoff (4ff1965 · ce9c1eb · aca0ece)

## Idle RPC calls per day (0 active orders), before → after

| method | before | after | how |
|---|---|---|---|
| `eth_getLogs` | 2 contracts × 2,880 = **5,760** | 1 × 288 = **288** | one call per poll (T1) × 300 s cadence (T2) |
| `eth_getBalance` | 2 × 2,880 = **5,760** | 1 × 288 = **288** | one read per idle cycle (T3) × 300 s cadence |
| `eth_blockNumber` | **2,880** | **288** | watcher poll at 300 s |
| `eth_call` (ETH/USD) | **2,880** | **288** | inside the full cycle, at 300 s |
| total | **17,280** | **1,152** | **÷15**; `eth_getLogs` (dearest) ÷20 |

2,880 = 86,400 s / 30 s; 288 = 86,400 s / 300 s. A third watched contract (v3) was 8,640 → 288.
Supabase: `unlockStaleOrders` + `fetchActiveOrders` stay at 2 × 2,880 (probe); `circuit_breaker` read drops to 288.

## Constants (`contracts/order-engine/executor/idle-backoff.js`)
`POLL_INTERVAL_MS = 30_000` (unchanged) · `IDLE_POLL_INTERVAL_MS = 300_000` — lower it here; expressed in whole 30 s ticks (ceil).

## Choice — RPC backs off, the DB read does not
Idle ⇒ every 30 s tick is a **Supabase-only probe** (the same two calls a cycle makes, zero RPC); the full cycle + watcher
poll run every 300 s. A probe that finds a row runs the full cycle on that tick, so a new order is noticed **≤ 30 s** after
creation regardless of the idle cadence (a fresh stop-loss is not blind for 5 min). ≥ 1 order ⇒ every tick is today's cycle.

## Outflow-detection delay
Idle window closes at the next cycle's **start** read instead of the same cycle's end read: **≤ 300 s** after the idle cycle's
start read (≈ 1–2 s today), sooner if an order appears. Never lost (a failed start read keeps the window held) and now also
covers the gap between cycles, which the two-read scheme never compared. Active cycles: two reads, same math, byte-for-byte.

## Acceptance
1. `event-watcher.test.mjs` — exactly ONE `getLogs` with the full address array + same range; the mixed fixture's
   per-contract sequence was captured against the pre-change watcher and passes before and after. ✅
2. `idle-backoff.test.mjs` — 0 orders → next RPC cycle at 300 s; 1 order → 30 s; both transitions; watcher `setIdle`
   under mock timers (repeated idle never resets a pending poll). ✅
3. `idle-backoff.test.mjs` — idle = 1 `getBalance`, active = 2; every window wei-for-wei equal to the two-read oracle. ✅
4. `node --test` in `contracts/order-engine/executor/` (what `keeper-tests` CI runs; package.json has no `test` script):
   **511 pass / 0 fail** (baseline 484 + 27 new). ✅

## Owner deploy
No new deps, no env change. On the keeper host: `git pull` (post-merge) → `pm2 restart teraswap-executor`. Expect in logs:
`Poll interval: 30s (RPC work every 300s while there are no active orders)` and `[EVENT-WATCHER] Idle — polling every 300s`.

## Noted, not changed
- `event-watcher.js` `backoffMs` is computed on RPC errors but never scheduled (fixed `setInterval`) — pre-existing.
- An env override for `IDLE_POLL_INTERVAL_MS` is a 3-line follow-up if tuning without a commit is wanted.
