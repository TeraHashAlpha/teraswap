# CHORE-DCA-PRELAUNCH-FIXES — two LOW findings before DCA go-live

Two LOW findings surfaced by SPRINT-ORDER-ENGINE-TESTS (#199), both worth fixing before DCA launches.
Neither is security/gate-adjacent. Branch `chore/dca-prelaunch-fixes` off latest `origin/main` (after #199
merges, so the new tests are present to extend). CI + test-contracts green; SSH-signed commits; FEEDBACK.

## Fix 1 — client-side MIN_ORDER_AMOUNT floor (UX guard)
**Finding:** `useOrderEngine` lets an order whose per-execution amount is below the contract's
`MIN_ORDER_AMOUNT` (10000 base units) get EIP-712-signed + persisted to Supabase — it only reverts later
on-chain (`DCAChunkTooSmall` / `OrderTooSmall`). Wasted signature + bad UX (not a fund risk).
**Do:**
- Add a **pre-sign validation** in the order-creation flow that rejects, with a clear UX error, before
  signing/persisting, when the per-execution amount is below the floor:
  - DCA: `floor(amountIn / dcaTotal) < MIN_ORDER_AMOUNT`
  - non-DCA: `amountIn < MIN_ORDER_AMOUNT`
- **Single source of truth:** export `MIN_ORDER_AMOUNT` from one place (e.g. `order-engine/config.ts`) mirroring
  the contract's `10000`, and use it both in the guard and any display — so client and contract can't drift.
  Add a test/comment pinning it equal to the on-chain constant.

## Fix 2 — DCA omitted-param default symmetry (data-consistency)
**Finding:** for omitted DCA params, the **signed EIP-712 struct** uses `0n`/`1n` while the **Supabase**
record stores `null` — execution is unaffected (the `orderHash` binds the signed struct, which is the source
of truth), but the stored row disagrees with what was signed (a data-consistency smell that could mislead
analytics/debugging).
**Do:**
- Make the persisted Supabase values **exactly match the signed struct** for DCA params (and for non-DCA
  orders, store the same canonical default that was signed). The signed struct is canonical — persist what
  was signed, don't re-derive a different default on the write path.
- Add a test asserting the persisted record's DCA fields equal the signed struct's fields for both a DCA and a
  non-DCA order.

## Do NOT
- **No contract/Solidity changes** (the contract already enforces MIN_ORDER_AMOUNT — this is the client guard).
- No change to execution behaviour or the swap/gate paths. Mainnet byte-identical. Extend the #199 tests; keep
  them green.

## Output
- Branch `chore/dca-prelaunch-fixes`; the two fixes + tests; FEEDBACK noting the shared-constant location and
  the persist-symmetry change. No Auditor (both LOW, non-gate).
