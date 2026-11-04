-- ══════════════════════════════════════════════════════════
--  [ADR-026 / fix/infra-failures-dont-burn-orders] Record the keeper's INFRA misses on the
--  orders row, so a failure caused by OUR infrastructure never counts against a user's order
--  and the daily report can count the orders it touched.
--
--  Why (INC-2026-10-30-001): a ~20 h RPC allowlist outage made every due order "miss"; after
--  MAX_CYCLE_FAILURES (8) consecutive misses the keeper marked the order 'failed' with
--  no_route_after_retries — a reason the user cannot act on and that is not true. The keeper now
--  tags every miss `infra` (RPC auth/transport, keeper paused, Supabase or /api/swap unreachable,
--  keeper gas, a sent tx whose receipt could not be read) or `order` (a revert attributable to the
--  order, allowance/balance/nonce, expiry, no route for the pair) — retry-policy.js
--  classifyMissCause — and only `order` misses advance orders.consecutive_failures.
--
--    - last_infra_miss_at      when the keeper last could NOT complete an attempt on this order
--                              for an infra reason. Written by every infra miss; never reset (it
--                              is a trail, not a counter). NULL = never (or a pre-migration row).
--    - last_infra_miss_reason  the short, secret-free label of that miss: rpc-auth,
--                              rpc-transport, keeper-gas, receipt-unavailable, swap-api:<n>,
--                              swap-api:network, swap-api:misroute, keeper-config, unclassified,
--                              paused:rpc-auth.
--
--  NOT orders.error: the UI treats any non-null `error` as a failed order (src/ui/v2/dca/
--  DcaOrdersList.tsx), and `error` is the terminal reason-code contract (failed-reason.ts).
--
--  Additive, nullable, forward-only. The keeper tolerates the columns' absence: the PostgREST 400
--  naming one of them makes it re-send the patch without them (logged once per process) — the
--  order is still left active and the count still untouched; only the 24 h visibility count
--  (GET /api/monitor/keepers → infraMissOrders24h, null when unreadable) is empty until applied.
--  The retry-state fallback of 20260827190000_add_orders_retry_state.sql is independent.
--
--  RLS: no change (service-role keeper writes; the user UPDATE policy WITH CHECK (status =
--  'cancelled') cannot forge a trail on an active order). Index: one partial btree on
--  last_infra_miss_at for the 24 h count (`WHERE last_infra_miss_at IS NOT NULL` keeps it tiny).
--
--  Idempotent (IF NOT EXISTS) — safe to re-run.
--  OPS: apply to the LIVE Supabase DB MANUALLY (CI does NOT run migrations against prod). Order
--  relative to the keeper restart does not matter — the keeper degrades to "trail not recorded".
--  [A73 S-5] On the live table build the index CONCURRENTLY so it never takes a write lock on
--  `orders` while the keeper is running:
--      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_last_infra_miss_at
--        ON orders (chain_id, last_infra_miss_at) WHERE last_infra_miss_at IS NOT NULL;
--  CONCURRENTLY cannot run inside a transaction block — run that one statement on its own (the
--  Supabase SQL editor wraps a multi-statement run in a transaction), after the two ALTERs below.
--  The plain form below is for an empty / fresh database (schema.sql parity) and is also safe on a
--  table this small today.
-- ══════════════════════════════════════════════════════════

ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_infra_miss_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_infra_miss_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_last_infra_miss_at
  ON orders (chain_id, last_infra_miss_at)
  WHERE last_infra_miss_at IS NOT NULL;

COMMENT ON COLUMN orders.last_infra_miss_at IS
  'Keeper: when the last INFRA miss happened (the keeper itself could not complete the attempt: RPC auth/transport, paused, Supabase or /api/swap down, keeper gas, receipt unreadable). Never counted toward consecutive_failures; never reset. NULL = never / pre-migration row. ADR-026.';

COMMENT ON COLUMN orders.last_infra_miss_reason IS
  'Keeper: the short label of the last infra miss (rpc-auth | rpc-transport | keeper-gas | receipt-unavailable | swap-api:<n|network|misroute> | keeper-config | unclassified | paused:rpc-auth). ADR-026.';

-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_orders_last_infra_miss_at;
--   ALTER TABLE orders DROP COLUMN IF EXISTS last_infra_miss_reason;
--   ALTER TABLE orders DROP COLUMN IF EXISTS last_infra_miss_at;
--   (The keeper tolerates the columns' absence — infra misses are still not counted; only the
--    24 h visibility count goes empty.)
