# Sprint 38 — Bug Fixes (DigitRoller, Quote UX, Cancelled Orders)

**Sprint goal:** Fix three user-reported bugs: DigitRoller not visible during quote polling, missing token symbols on cancelled orders, and cancelled orders not clearing permanently.  
**Branch:** `fix/sprint-38-bugfixes` (from `main`)  
**Prerequisite:** Sprint 34 (DigitRoller) and Sprint 26 (V2 switch) merged to main.  
**Test count baseline:** 1165 (vitest count)

---

## Bug Context

1. **DigitRoller invisible:** The odometer animation never shows because `quoteLoading` is `true` during every 15s poll cycle, not just on initial load. The ternary replaces DigitRoller with `...` dots on every refresh.
2. **Cancelled orders showing `?`:** Token symbols are stored in Supabase but `rowToOrder()` in `useOrderEngine.ts` hardcodes them to empty strings. The fallback `|| '?'` in `OrderDashboard.tsx` then renders `?`.
3. **Cancelled orders not clearing:** `removeOrder()` only removes from React state and localStorage. If the app re-syncs from Supabase, cancelled orders reappear.

---

## P195 — Fix DigitRoller visibility during quote polling

### Context

- File: `src/components/SwapBox.tsx`, line ~543
- Current code:
  ```tsx
  {quoteLoading ? <span className="inline-block animate-pulse text-cream-35">...</span> : <DigitRoller value={outputDisplay} prefix="~" />}
  ```
- `quoteLoading` comes from the `useQuote` hook and is `true` during every 15s poll, not just initial load
- `outputDisplay` is derived from the quote result via `safeBigInt` (lines 381–386)
- Result: DigitRoller is replaced with `...` every 15 seconds, user never sees the animation

### Objective

Show DigitRoller when a quote value exists (even during refresh polling). Show loading dots only on initial load when no quote has been received yet.

### Requirements

1. In `src/components/SwapBox.tsx`, change the RECEIVE output display ternary (~line 543) from:

   ```tsx
   {quoteLoading
     ? <span className="inline-block animate-pulse text-cream-35">...</span>
     : <DigitRoller value={outputDisplay} prefix="~" />
   }
   ```

   To:

   ```tsx
   {outputDisplay
     ? <DigitRoller value={outputDisplay} prefix="~" />
     : quoteLoading
       ? <span className="inline-block animate-pulse text-cream-35">...</span>
       : null
   }
   ```

   Logic:
   - If `outputDisplay` has a value → show DigitRoller (regardless of polling state)
   - Else if loading → show pulse dots (initial load, no quote yet)
   - Else → render nothing (no input entered)

2. Verify that `outputDisplay` retains its previous value during a refresh poll. If `useQuote` clears the data during refetch, the DigitRoller would flash. Check that the quote data persists between polls (it should — `react-query` / `swr` patterns keep stale data while revalidating). If it does NOT persist, add a `useRef` to cache the last valid `outputDisplay`:

   ```tsx
   const lastOutputRef = useRef(outputDisplay)
   if (outputDisplay) lastOutputRef.current = outputDisplay
   const displayValue = outputDisplay || lastOutputRef.current
   ```

   Only add this ref if needed — check first.

3. The loading pulse (`...`) should ONLY appear when:
   - The user has entered a sell amount AND
   - No quote has been received yet (first load)
   
   Once a quote arrives, subsequent polls should NOT show the pulse — the DigitRoller stays visible with the last value and rolls to the new value when it arrives.

### Do NOT

- Do NOT change `useQuote` hook logic
- Do NOT change `outputDisplay` or `safeBigInt` derivation
- Do NOT change `QUOTE_REFRESH_MS` or any polling interval
- Do NOT change DigitRoller component itself
- Do NOT remove or change the prefix `"~"`

### Files affected

- `src/components/SwapBox.tsx` — RECEIVE output ternary (~line 543)

### Expected output

1 commit: `fix(swap): show DigitRoller during quote polling, dots only on initial load [P195]`

### Quality criteria

- DigitRoller visible immediately after first quote arrives
- DigitRoller stays visible during 15s refresh polls (no flicker to `...`)
- When new quote arrives, DigitRoller animates to new value
- Loading dots `...` only show before first quote
- No input → empty (no dots, no roller)
- All existing tests pass
- `npm run typecheck` passes

---

## P196 — Fix cancelled order token symbols

### Context

- File: `src/hooks/useOrderEngine.ts`, function `rowToOrder()` (~lines 154–181)
- The function maps Supabase rows to the internal `Order` type
- Lines ~168 and ~170 hardcode `tokenInSymbol: ''` and `tokenOutSymbol: ''` with comment `// Will be enriched by UI`
- But the UI enrichment never happens for cancelled orders
- The Supabase `orders` table stores `token_in_symbol` and `token_out_symbol` (populated at order creation in `src/app/api/orders/route.ts` lines 203–205)
- `OrderDashboard.tsx` lines 255, 259 render `{order.tokenInSymbol || '?'}` → shows `?`

### Objective

Populate `tokenInSymbol` and `tokenOutSymbol` from the Supabase row data in `rowToOrder()` instead of hardcoding empty strings.

### Requirements

1. In `src/hooks/useOrderEngine.ts`, modify the `rowToOrder()` function to read symbols from the Supabase row:

   ```typescript
   // Before:
   tokenInSymbol: '',   // Will be enriched by UI
   tokenOutSymbol: '',  // Will be enriched by UI

   // After:
   tokenInSymbol: row.token_in_symbol || '',
   tokenOutSymbol: row.token_out_symbol || '',
   ```

2. Verify that `row.token_in_symbol` and `row.token_out_symbol` exist in the Supabase row type. Check `OrderRow` interface (likely in `src/lib/order-engine/supabase.ts` or similar). If the fields are missing from the TypeScript interface, add them:

   ```typescript
   interface OrderRow {
     // ... existing fields
     token_in_symbol: string | null
     token_out_symbol: string | null
   }
   ```

3. Check if there are existing orders in Supabase that were created BEFORE symbols were stored (early development). For those rows, `token_in_symbol` would be `null`. The `|| ''` fallback handles this — the UI will show `?` for legacy orders, which is acceptable.

### Do NOT

- Do NOT change the `OrderDashboard.tsx` fallback logic (`|| '?'`) — it's correct as a safety net
- Do NOT change the order creation flow in `route.ts`
- Do NOT add a token lookup/enrichment call — the data is already in the DB
- Do NOT change the `removeOrder` logic in this prompt (handled in P197)

### Files affected

- `src/hooks/useOrderEngine.ts` — `rowToOrder()` function
- Possibly `src/lib/order-engine/supabase.ts` — `OrderRow` interface (if types need updating)

### Expected output

1 commit: `fix(orders): populate token symbols from Supabase row data [P196]`

### Quality criteria

- Cancelled orders show token symbols (e.g. `22 USDC → ETH`) instead of `22 ? → ?`
- New orders still save and display symbols correctly
- Legacy orders without symbols still show `?` (graceful fallback)
- All existing tests pass
- `npm run typecheck` passes

---

## P197 — Fix cancelled order cleanup

### Context

- File: `src/hooks/useOrderEngine.ts`, `removeOrder()` function (~lines 552–558)
- Currently: `removeOrder` filters the order from React state and localStorage only
- If the app re-syncs from Supabase (page refresh, reconnect), cancelled orders reappear
- The cancel flow sets `status = 'cancelled'` in Supabase but does not delete the row
- This is correct (audit trail) — but the UI should permanently hide dismissed orders

### Objective

When a user explicitly dismisses a cancelled order (clicks to remove it), mark it as permanently hidden so it does not reappear on re-sync.

### Requirements

1. **Option A (preferred) — Soft-delete flag in localStorage:**

   In `src/hooks/useOrderEngine.ts`, maintain a persistent list of dismissed order IDs in localStorage:

   ```typescript
   const DISMISSED_ORDERS_KEY = 'teraswap_dismissed_orders'

   function getDismissedOrderIds(): string[] {
     try {
       const stored = localStorage.getItem(DISMISSED_ORDERS_KEY)
       return stored ? JSON.parse(stored) : []
     } catch {
       return []
     }
   }

   function dismissOrder(orderId: string): void {
     const ids = getDismissedOrderIds()
     if (!ids.includes(orderId)) {
       ids.push(orderId)
       localStorage.setItem(DISMISSED_ORDERS_KEY, JSON.stringify(ids))
     }
   }
   ```

2. Modify `removeOrder()` to call `dismissOrder(orderId)` before removing from state.

3. When loading orders from Supabase (in the sync/fetch logic), filter out dismissed order IDs:

   ```typescript
   const dismissed = getDismissedOrderIds()
   const orders = rows
     .map(rowToOrder)
     .filter(o => !dismissed.includes(o.id))
   ```

4. **Do NOT delete from Supabase** — cancelled orders must be preserved for audit trail. The dismiss is UI-only.

5. Only cancelled orders should be dismissable. Active and completed orders must NOT be removable from the UI. If `removeOrder` is already gated on status, verify. If not, add a guard:

   ```typescript
   if (order.status !== 'cancelled') return
   ```

### Alternative — Option B (if localStorage is problematic):

If localStorage for dismissed IDs feels wrong given FE-01 (localStorage → Web Crypto V2 backlog item), use a `dismissed_at` timestamp column in Supabase instead. But this requires a schema migration which is heavier. Option A is simpler for now.

### Do NOT

- Do NOT delete rows from the Supabase `orders` table
- Do NOT change the cancel flow (status transition)
- Do NOT allow dismissing active or completed orders
- Do NOT add a new API endpoint — this is client-side only

### Files affected

- `src/hooks/useOrderEngine.ts` — `removeOrder()` function + order loading/sync logic

### Expected output

1 commit: `fix(orders): persist dismissed cancelled orders across page reloads [P197]`

### Quality criteria

- Dismissing a cancelled order removes it from the UI permanently
- Page refresh does not bring back dismissed orders
- Active and completed orders are not affected
- No Supabase schema changes required
- All existing tests pass
- `npm run typecheck` passes

---

## P198 — Tests for Sprint 38 fixes

### Context

The three fixes above need test coverage.

### Requirements

Add tests to the appropriate existing test files (or create new ones if no suitable file exists):

#### P195 coverage (DigitRoller visibility)

1. **`'DigitRoller shows when outputDisplay has value even during refresh'`** — mock a state where `outputDisplay` has a value. Assert DigitRoller is rendered (check for `tabular-nums` container or DigitRoller presence). This may need to be added to the existing SwapBox tests.

2. **`'Loading dots show only on initial load before first quote'`** — mock initial state with no quote, quoteLoading=true. Assert `...` pulse is visible and no DigitRoller.

#### P196 coverage (token symbols)

3. **`'rowToOrder populates token symbols from Supabase row'`** — call `rowToOrder` with a mock row containing `token_in_symbol: 'USDC'` and `token_out_symbol: 'ETH'`. Assert the returned order has `tokenInSymbol: 'USDC'` and `tokenOutSymbol: 'ETH'`.

4. **`'rowToOrder handles null token symbols gracefully'`** — call with `token_in_symbol: null`. Assert `tokenInSymbol: ''`.

#### P197 coverage (dismissed orders)

5. **`'removeOrder persists dismissed order ID'`** — call removeOrder on a cancelled order. Assert localStorage contains the order ID.

6. **`'Dismissed orders are filtered from loaded orders'`** — set a dismissed ID in localStorage, load orders. Assert the dismissed order is not in the result.

### Do NOT

- Do NOT modify existing tests
- Do NOT mock Supabase calls in unit tests — test `rowToOrder` and dismiss logic in isolation

### Files affected

- Existing or new test files for SwapBox, useOrderEngine

### Expected output

1 commit: `test(sprint-38): add coverage for DigitRoller fix, symbol fix, and dismiss fix [P198]`

### Quality criteria

- All new tests pass
- All existing tests pass
- `npm run typecheck` passes
- Total test count: 1165 + ~6 = **~1171**

---

## Sprint Summary

| Prompt | Scope | Files | Impact |
|--------|-------|-------|--------|
| P195 | DigitRoller visibility fix | SwapBox.tsx | UX — roller finally visible |
| P196 | Token symbol fix | useOrderEngine.ts (+ possibly supabase.ts) | UX — no more `?` on orders |
| P197 | Cancelled order dismiss | useOrderEngine.ts | UX — dismissed orders stay gone |
| P198 | Tests | test files | Coverage — ~6 new tests |

**Total estimated scope:** 4 commits, ~3 files edited, ~6 new tests.

**Risk assessment:** LOW. All fixes are UI/state layer. No contract changes, no API changes, no blockchain interaction changes. Worst case: a fix doesn't work → existing behaviour unchanged.
