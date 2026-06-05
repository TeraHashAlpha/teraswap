# Sprint 18 — Fix monitoring-loop Test Suite

**Date:** 2026-05-18
**Architect:** Claude (Senior Architect)
**Closes:** 18 pre-existing test failures in `monitoring-loop.test.ts`
**Branch:** `fix/monitoring-loop-tests` (single branch, single PR)
**Estimated effort:** ~0.1 pw (1 prompt)

---

## Motivation

`monitoring-loop.test.ts` has 18 tests that all fail. These failures have been
pre-existing across Sprint 16A, 16B, and 17 — consistently excluded from pass
counts. The root cause is NOT broken test logic: every `it()` block is
structurally sound. The problem is **4 missing `vi.mock()` calls** for modules
added to `monitoring-loop.ts` in earlier sprints but never mocked in the test
file. This causes a module-load crash, which fails all 18 tests simultaneously.

**Deploy strategy:** Single branch `fix/monitoring-loop-tests`, one commit,
one PR. Test-only change — zero production code modified.

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 124 | Fix monitoring-loop.test.ts — add 4 missing mocks | 10 | 2 | 0.95 | 0.1 | 190.0 | P0 |

---

## Prompt 124 — Fix monitoring-loop.test.ts: Add Missing Module Mocks

**Context:** `src/lib/monitoring-loop.test.ts` has 18 `it()` blocks that all fail on every CI run. The source file `src/lib/monitoring-loop.ts` has accumulated 4 new imports across sprints that were never mocked in the test file:

1. `./on-chain-monitor` — added in commit `d46190f` (P47). Imports `shouldRunOnChainScan`, `runOnChainScan`. The module transitively imports `createPublicClient` from viem and `ORDER_EXECUTOR_ADDRESS` from `./order-engine/config`, which reads env vars at module init. **This is the primary crash cause** — module-load fails when env vars are absent.

2. `./surplus-report` — added in commit `3586a53` (P119, Sprint 16B). Imports `maybeSendWeeklyReport`. The module imports `getSupabase` and `kv`, and `sendTelegramMessage` calls real `fetch`.

3. `./circuit-breaker` — added in commit `603f24b` (P46). Imports `checkCircuitBreaker`. Without mock, real circuit-breaker logic runs against mocked KV and produces unexpected fields in the tick result.

4. `@/lib/supabase` — added in commit `75d6cb7` (Supabase keepalive feature). Imports `getSupabase`. Without mock, `createClient()` from `@supabase/supabase-js` tries to init with undefined env vars.

**Objective:** Add the 4 missing `vi.mock()` calls so all 18 tests pass.

**Requirements:**

1. Add these 4 mock declarations at the top of `monitoring-loop.test.ts` (alongside the existing mocks):

   ```typescript
   vi.mock('./on-chain-monitor', () => ({
     shouldRunOnChainScan: vi.fn().mockResolvedValue(false),
     runOnChainScan: vi.fn().mockResolvedValue(null),
   }))

   vi.mock('./surplus-report', () => ({
     maybeSendWeeklyReport: vi.fn().mockResolvedValue(false),
   }))

   vi.mock('./circuit-breaker', () => ({
     checkCircuitBreaker: vi.fn().mockResolvedValue(undefined),
   }))

   vi.mock('@/lib/supabase', () => ({
     getSupabase: vi.fn().mockReturnValue(null),
   }))
   ```

2. After adding the mocks, run the test file in isolation:
   ```bash
   npx vitest run src/lib/monitoring-loop.test.ts
   ```
   All 18 tests should pass.

3. If any individual test still fails after adding the mocks, it means there's an assertion mismatch (e.g., the tick result now includes a `circuitBreaker` or `onChainScan` field that the test doesn't expect). Fix the assertion to match the current source behavior — the source is correct, the test expectations are stale.

4. If the mock return values cause type errors, adjust them to match the actual type signatures:
   - `shouldRunOnChainScan` returns `Promise<boolean>`
   - `runOnChainScan` returns `Promise<OnChainScanResult | null>`
   - `maybeSendWeeklyReport` returns `Promise<boolean>`
   - `checkCircuitBreaker` returns `Promise<CircuitBreakerResult | undefined>`
   - `getSupabase` returns `SupabaseClient | null`

5. Run the full test suite after fixing:
   ```bash
   npm test
   ```
   Confirm the total count increases by 18 (from 610 to ~628).

**Do NOT:**
- Change ANY production code (only the test file)
- Change the behavior of existing mocks (only add new ones)
- Remove or skip any test
- Change the source file `monitoring-loop.ts`

**Files affected:**
- `src/lib/monitoring-loop.test.ts` (add 4 mock declarations + any stale assertion fixes)

**Quality criteria:**
- `npx vitest run src/lib/monitoring-loop.test.ts` → 18/18 pass
- `npm test` → all tests pass (previous 610 + 18 recovered = ~628)
- `npx tsc --noEmit` clean
- Zero changes to production code

---

## Execution order

Single prompt, single commit on `fix/monitoring-loop-tests`.

## Post-sprint checklist

- [ ] All 18 monitoring-loop tests passing
- [ ] Total test count ~628 (610 + 18)
- [ ] CI `test` job green (no more pre-existing exclusion needed)
- [ ] No production code changed
