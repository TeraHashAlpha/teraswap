# Sprint 16B — Positive Slippage Instrumentation

**Date:** 2026-05-16
**Architect:** Claude (Senior Architect)
**Closes:** ADR-006 § Pre-build instrumentation
**Branch:** `feat/surplus-instrumentation` (single branch, single PR)
**Estimated effort:** ~0.5 pw (3 prompts)

---

## Motivation

ADR-006 recommends instrumenting surplus data for 30 days before deciding
on FeeCollector V3. Today the post-execution validator computes surplus
(L278 of `post-execution-validator.ts`) but does NOT persist it to
Supabase for non-CoW routes. The `mev_savings_actual` column exists but
is only written by the CoW poll flow. We need:

1. **All sources** writing surplus to `swaps.mev_savings_actual` on confirmation.
2. A new `swaps.expected_output` column so we can distinguish "beat the quote" from "beat the minimum."
3. A weekly Telegram report summarising surplus by source — the data that
   will drive the V3 build/defer decision.

**Deploy strategy:** Single branch `feat/surplus-instrumentation`, all 3
prompts committed sequentially, one PR, one Vercel build.

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 117 | Persist surplus for all sources | 8 | 2 | 0.9 | 0.15 | 96.0 | P0 |
| 118 | Add expected_output column + frontend pass-through | 7 | 2 | 0.8 | 0.15 | 74.7 | P1 |
| 119 | Weekly surplus Telegram report | 5 | 1 | 0.8 | 0.2 | 20.0 | P2 |

---

## Prompt 117 — Persist Surplus for All Sources on Swap Confirmation

**Context:** `src/lib/post-execution-validator.ts:278-279` computes `surplus = actual - expected` for every validated swap. The result is written to a KV audit trail (7-day TTL) but NOT to `swaps.mev_savings_actual`. The `log-swap` PATCH endpoint (L200-215) already accepts `mevSavingsActual` and writes it to the swaps table. The missing link: the frontend confirmation flow doesn't pass the validator's surplus to the PATCH call.

**Objective:** After swap confirmation, persist the validator's surplus value to `swaps.mev_savings_actual` via the existing PATCH endpoint.

**Requirements:**

1. In `src/lib/post-execution-validator.ts`, add `surplusWei: string | null` to the `ExecutionValidation` interface. Populate it when `actual >= expected` (L276-292):
   ```typescript
   surplusWei: surplus > 0n ? surplus.toString() : null
   ```
   Set to `null` for shortfall / unknown cases.

2. In the frontend confirmation callback (wherever `validateExecution` result is consumed and the PATCH to `/api/log-swap` is called), pass `mevSavingsActual: result.surplusWei` in the PATCH body.

3. If the PATCH call already exists but doesn't include `mevSavingsActual`, add it. If there's no PATCH call after validation, add one that sends `{ txHash, mevSavingsActual: result.surplusWei }`.

4. Add 2 tests to `post-execution-validator.test.ts`:
   - Swap with surplus → `surplusWei` is non-null positive string
   - Swap with shortfall → `surplusWei` is null

**Do NOT:**
- Change the KV audit-trail write (keep it as-is, it's useful for debugging)
- Modify the POST path of log-swap (only the PATCH path)
- Change any contract or security validation logic

**Files affected:**
- `src/lib/post-execution-validator.ts` (add surplusWei to interface + result)
- `src/hooks/useSwap.ts` or wherever the PATCH callback lives
- `src/lib/post-execution-validator.test.ts` (2 new tests)

**Quality criteria:**
- `npm test` passes
- `npx tsc --noEmit` clean
- Surplus is persisted for ALL sources, not just CoW

---

## Prompt 118 — Add `expected_output` Column and Frontend Pass-Through

**Context:** ADR-006 § Data analysis needs `surplus = actual − expected` (quote amount) rather than `surplus = actual − minimum` (slippage-adjusted amount). The `swaps` table has `amount_out` (the quoted output) but this is set at swap initiation time and may not reflect the exact `expectedOutput` the validator uses. A dedicated column gives us clean semantics.

**Objective:** Add `swaps.expected_output` column and populate it from the frontend quote data at swap time.

**Requirements:**

1. **Supabase migration** `supabase/migrations/20260516_expected_output.sql`:
   ```sql
   ALTER TABLE swaps ADD COLUMN IF NOT EXISTS expected_output NUMERIC;
   COMMENT ON COLUMN swaps.expected_output IS 'Quoted output amount in raw token wei, before slippage tolerance. Used for surplus calculation (ADR-006).';
   -- Grant INSERT-capable column to logger_role (already has INSERT on swaps)
   -- No additional grant needed — INSERT on table covers all columns.
   ```

2. **log-swap POST** (`src/app/api/log-swap/route.ts`): Accept optional `expectedOutput` in the request body. Write to `expected_output` column in the INSERT (L102-135). Validate: must be a numeric string or null.

3. **Frontend**: In the swap execution flow, pass `expectedOutput: meta.best.toAmount` (the raw wei quote amount before slippage) to the `log-swap` POST call.

4. Add 1 test to `log-swap/route.test.ts`:
   - POST with `expectedOutput` → stored in DB

**Do NOT:**
- Change the PATCH path (expected_output is set once at swap time, not updated)
- Modify the validator logic (it still uses `expectedMinOutput` for its comparison)
- Add the column to any other table

**Files affected:**
- `supabase/migrations/20260516_expected_output.sql` (new)
- `src/app/api/log-swap/route.ts` (accept + insert expectedOutput)
- `src/hooks/useSwap.ts` or swap execution flow (pass expectedOutput)
- `src/app/api/log-swap/route.test.ts` (1 new test)

**Quality criteria:**
- `npm test` passes
- `npx tsc --noEmit` clean
- Migration is idempotent (IF NOT EXISTS)

---

## Prompt 119 — Weekly Surplus Report to Telegram

**Context:** ADR-006 recommends running query ① weekly and piping results to the Telegram ops channel. We already have the monitoring tick infrastructure (`src/lib/on-chain-monitor.ts`) that runs every 60s and sends to Telegram. We need a weekly report that summarises surplus by source.

**Objective:** Add a weekly surplus report that runs on Sundays at midnight UTC and sends a formatted summary to Telegram.

**Requirements:**

1. **New file** `src/lib/surplus-report.ts`:
   - `generateSurplusReport()` function that queries Supabase:
     ```sql
     SELECT source, COUNT(*) as swaps,
       COUNT(*) FILTER (WHERE mev_savings_actual > 0) as with_surplus,
       SUM(mev_savings_actual) as total_surplus_wei,
       AVG(mev_savings_actual) FILTER (WHERE mev_savings_actual > 0) as avg_surplus_wei
     FROM swaps
     WHERE status = 'confirmed'
       AND created_at > NOW() - INTERVAL '7 days'
     GROUP BY source ORDER BY total_surplus_wei DESC NULLS LAST
     ```
   - Format as a Telegram message with emoji and columns
   - Include: source, swap count, % with surplus, total surplus (formatted)
   - At the bottom, show projected monthly revenue at 30% capture rate

2. **Integrate with monitoring tick:** In `src/lib/on-chain-monitor.ts` (or a separate cron check), check if it's Sunday 00:xx UTC and the report hasn't been sent this week (use a KV flag `teraswap:surplus-report:last-sent`). If so, call `generateSurplusReport()` and send via `sendTelegramAlert()`.

3. **Fallback:** If the Supabase query fails or returns 0 rows, send a short "No surplus data this week" message instead of erroring.

4. Add 2 tests:
   - `surplus-report.test.ts`: mock Supabase → formatted message includes source names
   - Edge case: empty result → fallback message

**Do NOT:**
- Create a new cron job or Worker — reuse the existing tick
- Send to any channel other than the existing Telegram ops bot
- Make the report blocking (fire-and-forget, same as other monitoring)

**Files affected:**
- `src/lib/surplus-report.ts` (new)
- `src/lib/surplus-report.test.ts` (new)
- `src/lib/on-chain-monitor.ts` (add weekly report trigger)

**Quality criteria:**
- `npm test` passes
- `npx tsc --noEmit` clean
- Report only fires once per week (KV dedup)

---

## Execution order

All 3 prompts on the same branch `feat/surplus-instrumentation`:

1. P117 first (persists surplus — foundational)
2. P118 second (adds expected_output column — depends on understanding P117's flow)
3. P119 last (report — depends on data being written by P117)

One commit per prompt, one PR at the end, one deploy.

## Post-sprint

- Run migration `20260516_expected_output.sql` in Supabase SQL Editor (manual)
- After 30 days of data: run ADR-006 queries ① and ② to validate surplus magnitudes
- If monthly capturable > $500: move ADR-006 to Accepted, plan V3 in Sprint 17+
- If < $500: defer indefinitely

## Post-sprint checklist

- [ ] Migration `20260516_expected_output.sql` executed in Supabase Dashboard
- [ ] 7 days of surplus data accumulated
- [ ] First weekly Telegram report received
- [ ] ADR-006 status reviewed after 30-day window
