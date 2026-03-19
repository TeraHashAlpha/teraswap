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
