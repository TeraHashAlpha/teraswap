-- ══════════════════════════════════════════════════════════
--  [P96] Gasless tracking columns on the swaps table.
--  Sprint 13A — Date: 2026-05-13
--
--  Adds two columns so we can answer:
--    * How many of our swaps go through gasless (CoW) routes?
--    * How much gas have we saved users in aggregate?
--
--  Backwards-compatible: DEFAULT false / 0; existing rows are
--  populated with the defaults on alter. Index on is_gasless
--  speeds up the ratio query used by /api/stats.
-- ══════════════════════════════════════════════════════════

ALTER TABLE swaps
  ADD COLUMN IF NOT EXISTS is_gasless     BOOLEAN          NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gas_savings_usd NUMERIC(12,4)  NOT NULL DEFAULT 0;

-- Partial index — only rows we actually filter on. Keeps index size small
-- and makes the COUNT(*) WHERE is_gasless query a sub-millisecond lookup.
CREATE INDEX IF NOT EXISTS idx_swaps_is_gasless
  ON swaps(is_gasless)
  WHERE is_gasless = true;

-- Backfill: cowswap swaps already in the table were gasless by definition.
-- Safe to run repeatedly because it only writes rows that aren't already
-- flagged. Gas savings can't be reconstructed historically, so we leave
-- gas_savings_usd at 0 for the backfilled rows.
UPDATE swaps
SET is_gasless = true
WHERE source = 'cowswap'
  AND is_gasless = false;
