-- ══════════════════════════════════════════════════════════
--  [FEAT-DCA-FLOOR-TIERS] Record which minimum-output tier a DCA was created under and when the
--  user acknowledged it (owner decision 2026-10-11).
--
--    floor_tier    'offchain-price' | 'unpriced' for a consent-requiring DCA; NULL for every other
--                  order (on-chain-feed DCA, Limit/TP, pre-migration rows).
--    floor_ack_at  the acknowledgement time the server validated (≤ 24h old, not future).
--
--  Additive, NULLABLE, no default, no index, no RLS change. The keeper (executor.js) reads orders
--  with `select=*` and never references these columns, so it is unaffected by their presence/absence.
--  The API only writes them for consent-requiring orders.
--
--  OPS: apply to the LIVE Supabase DB manually (CI does NOT run migrations) BEFORE the API deploy
--  that writes them. Until applied, a consent-requiring DCA insert fails (500) — fail closed.
--  orders columns mirrored in contracts/order-engine/schema.sql.
-- ══════════════════════════════════════════════════════════

ALTER TABLE orders ADD COLUMN IF NOT EXISTS floor_tier TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS floor_ack_at TIMESTAMPTZ;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_floor_tier_valid;
ALTER TABLE orders ADD CONSTRAINT orders_floor_tier_valid
  CHECK (floor_tier IS NULL OR floor_tier IN ('onchain-feed', 'offchain-price', 'unpriced'));

COMMENT ON COLUMN orders.floor_tier IS
  'DCA minimum-output tier the user consented to (server-classified): offchain-price | unpriced. NULL = no consent required / not a DCA / pre-migration. FEAT-DCA-FLOOR-TIERS.';
COMMENT ON COLUMN orders.floor_ack_at IS
  'When the user acknowledged floor_tier (server-validated). FEAT-DCA-FLOOR-TIERS.';

-- ── keeper_runtime_config (owner decision 2026-10-11) ───────────────────────────────────────────
--  Shape defined now; the KEEPER writes it at startup in a later goal (keeper price-quorum). The web
--  app only READS it (GET /api/dca-floor-cap, service role) and never writes. Effective no-price fill
--  cap shown to users = min(no_price_fill_cap_usd, DCA_NO_PRICE_FILL_CAP_MAX_USD); the ceiling if no row.
CREATE TABLE IF NOT EXISTS keeper_runtime_config (
  chain_id              INTEGER PRIMARY KEY,
  no_price_fill_cap_usd NUMERIC,
  keeper_version        TEXT,
  updated_at            TIMESTAMPTZ
);
ALTER TABLE keeper_runtime_config ENABLE ROW LEVEL SECURITY; -- no policies: service role only

-- ROLLBACK:
--   DROP TABLE IF EXISTS keeper_runtime_config;
--   ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_floor_tier_valid;
--   ALTER TABLE orders DROP COLUMN IF EXISTS floor_ack_at;
--   ALTER TABLE orders DROP COLUMN IF EXISTS floor_tier;
