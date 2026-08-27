-- ══════════════════════════════════════════════════════════
--  [FIX-RETRY-CAP-RESTART] Persist the keeper's per-order retry state on the
--  orders row so MAX_CYCLE_FAILURES survives a keeper restart.
--
--  Why (INC-2026-08-07-001, the part never closed): order ef85438b reverted
--  516 times against a structurally unattainable signed minimum under a cap
--  of 8. The consecutive-miss count lived ONLY in executor.js's in-memory Map;
--  the keeper restarted 228 times and every restart reset it to 0 and
--  re-attempted immediately (no backoff either). Reaching 8 needs ~62 min of
--  uninterrupted uptime under the backoff ladder, so 508 of the 516 reverts
--  were the counter being reset. The keeper's DECISION now reads these
--  columns (retry-policy.js planFailureHandling / readPersistedRetryState);
--  the Map is only a same-process backoff cache.
--
--    - consecutive_failures  transient misses in a row on the failure ladder
--                            (no-route, RPC error, mined/simulated revert).
--                            Written by the ladder's retry + fail patches;
--                            reset to 0 by every successful fill. NEVER written
--                            by the ADR-014 (a) pinned-route-revert path, the
--                            gas-tier defer, the DCA deviation defer, or the
--                            oracle-floor delay — those are "not yet", not
--                            failures, and keep counting as zero.
--    - last_attempt_at       when that last counted miss happened; drives the
--                            exponential backoff after a restart so a fresh
--                            process does not hammer the order on its first
--                            poll. NULL = never missed (or pre-migration row).
--
--  Additive, nullable-safe, forward-only: a pre-migration row reads as
--  count 0 / no last attempt — exactly the pre-fix behaviour. The keeper also
--  falls back to a status-only patch (and pages ops) if PostgREST rejects
--  these columns, so a deploy that races this migration degrades to today's
--  behaviour rather than leaving an order stuck in 'executing'.
--
--  RLS: no change. `orders` already has RLS enabled with the service-role
--  bypass the keeper uses; the user UPDATE policy ("Users can cancel own
--  orders") has WITH CHECK (status = 'cancelled'), so a user cannot zero the
--  counter while keeping the order active. No index: neither column is used
--  in a WHERE / JOIN / ORDER BY (the keeper reads them off rows it already
--  fetched by status + chain_id).
--
--  Idempotent: IF NOT EXISTS / DROP-then-ADD constraint — safe to re-run.
--  OPS: apply to the LIVE Supabase DB manually (CI does NOT run migrations
--  against prod) and BEFORE the keeper is restarted on the new code, per this
--  repo's existing convention. Mirrored in contracts/order-engine/schema.sql.
-- ══════════════════════════════════════════════════════════

ALTER TABLE orders ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_consecutive_failures_nonneg;
ALTER TABLE orders ADD CONSTRAINT orders_consecutive_failures_nonneg CHECK (consecutive_failures >= 0);

COMMENT ON COLUMN orders.consecutive_failures IS
  'Keeper failure-ladder count: consecutive transient misses (no-route / RPC error / revert) since the last successful fill. Reset to 0 by a fill. NOT incremented by pinned-route reverts (ADR-014 a) or by gas/deviation/oracle-floor defers. The keeper fails the order at MAX_CYCLE_FAILURES (default 8) reading THIS column, so the cap survives a restart. FIX-RETRY-CAP-RESTART / INC-2026-08-07-001.';

COMMENT ON COLUMN orders.last_attempt_at IS
  'When the last counted miss (consecutive_failures) happened. Drives the exponential retry backoff across keeper restarts. NULL = no counted miss yet (or a pre-migration row). FIX-RETRY-CAP-RESTART.';

-- ROLLBACK:
--   ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_consecutive_failures_nonneg;
--   ALTER TABLE orders DROP COLUMN IF EXISTS last_attempt_at;
--   ALTER TABLE orders DROP COLUMN IF EXISTS consecutive_failures;
--   (The keeper tolerates the columns' absence — it degrades to the pre-fix
--    in-memory count and logs/pages that the cap is no longer restart-proof.)
