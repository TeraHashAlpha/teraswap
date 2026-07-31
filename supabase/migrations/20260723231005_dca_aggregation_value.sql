-- ══════════════════════════════════════════════════════════
--  [CHORE-DCA-AGGREGATION-VALUE] Additive telemetry: the runner-up (second-best)
--  source quote captured alongside each DCA fill, for the settlement receipt's
--  "aggregation value" line (best route vs next-best source, gross-vs-gross).
--
--  Both columns are nullable and forward-only:
--    - next_best_out    the runner-up source's GROSS output amount (raw token
--                        units, same string convention as amount_out), from the
--                        SAME unconstrained /api/quote round as the executed fill.
--    - next_best_source  the runner-up's aggregator name (e.g. "1inch", "0x").
--
--  Written POST-execution, best-effort, by the keeper (executor.js /
--  record-execution.js buildExecutionRow) — NEVER read for routing/execution,
--  and their absence (single-source quote round, quote-fetch failure, or any
--  pre-existing row from before this migration) is a normal, honest "no
--  comparison available" state — the settlement receipt shows "—" for those
--  fills, never a fabricated number. price_at_execution is untouched.
--
--  Idempotent: IF NOT EXISTS — safe to re-run. No RLS change (order_executions
--  already has its policies; these are ordinary nullable columns on an existing
--  table, not a new table). No grant required beyond what INSERT already covers.
--  OPS: apply to the LIVE Supabase DB manually (CI does NOT run migrations
--  against prod), per this repo's existing convention for schema.sql changes.
-- ══════════════════════════════════════════════════════════

ALTER TABLE order_executions ADD COLUMN IF NOT EXISTS next_best_out TEXT;
ALTER TABLE order_executions ADD COLUMN IF NOT EXISTS next_best_source TEXT;

COMMENT ON COLUMN order_executions.next_best_out IS
  'Runner-up (second-best) source''s gross output amount, raw token units, from the same unconstrained quote round as this fill. NULL = no comparison available (single-source round, fetch failure, or pre-migration row) — never fabricated. CHORE-DCA-AGGREGATION-VALUE.';

COMMENT ON COLUMN order_executions.next_best_source IS
  'Runner-up source''s aggregator name (e.g. "1inch", "0x"). NULL alongside next_best_out under the same conditions. CHORE-DCA-AGGREGATION-VALUE.';

-- ROLLBACK:
--   ALTER TABLE order_executions DROP COLUMN IF EXISTS next_best_out;
--   ALTER TABLE order_executions DROP COLUMN IF EXISTS next_best_source;
