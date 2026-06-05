# Audit Prompt — Sprint 25F (P156)

> **Date:** 2026-05-20
> **Branch:** `fix/fee-integrity-false-positive`
> **Commit:** `0143839`
> **PR:** #78
> **Spec:** `docs/Prompts/SPRINT-25F.md`

---

## Context

PR #77 (Sprints 25C–25E) merged to main. Fee integrity false positive
STILL fires because P150's guard (`!routeViaFeeCollector`) is now
always true — Sprint 25D made ALL sources fee-incompatible, so
`routeViaFeeCollector` is `false` for every swap.

P156 fixes this by guarding the check with `FEE_NATIVE_SOURCES.includes(source)`
instead. Since `FEE_NATIVE_SOURCES = []`, the check is inert for all current
sources — correct because no source uses partner-fee mode.

---

## Scope — what to audit

### P156 — Fee integrity guard: `!routeViaFeeCollector` → `FEE_NATIVE_SOURCES.includes(source)`

**Files modified:**
- `src/hooks/useSwap.ts` — guard change + import + 3-mode comment block
- `src/hooks/__tests__/swap-validations.test.ts` — refactored to 3-case structure
- `src/hooks/useSwap.test.ts` — mocked `FEE_NATIVE_SOURCES = ['1inch']` for M-01 wiring test

**Verify:**
1. The guard now reads `FEE_NATIVE_SOURCES.includes(source as AggregatorName)` — confirm
2. `FEE_NATIVE_SOURCES` is imported from constants, not hardcoded
3. `validateFeeIntegrity` function body in `src/lib/api.ts` is UNTOUCHED
4. `FEE_NATIVE_SOURCES` in constants.ts is UNTOUCHED (still `[]`)
5. `FEE_INCOMPATIBLE_SOURCES` is UNTOUCHED
6. Tests cover all 3 modes: FeeCollector (skip), partner-fee (run), fee-incompatible (skip)
7. 826 pass + 19 skip = 845 total tests (2 new tests added)

**Security focus:**
- The check is now inert. When we eventually add a source to `FEE_NATIVE_SOURCES`,
  the check auto-activates. Is there a risk of forgetting to test this when adding
  a partner-fee source? (INFO-level at most — the test coverage ensures it fires)
- No fund-flow changes. No contract interaction changes. Pure client-side guard.

---

## Output format

Produce `Audits/SPRINT-25F-AUDIT.md` — summary table, findings by severity,
spec deviations, verdict (APPROVED/REJECTED).
