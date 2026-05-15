-- ══════════════════════════════════════════════════════════
--  [P118] Add expected_output column for surplus instrumentation.
--  Sprint 16B — Date: 2026-05-16
--
--  ADR-006 § Pre-build instrumentation needs:
--      surplus = actual_output - expected_output
--  where expected_output is the quoted output amount BEFORE
--  slippage tolerance is applied. The existing amount_out
--  column is set at swap initiation and may not reflect the
--  exact quote the validator uses; a dedicated column gives
--  us clean semantics for the ADR-006 weekly analysis queries.
--
--  Idempotent: IF NOT EXISTS — safe to re-run.
--  No grant required: logger_role already has INSERT on swaps
--  which covers all current and future columns.
-- ══════════════════════════════════════════════════════════

ALTER TABLE swaps ADD COLUMN IF NOT EXISTS expected_output NUMERIC;

COMMENT ON COLUMN swaps.expected_output IS
  'Quoted output amount in raw token wei, before slippage tolerance. Used for surplus calculation (ADR-006 / Sprint 16B).';
