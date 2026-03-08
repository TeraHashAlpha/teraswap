-- ════════════════════════════════════════════════════════════
-- TeraSwap Order Engine — Database Schema
-- Run this in Supabase SQL Editor AFTER deploying the
-- OrderExecutor contract and setting up Gelato.
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
  order_hash  TEXT,                                    -- EIP-712 struct hash

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

  -- Router preference
  router      TEXT NOT NULL DEFAULT '',                -- preferred DEX router

  -- Chain
  chain_id    INTEGER NOT NULL DEFAULT 1               -- 1 = Ethereum mainnet
);

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_wallet     ON orders (wallet);
CREATE INDEX IF NOT EXISTS idx_orders_active     ON orders (status, expiry) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_orders_type       ON orders (order_type);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_pair       ON orders (token_in, token_out);

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
-- Service role bypasses RLS (used by API routes + Gelato function)

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
