-- ══════════════════════════════════════════════════════════
--  TeraSwap Database Improvements
--  Run in Supabase SQL Editor
--  Date: 2026-03-19
-- ══════════════════════════════════════════════════════════

-- ── Q31: Missing indexes for common query patterns ──────

-- security_events: monitor queries by created_at
CREATE INDEX IF NOT EXISTS idx_security_events_created
  ON security_events(created_at DESC);

-- usage_events: monitor queries by event_type + created_at
CREATE INDEX IF NOT EXISTS idx_usage_events_type_created
  ON usage_events(event_type, created_at DESC);

-- ── Q15: RLS policies on orders and order_executions ────

-- Enable RLS (if not already)
ALTER TABLE IF EXISTS orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS order_executions ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (server-side API routes)
DO $$ BEGIN
  CREATE POLICY "Service role full access" ON orders
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON order_executions
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Anon key: users can only read their own orders
DO $$ BEGIN
  CREATE POLICY "Users read own orders" ON orders
    FOR SELECT TO anon USING (wallet = current_setting('request.jwt.claims', true)::json->>'sub');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Q33: Cleanup orphan "pending" swaps ─────────────────
-- Run this manually or set up as a pg_cron job (every 15 min)

UPDATE swaps
SET status = 'abandoned'
WHERE status = 'pending'
  AND created_at < NOW() - INTERVAL '15 minutes';

-- ── Q32: TTL cleanup for usage_events and wallet_activity ──
-- Run this manually or set up as a daily pg_cron job

DELETE FROM usage_events
WHERE created_at < NOW() - INTERVAL '90 days';

DELETE FROM wallet_activity
WHERE created_at < NOW() - INTERVAL '90 days';

-- ══════════════════════════════════════════════════════════
--  To set up pg_cron (if available on your Supabase plan):
--
--  SELECT cron.schedule('cleanup-orphan-swaps', '*/15 * * * *',
--    $$UPDATE swaps SET status = 'abandoned' WHERE status = 'pending' AND created_at < NOW() - INTERVAL '15 minutes'$$
--  );
--
--  SELECT cron.schedule('cleanup-old-events', '0 3 * * *',
--    $$DELETE FROM usage_events WHERE created_at < NOW() - INTERVAL '90 days';
--      DELETE FROM wallet_activity WHERE created_at < NOW() - INTERVAL '90 days';$$
--  );
-- ══════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════
--  [LP-05] MEV-savings telemetry on `swaps`
--  Date: 2026-05-09
--  Run once in the Supabase SQL Editor (or via your migration tool).
--
--  Adds two nullable numeric columns to the existing `swaps` table so
--  the client can record both the pre-swap CoW-vs-non-CoW-median
--  estimate and the post-swap realised solver surplus on CoW orders.
--  Both values are stored in the OUTPUT TOKEN's raw wei (matching the
--  convention of amount_in / amount_out which are also stored as raw
--  amounts). USD conversion happens at read time using the swap's
--  Chainlink price snapshot.
--
--  Note: spec referred to the table as `swap_logs`; the actual table
--  in this project is `swaps`. Migration targets the real table name.
-- ══════════════════════════════════════════════════════════

ALTER TABLE swaps
  ADD COLUMN IF NOT EXISTS mev_savings_estimate NUMERIC(78, 0),  -- raw output-token wei; max uint256 fits in 78 digits
  ADD COLUMN IF NOT EXISTS mev_savings_actual   NUMERIC(78, 0);

COMMENT ON COLUMN swaps.mev_savings_estimate IS
  'Pre-swap MEV-savings estimate in raw output-token wei. Computed as (CoW quote output) − (median of non-CoW quote outputs). Only populated for CoW-routed swaps where CoW strictly beat the non-CoW median; NULL otherwise. See src/lib/mev-savings.ts.';

COMMENT ON COLUMN swaps.mev_savings_actual IS
  'Post-swap realised MEV surplus in raw output-token wei. Computed as (executedBuyAmount − quotedBuyAmount) from the CoW trades endpoint after order fulfilment. Only populated for confirmed CoW swaps with positive solver-delivered surplus; NULL otherwise.';

-- Optional partial index for analytics dashboards filtering for swaps
-- where MEV savings were materialised (skip the large NULL slice).
CREATE INDEX IF NOT EXISTS idx_swaps_mev_savings_actual
  ON swaps (created_at DESC)
  WHERE mev_savings_actual IS NOT NULL;
-- ══════════════════════════════════════════════════════════
