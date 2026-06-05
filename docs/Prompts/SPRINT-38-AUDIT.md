# Sprint 38 Audit — Bug Fixes (DigitRoller, Symbols, Dismiss)

**Role:** You are a Senior Security Auditor reviewing Sprint 38 of the TeraSwap DEX aggregator. Your job is to verify correctness, safety of state management, and test coverage.

**Branch:** `fix/sprint-38-bugfixes`  
**Base:** `main`  
**Commits:** 4 (P195 `553b86f`, P196 `044044f`, P197 `de81dcc`, P198 `2a41571`)  
**Files changed:** `src/components/SwapBox.tsx`, `src/hooks/useOrderEngine.ts`, possibly `src/lib/order-engine/supabase.ts`, test files  
**Test count:** 1165 → 1172 (+7 new, 1 adapted)

**Risk level:** LOW — all changes are UI/state layer. No contract, API route, or blockchain interaction changes.

---

## Context

Sprint 38 fixes three user-reported bugs:

1. **P195 — DigitRoller invisible during polling:** The ternary in SwapBox showed `...` loading dots during every 15s quote refresh, hiding the roller. Fix: condition on `meta?.best` (real "quote exists" signal) instead of `outputDisplay` (which defaults to `'0.0'`, always truthy).

2. **P196 — Cancelled orders showing `?` symbols:** `rowToOrder()` hardcoded `tokenInSymbol: ''` / `tokenOutSymbol: ''` instead of reading from Supabase row. Fix: read `token_in_symbol` / `token_out_symbol` from the row.

3. **P197 — Cancelled orders reappearing:** `removeOrder()` only removed from React state, not persisted. Fix: localStorage `teraswap_dismissed_orders` list + filter on mount sync.

**Code Agent deviations (FEEDBACK.md):**
- P195: Used `meta?.best` instead of spec's `outputDisplay` condition (correct — `outputDisplay` defaults to `'0.0'`)
- P197: Guarded ALL terminal orders (not just cancelled) for dismiss — broader fix
- P198: Adapted 1 existing test to use terminal order instead of active order

---

## Audit Checklist

### 1. P195 — DigitRoller Visibility Fix

**Source file:** `src/components/SwapBox.tsx`

- [ ] **Ternary logic:** Verify the new condition uses `meta?.best` (or equivalent "quote exists" signal). When a quote exists, DigitRoller renders regardless of `quoteLoading`. When no quote exists and loading, dots show. When no quote and not loading, nothing renders.
- [ ] **No stale data flash:** During a poll refresh, the previous `meta` value persists (react-query / SWR pattern). Verify the DigitRoller does NOT briefly show stale data and then flash to new data — it should smoothly animate from old to new.
- [ ] **Initial load still shows dots:** On first render with no quote, the `...` pulse must still appear. Verify the dots branch is reachable.
- [ ] **No regression on loading state:** If the user clears the sell amount (empties input), the output should clear too (no stale roller showing old value).
- [ ] **outputDisplay still consumed:** DigitRoller's `value` prop still receives `outputDisplay`. Verify the value prop is unchanged.

### 2. P196 — Token Symbol Fix

**Source file:** `src/hooks/useOrderEngine.ts`

- [ ] **rowToOrder reads symbols:** `tokenInSymbol` and `tokenOutSymbol` populated from `row.token_in_symbol` and `row.token_out_symbol`. Verify null coalescing to `''`.
- [ ] **OrderRow interface updated:** `token_in_symbol` and `token_out_symbol` fields added to the TypeScript interface. Verify types are `string | null`.
- [ ] **No injection risk:** Token symbols come from Supabase (which got them from the order creation API). Verify they are rendered as text content, not dangerously set as HTML. Check `OrderDashboard.tsx` rendering — should be `{order.tokenInSymbol || '?'}` (safe JSX text interpolation).
- [ ] **Legacy orders:** Orders created before symbols were stored have `null` in the DB. Verify `null` → `''` → `'?'` fallback chain works.

### 3. P197 — Dismissed Order Persistence

**Source file:** `src/hooks/useOrderEngine.ts`

- [ ] **localStorage key:** `teraswap_dismissed_orders` stores JSON array of order IDs. Verify try/catch on parse (corrupt localStorage).
- [ ] **dismissOrder called on remove:** `removeOrder()` calls dismiss persistence before removing from state.
- [ ] **Filter on mount sync:** When orders load from Supabase, dismissed IDs are filtered out. Verify the filter runs BEFORE setting state.
- [ ] **Guard on terminal orders only:** Verify `removeOrder` is guarded — only terminal orders (cancelled, filled, expired, error) can be dismissed. Active orders must NOT be dismissable.
- [ ] **No Supabase deletion:** Cancelled orders must remain in the database for audit trail. Verify `removeOrder` does NOT call any Supabase delete/update endpoint.
- [ ] **localStorage size:** If a user accumulates thousands of dismissed orders over time, the localStorage array grows unboundedly. Assess whether this is a concern. Consider flagging if no cleanup/cap exists (INFO severity).
- [ ] **FE-01 interaction:** The project has a backlog item FE-01 (localStorage → Web Crypto V2). This new localStorage usage should be noted as part of that future migration scope. INFO severity.

### 4. P198 — Test Coverage

- [ ] **2 DigitRoller tests:** Verify coverage of "roller visible with quote" and "dots on initial load".
- [ ] **2 Symbol tests:** Verify `rowToOrder` with symbols and with null symbols.
- [ ] **3 Dismiss/guard tests:** Verify dismiss persistence, filter on load, and terminal-only guard.
- [ ] **1 adapted test:** Verify the existing test was minimally changed (intent preserved, only order type changed from active to terminal).
- [ ] **No mock bleed:** Each test isolates its mocks. localStorage mocks cleaned up in afterEach.

### 5. General

- [ ] **No scope creep:** Only SwapBox.tsx, useOrderEngine.ts, possibly supabase.ts types, and test files changed.
- [ ] **No new dependencies:** No new npm packages.
- [ ] **TypeScript:** `npm run typecheck` must pass.
- [ ] **Lint:** `npm run lint` must pass.
- [ ] **All tests:** `npm run test` must pass with 0 failures. Report actual test count.

---

## Expected Output

```markdown
## Sprint 38 Audit Verdict

**Branch:** fix/sprint-38-bugfixes
**Commits reviewed:** 553b86f, 044044f, de81dcc, 2a41571
**Tests:** {before} → {after}

### Verdict: {APPROVED | APPROVED WITH WARNINGS | REJECTED}

{0C / 0H / 0M / 0L / NI INFO}

### Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 38-{severity}-{NN} | {C/H/M/L/INFO} | {file} | {description} |

### FEEDBACK Deviations

| # | Deviation | Auditor Assessment |
|---|---|---|
| 1 | meta?.best condition instead of outputDisplay | {Accept / Flag / Fix required} |
| 2 | All terminal orders dismissable (not just cancelled) | {Accept / Flag / Fix required} |
| 3 | Adapted existing remove-active-order test | {Accept / Flag / Fix required} |

### Recommendation

{Merge / Fix required / ...}
```

Run `npm run typecheck`, `npm run lint`, and `npm run test` before delivering the verdict. Report the actual test count.
