# ADR-026 — Infrastructure failures do not burn a user's order

- **Status:** Proposed
- **Date:** 2026-11-04
- **Implemented by:** `fix/infra-failures-dont-burn-orders` (keeper: `contracts/order-engine/executor/`;
  read-only visibility in `src/lib/keeper-health-monitor.ts` + the daily report)
- **Follows:** `chore/dca-resilience` (the transient/permanent ladder), `FIX-RETRY-CAP-RESTART`
  (the persisted count), [ADR-014](ADR-014-nondca-execution-model.md) (a) (pinned-route reverts are
  not misses), [ADR-024](ADR-024-dca-price-quorum.md) (quorum skips are not misses),
  [INC-2026-10-30-001](../../Audits/Incidents/INC-2026-10-30-001.md)
- **Fund-flow:** no new path. No change to gates, quorum, the $250 no-price cap, minOut / floor
  derivation, signing, nonce or gas policy. Changes only WHICH misses advance `consecutive_failures`.
  Keeper execution logic ⇒ Auditor required before merge.

## Owner decision (2026-11-04) — the spec

> Failures caused by OUR infrastructure must not count against a user's order.

## Context

The keeper's failure ladder (`retry-policy.js`) counts every miss that is not a permanent cause
(allowance / balance / nonce) toward `MAX_CYCLE_FAILURES` (8) and then marks the order `failed`
(`no_route_after_retries` / `min_output_unreachable`). The ladder cannot tell a market miss from an
outage: during INC-2026-10-30-001 (RPC allowlist, ~20 h) every due order would have "missed" eight
times and died with a reason that blames routing. The same holds for a provider 5xx/429 outage, a
timeout storm, a Supabase blip mid-attempt, our `/api/swap` being down, or the keeper wallet running
out of gas — none of which the user can fix, and none of which says anything about the order.

## Decision

1. **Every miss is tagged with its cause** (`classifyMissCause`, pure, in `retry-policy.js`):

   | Site / evidence | Cause | Label |
   |---|---|---|
   | keeper `paused: rpc-auth` (rpc-auth.js monitor) | infra | `paused:rpc-auth` — the cycle does not attempt at all |
   | RPC auth / allowlist (`classifyRpcError` = auth, reused) | infra | `rpc-auth` |
   | RPC transport: HTTP 5xx / 429, viem timeout, socket / `fetch failed` (incl. Supabase thrown mid-attempt) | infra | `rpc-transport` |
   | keeper wallet cannot pay gas (viem `InsufficientFundsError`) | infra | `keeper-gas` |
   | tx SENT, receipt not readable (timeout / RPC error after send) | infra | `receipt-unavailable` |
   | `/api/swap` 5xx / 429 / network / calldata for the wrong router / keeper config gap | infra | `swap-api:<n>`, `swap-api:network`, `swap-api:misroute`, `keeper-config` |
   | anything else thrown before a tx was sent | infra | `unclassified` |
   | mined revert (`receipt.status = reverted`) | order | `reverted` |
   | simulated revert: executor error / `SwapFailed` / revert text | order | `revert[:<Name>\|swap-failed]` |
   | allowance / balance / nonce (permanent, as before) | order | the `FAILURE_REASON` code |
   | `/api/swap` answered 4xx or with no tx data | order | `no-route[:<4xx>\|no-tx-data]` |
   | expired | order | `expired` (own status, as before) |
   | a miss with no evidence at all | order | `unknown` (today's counting — an untouched call site can never silently stop counting) |

   Ambiguity rule: `infra` only when the keeper itself could not complete the attempt (no tx
   sent); any sent-and-reverted tx is `order`. `order` needs positive evidence.

2. **Only `order` misses advance the ladder.** `consecutive_failures` and the 8-miss → `failed`
   rule count `order` misses only. An `infra` miss leaves the count untouched, writes
   `last_attempt_at` (as the owner asked) plus `last_infra_miss_at` / `last_infra_miss_reason`, and
   the order stays `active`. A missed DCA run is simply attempted on the next healthy cycle: the
   contract's `dcaLastExecution + dcaInterval` gate is the only thing that decides whether a chunk is
   due, so it can never execute twice for one interval nor back-fill more runs than the schedule
   allows — the keeper only ever asks `canExecute` and sends one `executeOrder` per attempt.

3. **While `paused: rpc-auth` the keeper attempts nothing**: no lock, no tx, no counter, no patch.
   The cycle still runs its balance read (the probe that clears the pause) and the event watcher
   keeps polling, so recovery is automatic.

4. **Storage.** Two additive, nullable columns on `orders` (`last_infra_miss_at TIMESTAMPTZ`,
   `last_infra_miss_reason TEXT`), migration `supabase/migrations/20261104120000_orders_infra_miss.sql`,
   applied MANUALLY by the owner. The keeper tolerates their absence (PostgREST 400 naming them ⇒
   the patch is re-sent without them, logged once per process); the retry-state fallback of
   `FIX-RETRY-FALLBACK-MIGRATION-LAGS` is untouched. `orders.error` is NOT reused: the UI treats a
   non-null `error` as a failed order (`DcaOrdersList.tsx`).

5. **Visibility.** `GET /api/monitor/keepers` adds `infraMissOrders24h` per chain (count of orders
   with `last_infra_miss_at` in the last 24 h; `null` when unreadable). The daily report shows it;
   the keeper's `/health` counts `infraMisses` per process. Runbook: `EXECUTOR-OPERATIONS.md` § 8.

## Consequences

- An outage no longer kills orders. An order that keeps missing for an `infra` reason is retried
  every healthy cycle until it fills or expires; nothing caps it, so the ONLY signals for a
  persistent infra miss are the RPC-level alerts (rpc-auth pause, "Ops issue: rpc", the monitor's
  consecutive-errors alert) and the 24 h count. A keeper bug that throws for one order is, by the
  ambiguity rule, `infra:unclassified` and therefore also uncapped — visible in the log and the count.
- `last_attempt_at` moves on an infra miss. With `consecutive_failures ≥ 1` the existing backoff
  (`backoffMs(count)`, ≤ 30 min) therefore runs from the LAST attempt, infra or order; with a count
  of 0 (the common case) the next healthy cycle retries immediately.
- A sent tx whose receipt we could not read is not counted. If it landed, the next cycle's
  `canExecute` returns false (interval / nonce) and the row is reconciled by the existing
  `backfill-execution.mjs` path; if it reverted, the next attempt reverts again ⇒ `order`.

## Alternatives rejected

- Reusing `orders.error` for the infra reason: the UI reads any `error` as failed.
- A per-miss row in `order_executions`: one row per order per cycle during an outage.
- Counting infra misses on a separate ladder with its own cap: nothing the user can do ends an
  outage, so a cap would still fail the order for our fault.
