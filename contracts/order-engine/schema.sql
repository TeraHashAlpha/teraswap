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

  -- [FIX-RETRY-CAP-RESTART] Keeper failure-ladder state, persisted so MAX_CYCLE_FAILURES survives
  -- a keeper restart (INC-2026-08-07-001: 516 reverts under a cap of 8 across 228 restarts).
  -- consecutive_failures = transient misses in a row since the last fill (reset to 0 by a fill;
  -- never touched by pinned-route reverts or gas/deviation/oracle-floor defers);
  -- last_attempt_at = when the last counted miss happened (drives backoff across restarts).
  -- See supabase/migrations/20260827190000_add_orders_retry_state.sql.
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CONSTRAINT orders_consecutive_failures_nonneg CHECK (consecutive_failures >= 0),
  last_attempt_at TIMESTAMPTZ,
  -- [ADR-026] Keeper INFRA-miss trail (fix/infra-failures-dont-burn-orders): when / why the keeper
  -- last could NOT complete an attempt for a reason that is OURS (RPC auth/transport, paused,
  -- Supabase or /api/swap down, keeper gas, receipt unreadable). Such a miss never advances
  -- consecutive_failures; the trail is never reset. Migration 20261104120000_orders_infra_miss.sql.
  last_infra_miss_at TIMESTAMPTZ,
  last_infra_miss_reason TEXT,

  -- [FEAT-DCA-FLOOR-TIERS] DCA minimum-output tier the user consented to + when (nullable; NULL = no
  -- consent required). See supabase/migrations/20261011120000_orders_floor_tier_consent.sql.
  floor_tier TEXT
    CONSTRAINT orders_floor_tier_valid CHECK (floor_tier IS NULL OR floor_tier IN ('onchain-feed', 'offchain-price', 'unpriced')),
  floor_ack_at TIMESTAMPTZ,

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
  -- [CHORE-DCA-AGGREGATION-VALUE] Additive, nullable, forward-only — the runner-up (second-best)
  -- source captured alongside this fill (same quote round as the fill's own aggregator pick).
  -- NULL = no comparison available (single-source round, fetch failure, or a pre-migration row).
  -- See supabase/migrations/20260723231005_dca_aggregation_value.sql.
  next_best_out TEXT,
  next_best_source TEXT,
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
-- [CHORE-ORDER-API-CHAIN-AWARE] The keeper scopes its active-orders query by (status, chain_id) so a
-- per-chain keeper only processes its own rows. The chain_id column already exists (see above);
-- these indexes keep the chain-scoped poll fast. OPS: apply to the LIVE Supabase DB manually (CI does
-- NOT run migrations against prod) — use CREATE INDEX CONCURRENTLY in prod to avoid locking the table
-- (CONCURRENTLY must run outside a transaction).
CREATE INDEX IF NOT EXISTS idx_orders_chain_status ON orders (chain_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_chain_active ON orders (chain_id, status, created_at) WHERE status = 'active';
-- [ADR-026 / A73 S-5] The 24 h infra-miss count (GET /api/monitor/keepers) filters on
-- chain_id + last_infra_miss_at; partial so it only holds rows that ever missed. Mirrors
-- supabase/migrations/20261104120000_orders_infra_miss.sql (build it CONCURRENTLY on a live table).
CREATE INDEX IF NOT EXISTS idx_orders_last_infra_miss_at
  ON orders (chain_id, last_infra_miss_at)
  WHERE last_infra_miss_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_executions_order  ON order_executions (order_id);
-- [CHORE-KEEPER-RECORD-EXECUTIONS] Defense-in-depth idempotency for the keeper's per-fill
-- recording. One executeOrder tx emits exactly one OrderExecuted event, so tx_hash is unique
-- per fill. The keeper is ALREADY idempotent at the app layer (recordExecutionRow checks for an
-- existing row by tx_hash before inserting), so this index is OPTIONAL and the keeper does not
-- depend on it — it just hardens against duplicate fills from a concurrent writer. OPS: apply to
-- the LIVE Supabase DB manually (CI does NOT run migrations against prod); creation requires the
-- table to be free of duplicate tx_hash rows. Safe to re-run (IF NOT EXISTS).
CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_tx_hash ON order_executions (tx_hash);

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

-- [FEAT-DCA-FLOOR-TIERS] Keeper-written runtime config (web app READ-ONLY). Shape only; the keeper
-- writes it in a later goal. See supabase/migrations/20261011120000_orders_floor_tier_consent.sql.
CREATE TABLE IF NOT EXISTS keeper_runtime_config (
  chain_id              INTEGER PRIMARY KEY,
  no_price_fill_cap_usd NUMERIC,
  keeper_version        TEXT,
  updated_at            TIMESTAMPTZ,
  -- [fix/executor-alert-masking-rpc-auth] INC-2026-10-30-001: NULL = working, 'rpc-auth' = the RPC
  -- provider rejects the keeper's credentials. Reporting only. See
  -- supabase/migrations/20261031120000_keeper_runtime_config_paused.sql.
  paused                TEXT
    CONSTRAINT keeper_runtime_config_paused_valid CHECK (paused IS NULL OR paused IN ('rpc-auth')),
  paused_since          TIMESTAMPTZ
);
ALTER TABLE keeper_runtime_config ENABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════
-- [ADR-027 / feat/split-dca-coordinator] Split DCA ("basket"): baskets, orders.basket_id and the decision
-- journal basket_ticks. The statements below are the body of
-- supabase/migrations/20261116120000_baskets_split_dca.sql, copied unchanged (its header
-- explains each choice; basket-coordinator.test.mjs fails if the two drift apart).
-- ══════════════════════════════════════════════════════════════

-- ── baskets ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS baskets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  wallet          TEXT NOT NULL,                       -- owner of the three orders, lowercase 0x…
  chain_id        INTEGER NOT NULL,
  token_in        TEXT NOT NULL,                       -- the token sold, lowercase 0x…
  capital         TEXT NOT NULL,                       -- C in raw units of token_in (text, as orders.amount_in)

  cadence_s       INTEGER NOT NULL,                    -- T, seconds between ticks; every leg's dcaInterval is T / 2
  cycles          INTEGER NOT NULL,                    -- N nominal cycles (3 grace ticks follow)
  t0              BIGINT NOT NULL,                     -- start, unix seconds (the unit of orders.expiry, which derives from it)
  first_buy       TEXT NOT NULL DEFAULT 'reference',   -- 'reference' | 'now'
  mode            TEXT NOT NULL,                       -- rule 9: 'soft' | 'rigid'
  threshold_bps   INTEGER NOT NULL,                    -- rule 9 threshold, 2500 = 25%
  stable_leg      SMALLINT,                            -- 0 | 1 | 2 = the leg under the peg band; NULL = none
  band_bps        INTEGER,                             -- the peg band, 100 = 1%; NULL without a stable leg
  band_ack_at     TIMESTAMPTZ,                         -- when the user accepted a band above 10%
  status          TEXT NOT NULL DEFAULT 'active',      -- 'active' | 'completed' | 'expired' | 'cancelled'

  -- The three legs, in order (the leg index is in the column name).
  leg0_token_out  TEXT NOT NULL,                       -- what leg 0 buys: lowercase 0x…
  leg0_n          INTEGER NOT NULL,                    -- its chunk count: the leg order's dcaTotal
  leg0_weight_num INTEGER NOT NULL,                    -- its weight as a fraction: numerator
  leg0_weight_den INTEGER NOT NULL,                    -- and denominator (33-33-33 is 1 / 3)
  leg0_order_hash TEXT NOT NULL,                       -- orders.order_hash of the leg order

  leg1_token_out  TEXT NOT NULL,                       -- what leg 1 buys
  leg1_n          INTEGER NOT NULL,
  leg1_weight_num INTEGER NOT NULL,
  leg1_weight_den INTEGER NOT NULL,
  leg1_order_hash TEXT NOT NULL,

  leg2_token_out  TEXT NOT NULL,                       -- what leg 2 buys
  leg2_n          INTEGER NOT NULL,
  leg2_weight_num INTEGER NOT NULL,
  leg2_weight_den INTEGER NOT NULL,
  leg2_order_hash TEXT NOT NULL,

  -- Addresses are stored lowercase (case-sensitive match), so they compare equal to the lowercased
  -- orders.wallet / token_in / token_out and to the lowercased wallet claim of the read policy.
  CONSTRAINT baskets_wallet_valid CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT baskets_token_in_valid CHECK (token_in ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT baskets_leg_tokens_valid CHECK (
    leg0_token_out ~ '^0x[0-9a-f]{40}$'
    AND leg1_token_out ~ '^0x[0-9a-f]{40}$'
    AND leg2_token_out ~ '^0x[0-9a-f]{40}$'
  ),
  -- Exactly three DIFFERENT legs, none of them the token sold (SPEC §2).
  CONSTRAINT baskets_leg_tokens_distinct CHECK (
    leg0_token_out <> leg1_token_out
    AND leg0_token_out <> leg2_token_out
    AND leg1_token_out <> leg2_token_out
    AND token_in <> leg0_token_out
    AND token_in <> leg1_token_out
    AND token_in <> leg2_token_out
  ),
  CONSTRAINT baskets_capital_valid CHECK (capital ~ '^[1-9][0-9]*$'),
  -- T / 2 must be a whole number of seconds: it is the legs' dcaInterval and the second slot.
  CONSTRAINT baskets_cadence_valid CHECK (cadence_s > 0 AND cadence_s % 2 = 0),
  CONSTRAINT baskets_cycles_valid CHECK (cycles BETWEEN 1 AND 10000),
  CONSTRAINT baskets_t0_valid CHECK (t0 > 0),
  CONSTRAINT baskets_first_buy_valid CHECK (first_buy IN ('reference', 'now')),
  CONSTRAINT baskets_mode_valid CHECK (mode IN ('soft', 'rigid')),
  -- Above 0: a threshold of 0 would pause every leg at its first price (SPEC §4, Coordinator rules).
  CONSTRAINT baskets_threshold_valid CHECK (threshold_bps BETWEEN 1 AND 9999),
  -- A band exactly when there is a stable leg. Written so that a NULL on one side is refused
  -- (a CHECK passes on NULL, so every branch tests IS NULL / IS NOT NULL itself).
  CONSTRAINT baskets_stable_band_valid CHECK (
    (stable_leg IS NULL AND band_bps IS NULL)
    OR (
      stable_leg IS NOT NULL AND band_bps IS NOT NULL
      AND stable_leg IN (0, 1, 2)
      AND band_bps BETWEEN 1 AND 9999
    )
  ),
  CONSTRAINT baskets_status_valid CHECK (status IN ('active', 'completed', 'expired', 'cancelled')),
  CONSTRAINT baskets_leg_n_valid CHECK (
    leg0_n BETWEEN 1 AND 10000
    AND leg1_n BETWEEN 1 AND 10000
    AND leg2_n BETWEEN 1 AND 10000
  ),
  -- Weights are fractions (33-33-33 is thirds, not 0.33): positive, no leg above 50%, sum exactly 1.
  -- "num <= den / 2" (integer division) is "2 × num <= den" without a product that could overflow;
  -- the denominators are bounded so the cross products stay far inside BIGINT.
  CONSTRAINT baskets_leg_weights_valid CHECK (
    leg0_weight_num >= 1 AND leg1_weight_num >= 1 AND leg2_weight_num >= 1
    AND leg0_weight_den BETWEEN 1 AND 10000
    AND leg1_weight_den BETWEEN 1 AND 10000
    AND leg2_weight_den BETWEEN 1 AND 10000
    AND leg0_weight_num <= leg0_weight_den / 2
    AND leg1_weight_num <= leg1_weight_den / 2
    AND leg2_weight_num <= leg2_weight_den / 2
    AND leg0_weight_num::BIGINT * leg1_weight_den * leg2_weight_den
      + leg1_weight_num::BIGINT * leg0_weight_den * leg2_weight_den
      + leg2_weight_num::BIGINT * leg0_weight_den * leg1_weight_den
      = leg0_weight_den::BIGINT * leg1_weight_den * leg2_weight_den
  ),
  CONSTRAINT baskets_leg_order_hashes_valid CHECK (
    leg0_order_hash ~* '^0x[0-9a-f]{64}$'
    AND leg1_order_hash ~* '^0x[0-9a-f]{64}$'
    AND leg2_order_hash ~* '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT baskets_leg_order_hashes_distinct CHECK (
    lower(leg0_order_hash) <> lower(leg1_order_hash)
    AND lower(leg0_order_hash) <> lower(leg2_order_hash)
    AND lower(leg1_order_hash) <> lower(leg2_order_hash)
  )
);

-- The keeper polls its own chain's active baskets; the API lists a wallet's baskets.
CREATE INDEX IF NOT EXISTS idx_baskets_chain_active ON baskets (chain_id, created_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_baskets_wallet ON baskets (wallet);

COMMENT ON TABLE baskets IS
  'Split DCA basket: three V3 DCA orders (one per leg, in order) and the parameters the keeper selects with. ADR-027, SPEC-BASKET-DCA §5.';
COMMENT ON COLUMN baskets.t0 IS
  'Start, unix seconds. first_buy = reference: ticks at t0 + (t + 1) × cadence_s; first_buy = now: at t0 + t × cadence_s; t = 0 … cycles + 2.';
COMMENT ON COLUMN baskets.first_buy IS
  'reference: the keeper records the three prices at first sight (journal tick -1) and the first purchase is one cycle later. now: the first purchase is at t0 and leg 0 is the token the user chose.';
COMMENT ON COLUMN baskets.stable_leg IS
  'Leg index (0 | 1 | 2) of the stable leg, whose price comes with band_add and is checked against band_bps (SPEC §4a). NULL = no stable leg.';
COMMENT ON COLUMN baskets.status IS
  'active | completed (every leg complete) | expired (after the last grace tick) | cancelled. completed and expired are written by the keeper, cancelled by the API.';

-- ── orders.basket_id ────────────────────────────────────────────────────────────────────────────
-- A leg order. NULL for every existing order. RESTRICT: nothing deletes a basket (cancel is a
-- status), and a basket that still has orders must not be deletable by mistake.
-- The ADD COLUMN takes an ACCESS EXCLUSIVE lock on `orders`, briefly: no rewrite, nothing to
-- validate. lock_timeout bounds the WAIT for that lock: behind a long transaction the statement
-- fails after 5 s instead of queueing every keeper and API query on `orders` behind it; re-run it
-- later. RESET puts the session back as it was.
-- No index on `orders` is built in this file: a plain CREATE INDEX blocks writes to the table for a
-- whole scan. OWNER STEP, on the live database, after this migration, as a statement of its own
-- (CONCURRENTLY cannot run inside a transaction block):
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_basket_id
--       ON orders (basket_id) WHERE basket_id IS NOT NULL;
SET lock_timeout = '5s';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS basket_id UUID REFERENCES baskets(id) ON DELETE RESTRICT;

COMMENT ON COLUMN orders.basket_id IS
  'The basket this order is a leg of (Split DCA, ADR-027). NULL = an ordinary order. A leg order executes only when the journal row of the current tick picked it (SPEC-BASKET-DCA §6).';
RESET lock_timeout;

-- ── basket_ticks (the decision journal) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS basket_ticks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- the database's clock when the row arrived

  basket_id         UUID NOT NULL REFERENCES baskets(id) ON DELETE RESTRICT,
  tick              INTEGER NOT NULL,                    -- -1 = the reference row; 0 … cycles + 2 = a decided tick
  decided_at        TIMESTAMPTZ NOT NULL,                -- the keeper's clock at the decision

  -- Per leg: the decision price (NULL = no usable price) and where it came from.
  leg0_price        DOUBLE PRECISION,
  leg0_price_source TEXT,
  leg1_price        DOUBLE PRECISION,
  leg1_price_source TEXT,
  leg2_price        DOUBLE PRECISION,
  leg2_price_source TEXT,
  -- The other half of the stable leg's price pair (SPEC §4a): the feed's deviation threshold when
  -- its own feed decided, 0 when the quorum did. NULL: no stable leg, or it had no price.
  band_add          DOUBLE PRECISION,

  -- The selection module's output, as returned (NULL on the reference row).
  per_leg           JSONB,                               -- [{ variation, protected, inBand, reason } × 3]
  picks             JSONB,                               -- [{ leg, kind, slot }], in decision order; [] = nothing picked
  next_state        JSONB,                               -- { legs: [{ n, done, last, entry } × 3], cooldown }
  idle_reason       TEXT,                                -- why nothing was picked; NULL when something was

  CONSTRAINT basket_ticks_basket_tick_unique UNIQUE (basket_id, tick),
  CONSTRAINT basket_ticks_tick_valid CHECK (tick >= -1),
  -- A price is a positive finite double. In PostgreSQL NaN sorts above Infinity, so "< Infinity"
  -- refuses both.
  CONSTRAINT basket_ticks_prices_valid CHECK (
    (leg0_price IS NULL OR (leg0_price > 0 AND leg0_price < 'Infinity'::DOUBLE PRECISION))
    AND (leg1_price IS NULL OR (leg1_price > 0 AND leg1_price < 'Infinity'::DOUBLE PRECISION))
    AND (leg2_price IS NULL OR (leg2_price > 0 AND leg2_price < 'Infinity'::DOUBLE PRECISION))
  ),
  -- A source exactly when there is a price.
  CONSTRAINT basket_ticks_sources_valid CHECK (
    (leg0_price IS NULL) = (leg0_price_source IS NULL)
    AND (leg1_price IS NULL) = (leg1_price_source IS NULL)
    AND (leg2_price IS NULL) = (leg2_price_source IS NULL)
  ),
  CONSTRAINT basket_ticks_band_add_valid CHECK (
    band_add IS NULL OR (band_add >= 0 AND band_add < 'Infinity'::DOUBLE PRECISION)
  ),
  -- The reference row holds prices only; a tick row holds the whole decision.
  CONSTRAINT basket_ticks_row_shape CHECK (
    (tick = -1 AND per_leg IS NULL AND picks IS NULL AND next_state IS NULL AND idle_reason IS NULL)
    OR (tick >= 0 AND per_leg IS NOT NULL AND picks IS NOT NULL AND next_state IS NOT NULL)
  ),
  CONSTRAINT basket_ticks_json_valid CHECK (
    (per_leg IS NULL OR jsonb_typeof(per_leg) = 'array')
    AND (picks IS NULL OR jsonb_typeof(picks) = 'array')
    AND (next_state IS NULL OR jsonb_typeof(next_state) = 'object')
  ),
  -- The selection module's IDLE_REASONS (basket-scheduler.js), pinned by basket-coordinator.test.mjs.
  CONSTRAINT basket_ticks_idle_reason_valid CHECK (
    idle_reason IS NULL OR idle_reason IN ('calendar', 'complete', 'no_price', 'band', 'rule9', 'rule5')
  )
);

COMMENT ON TABLE basket_ticks IS
  'Split DCA decision journal: one row per basket per tick, written BEFORE any transaction of that tick is sent and never rewritten. tick -1 is the reference row. ADR-027, SPEC-BASKET-DCA §4 (Coordinator rules) and §5.';
COMMENT ON COLUMN basket_ticks.tick IS
  '-1 = the reference row (prices recorded at first sight, no decision). 0 … cycles + 2 = a decided tick. A tick with no row was missed and is never decided late.';
COMMENT ON COLUMN basket_ticks.leg0_price IS
  'Decision price of leg 0 as a double, never rounded; NULL = no usable price. last = the latest row with a price (reference row included); entry = the first TICK row with a price. Same for leg1_price, leg2_price.';
COMMENT ON COLUMN basket_ticks.next_state IS
  'The selection module''s `next` as returned. cooldown feeds the next tick; legs[i].done is the executed count at the decision, which tells an executed pick from one still due. last and entry are NOT read back from here.';

-- ── Row level security ──────────────────────────────────────────────────────────────────────────
ALTER TABLE baskets ENABLE ROW LEVEL SECURITY;
ALTER TABLE basket_ticks ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (API routes, keeper). A user reads their own baskets and journal, on
-- the same wallet claim as "Users can view own orders" / "Users can view own executions".
-- No INSERT, UPDATE or DELETE policy: none of those is ever a user's to do directly.
DROP POLICY IF EXISTS "Users can view own baskets" ON baskets;
CREATE POLICY "Users can view own baskets"
  ON baskets FOR SELECT
  USING (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet_address')
  );

DROP POLICY IF EXISTS "Users can view ticks of own baskets" ON basket_ticks;
CREATE POLICY "Users can view ticks of own baskets"
  ON basket_ticks FOR SELECT
  USING (
    basket_id IN (
      SELECT id FROM baskets
      WHERE wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet_address')
    )
  );
