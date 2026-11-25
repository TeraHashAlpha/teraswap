-- ══════════════════════════════════════════════════════════
--  [ADR-029 / fix/swap-log-verified-on-chain] swaps: record what the server saw on-chain.
--
--  Why (incident of 2026-11-20 and 2026-11-22, SEC-2 of the audit of 2026-11-17): POST and PATCH
--  /api/log-swap took every field from the caller, and about 110 invented rows reached `swaps`.
--  From this change on a row becomes `confirmed` or `failed` only by the server, after it read the
--  transaction on the row's chain (src/lib/swap-verify/verify-swap-on-chain.ts). This file gives
--  that fact a place to live:
--
--    - verified_at    when the server verified the row against the chain. NULL = never verified:
--                     a pending row, or a row written before this change. With the server flag
--                     SWAPS_PUBLIC_VERIFIED_ONLY on, public pages and totals read only rows where
--                     it is NOT NULL.
--    - verified_kind  how the transaction was recognised: 'fee_collector' (sent to that chain's
--                     FeeCollector), 'router' (sent to the router of the row's source on that
--                     chain) or 'cow' (a Trade event of that chain's CoW settlement contract whose
--                     owner is the wallet). CHECKed.
--    - idx_swaps_verified_tx  UNIQUE on (chain_id, lower(tx_hash)) WHERE verified_at IS NOT NULL:
--                     one transaction verifies at most one row. The route checks first; this index
--                     is what holds when two requests race.
--    - token_in, token_in_symbol, token_out, token_out_symbol, amount_in, amount_out lose NOT NULL
--                     (owner's decision, 2026-11-25). A side of a verified row comes from the
--                     receipt only; a side the receipt cannot give (ETH bought through a router
--                     leaves no log; two candidate tokens) is stored NULL, never as the caller's
--                     value, and is not counted in any USD total.
--
--  No visitor data: both columns are derived from public chain data and the clock.
--
--  Additive and forward-only. No existing row is rewritten: the two columns are NULL on every
--  existing row, DROP NOT NULL changes the catalog only, the CHECK accepts NULL, and the partial
--  index covers no row at the time it is built (no row is verified yet), so it cannot fail on
--  existing data. Existing rows are verified later by scripts/swaps/verify-stored-swaps.ts, in
--  report mode first; nothing is deleted.
--
--  The code works BEFORE this file is applied: while the two columns are missing, POST and PATCH
--  /api/log-swap write nothing, answer as before and log `swaps_verified_columns_missing` once per
--  request; every reader behaves as on main while the flag is off. Apply this file before turning
--  the flag on (a reader that filters on a missing column gets an error).
--
--  RLS: no change (RLS stays enabled with no policy; only the service role and the insert-only
--  logger_role reach the table). Grants: no change.
--
--  Idempotent (IF NOT EXISTS; the constraint is added only when absent) — safe to re-run.
--  OPS: apply to the LIVE Supabase DB MANUALLY (CI does NOT run migrations against prod), before
--  the deploy if possible (ADR-029 decision 8). This file was written and reviewed as text; it was
--  NOT run against any database (the goal that produced it forbids touching one, and no local
--  Postgres was available). Each ALTER takes a brief ACCESS EXCLUSIVE lock on `swaps`, its wait
--  bounded by lock_timeout (5 s): behind a long transaction it fails fast instead of queueing every
--  log-swap write behind it. The CHECK is added NOT VALID and validated in a second statement,
--  which only takes SHARE UPDATE EXCLUSIVE. The index build takes a SHARE lock (writes wait, reads
--  do not) for the time it takes to scan a table of a few thousand rows; to avoid even that, run
--  this one statement on its own instead (CONCURRENTLY cannot run inside a transaction block, and
--  the Supabase SQL editor wraps a multi-statement run in one):
--      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_swaps_verified_tx
--        ON swaps (chain_id, lower(tx_hash)) WHERE verified_at IS NOT NULL;
--  Mirrored at the end of supabase/schema.sql.
-- ══════════════════════════════════════════════════════════

SET lock_timeout = '5s';

ALTER TABLE swaps ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS verified_kind TEXT;

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
  ON swaps (chain_id, lower(tx_hash))
  WHERE verified_at IS NOT NULL;

COMMENT ON COLUMN swaps.verified_at IS
  'When the server verified this row against the chain (the transaction exists on chain_id, it is this wallet''s swap, and its receipt gave the status). NULL = never verified: a pending row, or a row written before ADR-029. Set only by the server. ADR-029.';

COMMENT ON COLUMN swaps.verified_kind IS
  'How the verified transaction was recognised: fee_collector | router | cow. NULL exactly when verified_at is NULL. ADR-029.';

-- ROLLBACK (only while no row is verified; afterwards the two columns are the record of what the
-- server saw, and a verified row may hold a NULL side that NOT NULL would refuse):
--   DROP INDEX IF EXISTS idx_swaps_verified_tx;
--   ALTER TABLE swaps DROP CONSTRAINT IF EXISTS swaps_verified_kind_check;
--   ALTER TABLE swaps DROP COLUMN IF EXISTS verified_kind;
--   ALTER TABLE swaps DROP COLUMN IF EXISTS verified_at;
--   ALTER TABLE swaps
--     ALTER COLUMN token_in SET NOT NULL, ALTER COLUMN token_in_symbol SET NOT NULL,
--     ALTER COLUMN token_out SET NOT NULL, ALTER COLUMN token_out_symbol SET NOT NULL,
--     ALTER COLUMN amount_in SET NOT NULL, ALTER COLUMN amount_out SET NOT NULL;
