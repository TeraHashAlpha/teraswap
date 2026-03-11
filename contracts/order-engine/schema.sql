-- ════════════════════════════════════════════════════════════
-- TeraSwap Order Engine — Database Schema v2
-- Run this in Supabase SQL Editor AFTER deploying the
-- OrderExecutor contract and setting up Gelato.
--
-- v2 CHANGES:
-- [L-05] Proper RLS policies (user can only read/cancel own orders)
-- [L-06] Wallet address validation (checksum format)
-- [M-05] Added order_hash as NOT NULL with unique constraint
-- Added rate limiting function
-- Added execution history table for DCA tracking
-- ════════════════════════════════════════════════════════════

-- ── Orders table ────────────────────────────────────────────
-- Stores all pending/active/executed orders (limit, stop-loss, DCA).
-- The Gelato Web3 Function reads active orders and executes them.

CREATE TABLE IF NOT EXISTS orders (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,

  -- User
  wallet      TEXT NOT NULL,                           -- 0x... order creator

  -- Order type & status
  order_type  TEXT NOT NULL CHECK (order_type IN ('limit', 'stop_loss', 'dca')),
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'executing', 'executed', 'cancelled', 'expired', 'failed')),

  -- Token pair
  token_in        TEXT NOT NULL,                       -- sell token address
  token_in_symbol TEXT NOT NULL,
  token_out       TEXT NOT NULL,                       -- buy token address
  token_out_symbol TEXT NOT NULL,

  -- Amounts (raw wei, stored as text for precision)
  amount_in       TEXT NOT NULL,                       -- total amount to sell
  min_amount_out  TEXT NOT NULL,                       -- slippage protection

  -- Price condition
  target_price    TEXT NOT NULL,                       -- Chainlink-format (8 decimals)
  price_feed      TEXT NOT NULL DEFAULT '',            -- Chainlink feed address (empty = DCA)
  price_condition TEXT NOT NULL DEFAULT 'above'
                  CHECK (price_condition IN ('above', 'below')),
  current_price   TEXT,                                -- last checked price

  -- Timing
  expiry      BIGINT NOT NULL,                         -- Unix timestamp
  nonce       INTEGER NOT NULL DEFAULT 0,              -- EIP-712 nonce

  -- EIP-712 signature (from user's wallet)
  signature   TEXT NOT NULL,                           -- hex-encoded signature
  order_hash  TEXT NOT NULL,                           -- [M-05] EIP-712 struct hash (required)

  -- DCA-specific
  dca_interval    INTEGER NOT NULL DEFAULT 0,          -- seconds between executions
  dca_total       INTEGER NOT NULL DEFAULT 1,          -- total planned executions
  dca_executed    INTEGER NOT NULL DEFAULT 0,          -- completed executions
  dca_last_exec   TIMESTAMPTZ,                         -- last execution time

  -- Execution details (filled after execution)
  tx_hash     TEXT,                                    -- execution tx hash
  amount_out  TEXT,                                    -- actual output received
  fee_amount  TEXT,                                    -- fee collected
  gas_used    TEXT,
  executed_at TIMESTAMPTZ,                             -- when it was executed
  executed_price TEXT,                                 -- price at execution

  -- Full order struct (for executor to rebuild + verify)
  order_data  JSONB,                                   -- full EIP-712 Order struct as JSON

  -- Token metadata (for UI display without RPC lookups)
  token_in_decimals  INTEGER NOT NULL DEFAULT 18,
  token_out_decimals INTEGER NOT NULL DEFAULT 18,

  -- Error message (set on failure)
  error       TEXT,

  -- Router (part of signed order in v2)
  router      TEXT NOT NULL DEFAULT '',                -- DEX router from signed order

  -- Chain
  chain_id    INTEGER NOT NULL DEFAULT 1,              -- 1 = Ethereum mainnet

  -- [L-06] Wallet address format validation (0x + 40 hex chars)
  CONSTRAINT valid_wallet CHECK (wallet ~* '^0x[0-9a-f]{40}$'),
  CONSTRAINT valid_token_in CHECK (token_in ~* '^0x[0-9a-f]{40}$'),
  CONSTRAINT valid_token_out CHECK (token_out ~* '^0x[0-9a-f]{40}$'),

  -- [M-05] Order hash must be unique (prevents duplicate order submission)
  CONSTRAINT unique_order_hash UNIQUE (order_hash)
);

-- ── Execution History (DCA orders have multiple fills) ──────
CREATE TABLE IF NOT EXISTS order_executions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  execution_number INTEGER NOT NULL,                   -- 1-based execution count
  tx_hash     TEXT NOT NULL,
  amount_in   TEXT NOT NULL,                           -- actual amount sold this execution
  amount_out  TEXT NOT NULL,                           -- actual amount received
  fee_amount  TEXT NOT NULL,
  gas_used    TEXT,
  price_at_execution TEXT,                             -- Chainlink price when executed
  status      TEXT NOT NULL DEFAULT 'confirmed'
              CHECK (status IN ('confirmed', 'failed', 'pending'))
);

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_wallet     ON orders (wallet);
CREATE INDEX IF NOT EXISTS idx_orders_active     ON orders (status, expiry) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_orders_type       ON orders (order_type);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_pair       ON orders (token_in, token_out);
CREATE INDEX IF NOT EXISTS idx_orders_hash       ON orders (order_hash);

CREATE INDEX IF NOT EXISTS idx_executions_order  ON order_executions (order_id);

-- ══════════════════════════════════════════════════════════════
-- [L-05] ROW LEVEL SECURITY — Proper policies
-- ══════════════════════════════════════════════════════════════

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_executions ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically (used by API routes + Gelato function)

-- Users can read their own orders (authenticated via Supabase Auth)
-- The wallet address is matched against the JWT's verified wallet claim
CREATE POLICY "Users can view own orders"
  ON orders FOR SELECT
  USING (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet_address')
  );

-- Users can insert their own orders
CREATE POLICY "Users can create own orders"
  ON orders FOR INSERT
  WITH CHECK (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet_address')
  );

-- Users can cancel their own active orders (only status change to 'cancelled')
CREATE POLICY "Users can cancel own orders"
  ON orders FOR UPDATE
  USING (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet_address')
    AND status = 'active'
  )
  WITH CHECK (
    status = 'cancelled'
  );

-- Users can NOT delete orders (soft-delete via status only)
-- No DELETE policy = no user deletions

-- Users can view executions of their own orders
CREATE POLICY "Users can view own executions"
  ON order_executions FOR SELECT
  USING (
    order_id IN (
      SELECT id FROM orders
      WHERE wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet_address')
    )
  );

-- ══════════════════════════════════════════════════════════════
-- RATE LIMITING — Prevent order spam
-- ══════════════════════════════════════════════════════════════

-- Function to check if wallet has exceeded rate limit
-- Call this from the API route before inserting
CREATE OR REPLACE FUNCTION check_order_rate_limit(
  p_wallet TEXT,
  p_max_orders INTEGER DEFAULT 10,     -- max orders per window
  p_window_minutes INTEGER DEFAULT 60   -- time window in minutes
) RETURNS BOOLEAN AS $$
DECLARE
  recent_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO recent_count
  FROM orders
  WHERE wallet = lower(p_wallet)
    AND created_at > now() - (p_window_minutes || ' minutes')::interval
    AND status IN ('active', 'executing');

  RETURN recent_count < p_max_orders;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get active order count per wallet (for UI display)
CREATE OR REPLACE FUNCTION get_active_order_count(p_wallet TEXT)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)
    FROM orders
    WHERE wallet = lower(p_wallet)
      AND status IN ('active', 'executing')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Auto-update updated_at ─────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ── Normalize wallet addresses to lowercase on insert ───────
CREATE OR REPLACE FUNCTION normalize_wallet()
RETURNS TRIGGER AS $$
BEGIN
  NEW.wallet = lower(NEW.wallet);
  NEW.token_in = lower(NEW.token_in);
  NEW.token_out = lower(NEW.token_out);
  IF NEW.router != '' THEN
    NEW.router = lower(NEW.router);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_normalize_wallet
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION normalize_wallet();
