-- ══════════════════════════════════════════════════════════
--  DCA circuit breaker — TeraSwap observability/freeze
--  Run once in the Supabase SQL Editor.
--
--  Backs the manual DCA "freeze" switch. A single fixed row
--  (id = 'dca') holds whether DCA-order execution is currently
--  frozen. The freeze is a DELAY, never a loss — see
--  docs/Runbooks/DCA-FREEZE.md for the full operator procedure.
--
--  Readers (the create-order API + the keeper/executor.js) MUST
--  fail OPEN: a missing table / missing row / read error is
--  treated as NOT frozen. The on-chain pause() on the
--  OrderExecutor is the nuclear fail-safe, not this flag.
--
--  Writers (the admin route /api/admin/dca-freeze, Bearer-gated)
--  upsert the single id = 'dca' row.
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS circuit_breaker (
  -- Fixed primary key. There is exactly ONE logical breaker today
  -- ('dca'); the text PK leaves room for future breakers (e.g.
  -- 'swaps', 'limit') without a schema migration.
  id          TEXT         PRIMARY KEY,
  -- The switch. true ⇒ skip DCA-order execution this cycle. Defaults
  -- to false so a freshly-created row is fail-open by construction.
  frozen      BOOLEAN      NOT NULL DEFAULT false,
  -- Human-readable reason recorded by the operator at freeze time
  -- (NULL when never frozen / after a clean unfreeze).
  reason      TEXT,
  -- Last mutation timestamp. Writers set this explicitly to
  -- new Date().toISOString() on every upsert; the DEFAULT covers
  -- the seed insert below.
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Who flipped it (admin label / wallet / operator id) — audit only.
  updated_by  TEXT
);

-- ── Seed row ────────────────────────────────────────────────
-- Insert the single 'dca' breaker in the unfrozen state. ON CONFLICT
-- DO NOTHING makes this re-runnable (idempotent) and never clobbers a
-- live freeze if the script is replayed during an incident.
INSERT INTO circuit_breaker (id, frozen, reason, updated_by)
VALUES ('dca', false, NULL, 'seed')
ON CONFLICT (id) DO NOTHING;

-- Comments for self-documenting schema dumps -----------------

COMMENT ON TABLE circuit_breaker IS
  'Manual DCA freeze switch. Single fixed row id=''dca''. Readers fail OPEN (missing table/row/error ⇒ not frozen). See docs/Runbooks/DCA-FREEZE.md.';

COMMENT ON COLUMN circuit_breaker.frozen IS
  'true ⇒ keeper skips order_type=''dca'' execution this cycle. Non-DCA (limit/stop_loss) keep executing. Freeze = delay, never loss.';

COMMENT ON COLUMN circuit_breaker.reason IS
  'Operator-supplied reason recorded at freeze time. NULL when never frozen / after a clean unfreeze.';

COMMENT ON COLUMN circuit_breaker.updated_by IS
  'Audit label of whoever last flipped the switch (admin id / wallet / operator).';

-- ── RLS (Row Level Security) ────────────────────────────────
-- [defence-in-depth] All other TeraSwap tables (swaps, quotes,
-- orders, order_executions, security_events, usage_events,
-- wallet_activity, api_keys) have RLS enabled. The admin route and
-- the create-order API read/write via SUPABASE_SERVICE_ROLE_KEY,
-- which bypasses RLS, so there is no functional change — but the
-- deny-all default keeps the breaker state out of reach if a call
-- site ever picks up the anon key by mistake. (The keeper reads via
-- the service-role REST helper too.)
ALTER TABLE circuit_breaker ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS at the engine level; the explicit policy
-- is here so a `\d+ circuit_breaker` dump documents the intent.
DO $$ BEGIN
  CREATE POLICY "Service role full access" ON circuit_breaker
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Anon (and authenticated) get nothing — no SELECT, no INSERT,
-- no UPDATE, no DELETE. RLS without policies for a role is already
-- deny-by-default; the explicit USING (false) makes the intent
-- unmistakable on inspection.
DO $$ BEGIN
  CREATE POLICY "Deny all to anon" ON circuit_breaker
    FOR ALL TO anon USING (false) WITH CHECK (false);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
