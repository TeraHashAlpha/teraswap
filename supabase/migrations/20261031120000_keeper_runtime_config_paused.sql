-- ══════════════════════════════════════════════════════════
--  [fix/executor-alert-masking-rpc-auth] INC-2026-10-30-001 — the keeper's explicit paused state.
--
--  The Base keeper's RPC provider rejected every call for ~20 h (an allowlist on the key) while the
--  process stayed "alive". Nothing off the keeper host could see it: the monitor, the daily report
--  and the web app run elsewhere, and the host is SSM-only, so its /health is unreachable to them.
--  Supabase is the one channel they share with the keeper, so the keeper now records the state on
--  its own keeper_runtime_config row:
--
--    - paused        NULL while working; 'rpc-auth' while the RPC provider rejects the keeper's
--                    credentials (rpc-auth.js: 3 consecutive auth/allowlist errors at runtime, or a
--                    boot refused by chain-verify on an auth error). Cleared on the first RPC
--                    success, and at every clean boot.
--    - paused_since  when the CURRENT pause began (kept across reminders and pm2 restarts: the keeper
--                    only sets it on a row that is not already paused).
--
--  Reporting only — not a gate: the keeper never reads these columns back. Readers: the monitor
--  tick (src/lib/keeper-health-monitor.ts — alerts keeper-paused-<chain>) and the daily report
--  (GET /api/monitor/keepers). GET /api/dca-floor-cap selects no_price_fill_cap_usd only and is
--  unaffected.
--
--  Additive, nullable, no default, no index, no RLS change (service role only, as before).
--  Idempotent. OPS: apply to the LIVE Supabase DB manually; the keeper tolerates the columns being
--  absent (it logs "apply <this file>" and carries on), so the order relative to a keeper restart
--  does not matter. Mirrored in contracts/order-engine/schema.sql.
-- ══════════════════════════════════════════════════════════

ALTER TABLE keeper_runtime_config ADD COLUMN IF NOT EXISTS paused TEXT;
ALTER TABLE keeper_runtime_config ADD COLUMN IF NOT EXISTS paused_since TIMESTAMPTZ;

ALTER TABLE keeper_runtime_config DROP CONSTRAINT IF EXISTS keeper_runtime_config_paused_valid;
ALTER TABLE keeper_runtime_config ADD CONSTRAINT keeper_runtime_config_paused_valid
  CHECK (paused IS NULL OR paused IN ('rpc-auth'));

COMMENT ON COLUMN keeper_runtime_config.paused IS
  'NULL = working. ''rpc-auth'' = the RPC provider rejects the keeper''s credentials (allowlist / key); no order can execute until fixed. Written by the keeper (rpc-auth.js); reporting only. INC-2026-10-30-001.';
COMMENT ON COLUMN keeper_runtime_config.paused_since IS
  'When the current pause began; NULL while not paused. INC-2026-10-30-001.';

-- ROLLBACK:
--   ALTER TABLE keeper_runtime_config DROP CONSTRAINT IF EXISTS keeper_runtime_config_paused_valid;
--   ALTER TABLE keeper_runtime_config DROP COLUMN IF EXISTS paused_since;
--   ALTER TABLE keeper_runtime_config DROP COLUMN IF EXISTS paused;
--   (The keeper tolerates the columns' absence — it logs that the migration is missing.)
