-- ══════════════════════════════════════════════════════════
--  [ADR-027 / feat/split-dca-coordinator] Split DCA ("basket"): the data model.
--  docs/Prompts/SPEC-BASKET-DCA.md §5, plus what the Coordinator rules of §4 need.
--
--  One basket is three ordinary V3 DCA orders, one per leg (ADR-027 §2). The keeper decides, at
--  each tick, which legs sell a chunk; that decision is written to a journal BEFORE anything is
--  sent, and is read back, never taken twice, after a restart.
--
--    baskets           one row per basket: its parameters and its three legs IN ORDER. The leg
--                      index (0, 1, 2) is in the column name because the order is data: the
--                      selection rules break ties by leg index, and in 'now' mode leg 0 is the
--                      token the user chose to buy first.
--    basket_ticks      the decision journal: one row per basket per tick (tick = -1 is the
--                      reference row: prices only, no decision). UNIQUE (basket_id, tick) is what
--                      makes "decide once" hold between two keeper processes.
--    orders.basket_id  NULL for every existing order and for every order that is not a leg.
--
--  Decision prices and band_add are DOUBLE PRECISION, never NUMERIC: they are the doubles the
--  selection module decided with, and the next tick's variation divides by them. float8 returns
--  the same double it was given (PostgreSQL 12+ prints the shortest text that round-trips); a
--  NUMERIC(p, s) would round. per_leg, picks and next_state are the module's own output, stored as
--  returned (JSONB keeps a JSON number as the exact decimal it was written with).
--
--  No visitor data: a basket holds the wallet, chain and tokens its three orders already hold,
--  and nothing about the browser, the IP or the session.
--
--  Additive and forward-only. orders.basket_id is nullable with no default, so no existing row
--  changes and the keeper (executor.js reads orders with select=*) is unaffected: nothing reads
--  these tables or this column until the keeper wiring and the API ship (SPEC §10 items 3-4).
--  The columns of the two NEW tables are NOT NULL wherever a missing value could only be a bug.
--
--  RLS as for `orders`: enabled; the service role (API routes, keeper) bypasses it; a user reads
--  only their own rows, matched on the same verified wallet claim as "Users can view own orders".
--  Deliberately NOT copied from `orders`: the user INSERT and UPDATE policies. A basket is created
--  and cancelled only by the server, which checks the feed registry, the keeper's capability flag
--  and the three signatures, and cancels the basket and its three orders at once (SPEC §7, §11).
--  basket_ticks is written by the keeper only.
--
--  Idempotent (IF NOT EXISTS; policies dropped and recreated) — safe to re-run.
--  OPS: apply to the LIVE Supabase DB MANUALLY (CI does NOT run migrations against prod), BEFORE
--  the keeper and API releases that use it. This file was written and reviewed as text; it was not
--  run against any database (the goal that produced it forbids touching one). The ADD COLUMN on
--  `orders` takes a brief ACCESS EXCLUSIVE lock, its wait bounded by lock_timeout (5 s); there is
--  nothing to validate (every value is NULL) and no table rewrite. The partial index on
--  orders.basket_id is NOT built by this file: it is an owner step, CONCURRENTLY, written out at
--  the orders.basket_id section below (audit of 2026-11-16, S-8).
--  Mirrored in contracts/order-engine/schema.sql.
-- ══════════════════════════════════════════════════════════

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

-- ROLLBACK (only while no basket exists; afterwards the journal is a record of fund-flow decisions):
--   DROP POLICY IF EXISTS "Users can view ticks of own baskets" ON basket_ticks;
--   DROP POLICY IF EXISTS "Users can view own baskets" ON baskets;
--   DROP TABLE IF EXISTS basket_ticks;
--   DROP INDEX IF EXISTS idx_orders_basket_id;   (if the owner step built it)
--   ALTER TABLE orders DROP COLUMN IF EXISTS basket_id;
--   DROP TABLE IF EXISTS baskets;
--   (Nothing reads these objects until the keeper wiring and the API ship.)
