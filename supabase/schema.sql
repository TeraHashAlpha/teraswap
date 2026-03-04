-- ════════════════════════════════════════════════════════════
-- TeraSwap Analytics Schema
-- Run this in Supabase SQL Editor to create the tables.
-- ════════════════════════════════════════════════════════════

-- ── Swaps table ─────────────────────────────────────────────
-- Records every swap executed through TeraSwap.
CREATE TABLE IF NOT EXISTS swaps (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,

  -- Wallet & tx
  wallet      TEXT NOT NULL,                    -- 0x... user address
  tx_hash     TEXT,                             -- null until confirmed
  chain_id    INTEGER NOT NULL DEFAULT 1,       -- 1 = Ethereum mainnet
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | failed

  -- Source
  source      TEXT NOT NULL,                    -- e.g. '1inch', 'cowswap'

  -- Token pair
  token_in        TEXT NOT NULL,                -- token address
  token_in_symbol TEXT NOT NULL,
  token_out       TEXT NOT NULL,
  token_out_symbol TEXT NOT NULL,

  -- Amounts (stored as text to preserve precision)
  amount_in   TEXT NOT NULL,                    -- raw amount (wei)
  amount_out  TEXT NOT NULL,                    -- expected output (wei)
  amount_in_usd   NUMERIC(18,2),               -- USD value at time of swap
  amount_out_usd  NUMERIC(18,2),

  -- Settings
  slippage    NUMERIC(5,2) NOT NULL DEFAULT 0.5,
  mev_protected BOOLEAN NOT NULL DEFAULT false,

  -- Fee
  fee_collected BOOLEAN NOT NULL DEFAULT false,
  fee_amount    TEXT,                           -- fee in output token (wei)

  -- Gas
  gas_used    TEXT,
  gas_price   TEXT
);

-- ── Quotes table ────────────────────────────────────────────
-- Records every quote request for analytics (which sources win, response times).
CREATE TABLE IF NOT EXISTS quotes (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,

  -- Token pair
  token_in        TEXT NOT NULL,
  token_in_symbol TEXT NOT NULL,
  token_out       TEXT NOT NULL,
  token_out_symbol TEXT NOT NULL,
  amount_in       TEXT NOT NULL,

  -- Sources
  sources_queried   TEXT[] NOT NULL DEFAULT '{}',    -- all sources tried
  sources_responded TEXT[] NOT NULL DEFAULT '{}',    -- sources that returned quotes
  best_source       TEXT,                            -- winner
  best_amount_out   TEXT,                            -- best output amount

  -- All quotes (JSON: { "1inch": "123456...", "cowswap": "123789..." })
  all_quotes  JSONB,

  -- Performance
  response_time_ms INTEGER NOT NULL DEFAULT 0,

  -- Optional wallet (null if not connected)
  wallet      TEXT
);

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_swaps_wallet     ON swaps (wallet);
CREATE INDEX IF NOT EXISTS idx_swaps_created_at ON swaps (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swaps_source     ON swaps (source);
CREATE INDEX IF NOT EXISTS idx_swaps_pair       ON swaps (token_in, token_out);
CREATE INDEX IF NOT EXISTS idx_swaps_tx_hash    ON swaps (tx_hash) WHERE tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_quotes_created_at   ON quotes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_best_source  ON quotes (best_source);
CREATE INDEX IF NOT EXISTS idx_quotes_pair         ON quotes (token_in, token_out);

-- ── RLS (Row Level Security) ────────────────────────────────
-- Disable RLS since we use service-role key from server-side API routes.
-- No client-side access to these tables.
ALTER TABLE swaps  ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, so no policies needed.
-- If you later want anon read access for a public dashboard:
-- CREATE POLICY "Public read swaps" ON swaps FOR SELECT USING (true);
-- CREATE POLICY "Public read quotes" ON quotes FOR SELECT USING (true);
