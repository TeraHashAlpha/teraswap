-- ══════════════════════════════════════════════════════════
--  [P103 / 13A-L-01] Server-side aggregate for gasless stats.
--  Sprint 14 — Date: 2026-05-14
--
--  /api/stats was pulling every gasless row back to Node just to
--  call .reduce() on gas_savings_usd. Same answer, but O(N)
--  network + memory. This RPC moves the SUM into Postgres so
--  the COUNT and SUM travel back as a single 2-column row.
--
--  STABLE is the right volatility class — the function reads
--  swaps and never writes, but its result depends on data the
--  planner can't see as constant. STABLE lets Postgres reuse
--  the result within a single statement.
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION gasless_stats()
RETURNS TABLE(total_gasless bigint, total_gas_saved numeric) AS $$
  SELECT
    COUNT(*),
    COALESCE(SUM(gas_savings_usd), 0)
  FROM swaps
  WHERE is_gasless = true
    AND (status = 'confirmed' OR (status = 'pending' AND tx_hash IS NOT NULL))
$$ LANGUAGE sql STABLE;
