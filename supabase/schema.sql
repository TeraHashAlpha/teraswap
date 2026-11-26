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

-- ── Security Events table ──────────────────────────────────
-- Records all security-relevant events: oracle deviations, blocked swaps,
-- quote failures, abnormal patterns. Used by /api/monitor dashboard.
CREATE TABLE IF NOT EXISTS security_events (
  id          TEXT PRIMARY KEY,                     -- generated ID
  type        TEXT NOT NULL,                        -- oracle_deviation_warn, oracle_unavailable, etc.
  severity    TEXT NOT NULL DEFAULT 'info',         -- info | warn | critical
  timestamp   TIMESTAMPTZ DEFAULT now() NOT NULL,

  -- Context
  wallet      TEXT,
  token_in    TEXT,
  token_out   TEXT,
  amount_usd  NUMERIC(18,2),
  deviation   NUMERIC(8,4),                        -- price deviation (e.g. 0.0345 = 3.45%)
  source      TEXT,                                 -- aggregator source (for quote failures)
  message     TEXT NOT NULL,
  metadata    JSONB                                 -- flexible extra data
);

CREATE INDEX IF NOT EXISTS idx_security_type      ON security_events (type);
CREATE INDEX IF NOT EXISTS idx_security_timestamp ON security_events (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_security_severity  ON security_events (severity);

ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;

-- ── RLS (Row Level Security) ────────────────────────────────
-- Disable RLS since we use service-role key from server-side API routes.
-- No client-side access to these tables.
ALTER TABLE swaps  ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, so no policies needed.
-- If you later want anon read access for a public dashboard:
-- CREATE POLICY "Public read swaps" ON swaps FOR SELECT USING (true);
-- CREATE POLICY "Public read quotes" ON quotes FOR SELECT USING (true);

-- ── Usage Events table ────────────────────────────────────
-- Records page views, clicks, and session durations for platform analytics.
-- Populated by client-side UsageTracker → /api/log-event endpoint.
CREATE TABLE IF NOT EXISTS usage_events (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,

  -- Session
  session_id  TEXT NOT NULL,                        -- anonymous per-session UUID
  event_type  TEXT NOT NULL,                        -- page_view | click | session_end

  -- Page context
  page        TEXT NOT NULL,                        -- e.g. '/', '/limit', '/dca'
  referrer    TEXT,                                  -- document.referrer (first page only)

  -- Click details (null for page_view / session_end)
  click_target  TEXT,                               -- text content or aria-label of clicked element
  click_tag     TEXT,                               -- tag name: BUTTON, A, etc.
  click_id      TEXT,                               -- element id if present
  click_class   TEXT,                               -- primary class name if present

  -- Session duration (for session_end events)
  duration_ms   INTEGER,                            -- time spent on page in ms

  -- Device info
  screen_w    INTEGER,                              -- screen width
  user_agent  TEXT                                   -- navigator.userAgent (for device breakdown)
);

CREATE INDEX IF NOT EXISTS idx_usage_created_at  ON usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_event_type  ON usage_events (event_type);
CREATE INDEX IF NOT EXISTS idx_usage_session_id  ON usage_events (session_id);
CREATE INDEX IF NOT EXISTS idx_usage_page        ON usage_events (page);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

-- ── Wallet Activity table ───────────────────────────────
-- Per-wallet activity timeline for debugging & support.
-- When a user reports a problem, look up their wallet to see every action
-- they took: quotes, approvals, swaps, errors, timing.
-- Populated by client-side wallet-activity-tracker → /api/log-activity,
-- and server-side wallet-activity-server from API routes.
CREATE TABLE IF NOT EXISTS wallet_activity (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,

  -- Wallet address (always lowercased)
  wallet      TEXT NOT NULL,
  session_id  TEXT,

  -- Event classification
  category    TEXT NOT NULL,                        -- swap | approval | quote | order | ui | error
  action      TEXT NOT NULL,                        -- e.g. 'swap_initiated', 'approval_confirmed'

  -- Trade context
  source      TEXT,                                  -- DEX source: '1inch', 'cowswap', 'odos', etc.
  token_in    TEXT,
  token_out   TEXT,
  amount_usd  NUMERIC,

  -- Outcome
  success     BOOLEAN,
  error_code  TEXT,
  error_msg   TEXT,

  -- Transaction
  tx_hash     TEXT,
  order_id    TEXT,                                  -- CoW order UID
  duration_ms INTEGER,                               -- time from action start

  -- Flexible extra data
  metadata    JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_wallet  ON wallet_activity (wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_activity_created ON wallet_activity (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_activity_action  ON wallet_activity (action);

ALTER TABLE wallet_activity ENABLE ROW LEVEL SECURITY;

-- ── Swaps: verified on-chain (ADR-029) ──────────────────────
-- Mirror of supabase/migrations/20261125120000_swaps_verified.sql (its header says why).
-- A row becomes confirmed or failed only by the server, after it read the transaction on the
-- row's chain. verified_at / verified_kind record that; one transaction counts once per wallet
-- (ADR-029 section 7); a side the receipt cannot give is NULL, so the six token/symbol/amount
-- columns of the CREATE TABLE above are nullable from here on. claimed_tx_hash / claimed_chain_id
-- / claimed_at are PRIVATE: a hash the chain could not answer yet, kept until it is decided; no
-- reader returns them. Kept as ALTERs (not edited into the CREATE TABLE) so running this file on
-- an existing database applies them too.
SET lock_timeout = '5s';

ALTER TABLE swaps ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS verified_kind TEXT;
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS claimed_tx_hash TEXT;
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS claimed_chain_id INTEGER;
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'swaps_verified_kind_check' AND conrelid = 'swaps'::regclass
  ) THEN
    ALTER TABLE swaps ADD CONSTRAINT swaps_verified_kind_check
      CHECK (verified_kind IS NULL OR verified_kind IN ('fee_collector', 'router', 'cow')) NOT VALID;
  END IF;
END
$$;
ALTER TABLE swaps VALIDATE CONSTRAINT swaps_verified_kind_check;

ALTER TABLE swaps
  ALTER COLUMN token_in DROP NOT NULL,
  ALTER COLUMN token_in_symbol DROP NOT NULL,
  ALTER COLUMN token_out DROP NOT NULL,
  ALTER COLUMN token_out_symbol DROP NOT NULL,
  ALTER COLUMN amount_in DROP NOT NULL,
  ALTER COLUMN amount_out DROP NOT NULL;

RESET lock_timeout;

CREATE UNIQUE INDEX IF NOT EXISTS idx_swaps_verified_tx
  ON swaps (chain_id, lower(tx_hash), lower(wallet))
  WHERE verified_at IS NOT NULL;

COMMENT ON COLUMN swaps.verified_at IS
  'When the server verified this row against the chain (the transaction exists on chain_id, it is this wallet''s swap, and its receipt gave the status). NULL = never verified: a pending row, or a row written before ADR-029. Set only by the server. ADR-029.';

COMMENT ON COLUMN swaps.verified_kind IS
  'How the verified transaction was recognised: fee_collector | router | cow. NULL exactly when verified_at is NULL. ADR-029.';

COMMENT ON COLUMN swaps.claimed_tx_hash IS
  'PRIVATE. A transaction hash this wallet''s confirmation named while the chain could not answer yet; asked again later, cleared when decided. No reader returns it. ADR-029 section 7.';

COMMENT ON COLUMN swaps.claimed_chain_id IS
  'PRIVATE. The chain the claim named, NULL when it named none (then every chain of the app is asked). ADR-029 section 7.';

COMMENT ON COLUMN swaps.claimed_at IS
  'PRIVATE. When the claim was first stored. ADR-029 section 7.';
