-- ══════════════════════════════════════════════════════════
--  [fix/zerox-quote-hygiene T1] Telemetry for the FIRM swap-build step.
--  Date: 2026-09-12
--
--  0x warned (2026-09-12) our key risks throttling for "quote requests
--  without submitted trades". The existing `quotes` table (log-quote route)
--  records the /price META-FAN-OUT — every source, every 15s poll tick, by
--  every visitor. It does NOT record the FIRM /quote (swap-build) call each
--  adapter makes when a user actually clicks Swap (or an authenticated
--  /v1/swap POST) — src/lib/api.ts's fetchSwapFromSource, which for 0x means
--  its `/quote` endpoint (adapters/zerox.ts fetchSwapData). This table is
--  what lets us answer the question 0x's warning is actually about:
--  ATTEMPTS vs CONFIRMED TRADES, per source, per day.
--
--  Written by: src/lib/quote-build-monitor.ts (recordQuoteBuildAttempt),
--  called from every fetchSwapFromSource invocation (api.ts) — every
--  source, not just 0x, so the same infra answers this for any source a
--  future incident flags.
--
--  Idempotent — safe to run repeatedly.
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS quote_build_attempts (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,

  source      TEXT NOT NULL,                        -- e.g. '0x', '1inch', 'cowswap'
  chain_id    INTEGER NOT NULL DEFAULT 1,

  sell_token  TEXT NOT NULL,
  buy_token   TEXT NOT NULL,
  -- Bucketed to 4 significant figures (same bucketing the meta-quote cache
  -- key uses — see quantizeAmount, quote-cache.ts) so this table groups by
  -- trade-size class rather than storing exact user amounts.
  amount_bucket TEXT NOT NULL,

  -- 'built'         — the adapter returned usable swap calldata.
  -- 'sim-failed'     — the adapter/upstream answered but could not build a
  --                    swap for THIS request (no route, insufficient
  --                    liquidity, 4xx other than 429, unknown/disabled
  --                    source) — a deterministic, non-retryable outcome.
  -- 'upstream-error' — transient failure (timeout, network error, 5xx,
  --                    non-JSON body) — see isTransientSwapError,
  --                    swap-build-retry.ts, which classifyQuoteBuildOutcome
  --                    (quote-build-monitor.ts) mirrors.
  -- '429'            — the upstream rate-limited us, OR (0x only) our own
  --                    pre-emptive per-identity build cap (T3, api.ts)
  --                    skipped the call before ever reaching 0x.
  outcome     TEXT NOT NULL CHECK (outcome IN ('built', 'sim-failed', 'upstream-error', '429')),

  request_id  TEXT NOT NULL,
  -- Optional — only present when the caller supplied a wallet (the `from`
  -- address on a real swap-build call). No PII beyond what the existing
  -- `swaps` table already stores for the same wallet.
  wallet      TEXT
);

CREATE INDEX IF NOT EXISTS idx_qba_created_at        ON quote_build_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qba_source_created_at ON quote_build_attempts (source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qba_outcome           ON quote_build_attempts (outcome);

ALTER TABLE quote_build_attempts ENABLE ROW LEVEL SECURITY;
-- Service role bypasses RLS; logger_role gets the narrow INSERT grant below.
-- No policies — mirrors the existing swaps/quotes/usage_events/wallet_activity
-- tables (schema.sql), which use the same pattern.

-- logger_role (supabase/migrations/20260514_logger_role.sql) needs INSERT on
-- this NEW table explicitly — the original migration only granted the five
-- tables that existed at the time.
GRANT INSERT ON quote_build_attempts TO logger_role;
-- UUID PK via gen_random_uuid() — no sequence grant needed (matches quotes/swaps).

-- ══════════════════════════════════════════════════════════
--  Read-side: "attempts vs confirmed per source per day"
-- ══════════════════════════════════════════════════════════
--
-- attempts   = quote_build_attempts rows with outcome='built' for that
--              source/day — a real firm-quote call that got usable calldata
--              back (the thing 0x's warning counts against us, regardless
--              of whether the user went on to sign).
-- confirmed  = swaps rows with status='confirmed' for that source/day — an
--              actual on-chain trade.
--
-- A LOW confirmed/attempts ratio for a source is exactly the signal 0x
-- flagged: lots of quote traffic, few submitted trades.
CREATE OR REPLACE VIEW quote_build_daily_stats AS
SELECT
  COALESCE(a.day, c.day)       AS day,
  COALESCE(a.source, c.source) AS source,
  COALESCE(a.attempts, 0)      AS attempts,
  COALESCE(c.confirmed, 0)     AS confirmed,
  CASE WHEN COALESCE(a.attempts, 0) > 0
    THEN ROUND(COALESCE(c.confirmed, 0)::NUMERIC / a.attempts, 4)
    ELSE NULL
  END AS confirmed_per_attempt
FROM (
  SELECT date_trunc('day', created_at) AS day, source, COUNT(*) AS attempts
  FROM quote_build_attempts
  WHERE outcome = 'built'
  GROUP BY 1, 2
) a
FULL OUTER JOIN (
  SELECT date_trunc('day', created_at) AS day, source, COUNT(*) AS confirmed
  FROM swaps
  WHERE status = 'confirmed'
  GROUP BY 1, 2
) c ON a.day = c.day AND a.source = c.source
ORDER BY 1 DESC, 2;

-- ══════════════════════════════════════════════════════════
--  Read-side: per-source /price (indicative meta-fan-out) counts per day —
--  the `quotes` table already exists (schema.sql) but stores one row per
--  META-quote request with sources_responded as an array, not one row per
--  source. Unnest it here rather than duplicating that write path.
-- ══════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW quote_price_source_daily_stats AS
SELECT
  date_trunc('day', created_at) AS day,
  source,
  COUNT(*) AS price_responses
FROM quotes, unnest(sources_responded) AS source
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
