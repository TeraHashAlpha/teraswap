# Sprint 31 — Portfolio Tab (ETH Mainnet)

> **Objective:** Add a "Portfolio" tab to the app showing the connected wallet's token balances with USD values. ETH mainnet only. MVP scope — no P&L, no historical charts, no cross-chain.
>
> **Prerequisite:** Sprint 30 (operational backlog) complete.
>
> **RICE:** 14.4 (R8 × I2 × C0.9 / E1). Approved by Architect 2026-05-26.

---

## P165 — Extract `usePortfolio` hook from `TokenSelector` balance logic

### Context

`TokenSelector.tsx` contains a `useTokenBalances()` hook (lines 22-92) that reads ETH native balance via `useBalance` and ERC-20 balances for all `DEFAULT_TOKENS` via `useReadContracts` multicall. It returns a `Map<string, { raw: bigint; formatted: string }>`. This hook is currently private to `TokenSelector` and has no USD pricing.

`defillama.ts` exports `fetchDefiLlamaPrices(tokenAddresses[], chain)` which batch-fetches USD prices from the DefiLlama API (free, no key). It has built-in caching (5-minute TTL).

### Objective

Extract balance-reading logic into a shared hook `usePortfolio` that combines on-chain balances with USD prices. Keep `TokenSelector` working exactly as before.

### Requirements

1. Create `src/hooks/usePortfolio.ts`.
2. Move the balance-reading logic from `TokenSelector.tsx` (lines 22-92) into a new **private** helper `useTokenBalances()` inside the same file. Keep the original in `TokenSelector.tsx` intact (do NOT import from the new file in `TokenSelector` — avoid breaking existing code).
3. `usePortfolio` hook returns:
   ```ts
   interface PortfolioToken {
     token: Token            // from @/lib/tokens
     balance: bigint         // raw wei/unit balance
     balanceFormatted: string // human-readable (reuse formatBalance logic)
     priceUsd: number | null // from DefiLlama, null if unavailable
     valueUsd: number | null // balance × price, null if price unavailable
   }

   interface PortfolioData {
     tokens: PortfolioToken[]      // sorted by valueUsd descending, then by symbol
     totalValueUsd: number | null  // sum of all known values, null if no prices
     isLoading: boolean
     isError: boolean
     lastUpdated: Date | null
   }
   ```
4. Fetch USD prices via a **Next.js API route** `src/app/api/portfolio/prices/route.ts` (server-side) that calls `fetchDefiLlamaPrices()` for all token addresses. This keeps the DefiLlama call server-side (no CORS issues, cacheable).
   - GET endpoint, query param `tokens` = comma-separated lowercase addresses.
   - Returns `{ prices: Record<string, number> }`.
   - Rate limit: 10 req/min per IP (use existing `rateLimiter` from `kv-rate-limiter.ts`).
   - Cache-Control: `public, s-maxage=60, stale-while-revalidate=120`.
5. `usePortfolio` fetches prices from this API route on mount + every 60 seconds. Use `useSWR` or plain `fetch` with `useEffect` + `useState` — do NOT add new dependencies.
6. Only include tokens where `balance > 0n` in the returned `tokens` array. Zero-balance tokens are filtered out.
7. Export `usePortfolio` and all interfaces.

### Do NOT

- Do NOT modify `TokenSelector.tsx` in any way — it keeps its own private `useTokenBalances()`.
- Do NOT add new npm dependencies (no SWR, no react-query). Use `fetch` + `useState` + `useEffect`.
- Do NOT call DefiLlama from the client side — only via the API route.
- Do NOT include imported tokens (user-added via `useTokenImport`) in MVP — only `DEFAULT_TOKENS`.
- Do NOT add P&L calculation, historical prices, or price change percentages.

### Files affected

- `src/hooks/usePortfolio.ts` — **NEW**
- `src/app/api/portfolio/prices/route.ts` — **NEW**

### Expected output

1 commit. Both files created. No changes to existing files. `npm run typecheck` passes.

### Quality criteria

- Hook returns loading/error states correctly.
- Tokens with balance but no DefiLlama price show `valueUsd: null` (not 0).
- `totalValueUsd` is the sum of known values only (ignores nulls).
- API route has rate limiting and input validation (reject invalid addresses).
- No client-side DefiLlama calls (verify no `fetch('https://coins.llama.fi')` in hook).

---

## P166 — Create `PortfolioTab` component

### Context

After P165, `usePortfolio()` returns the full portfolio data. The app has 7 tabs in `page.tsx` (Swap, DCA, Limit, SL/TP, Orders, History, Analytics). The design language is dark theme with `bg-surface-secondary`, `text-cream`, Tailwind utility classes, and the same card style used in `WalletHistory.tsx` and `AnalyticsDashboard.tsx`.

### Objective

Create the `PortfolioTab` component that displays the wallet's token holdings.

### Requirements

1. Create `src/components/PortfolioTab.tsx`.
2. **Header section:**
   - Total portfolio value in USD: large text, e.g. "$4,521.83". Use `Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })`.
   - "Last updated X seconds ago" subtitle, auto-refreshing.
   - A refresh button (circular arrow icon) that triggers a manual re-fetch.
3. **Token list:**
   - Each row: token logo (from `token.logoURI`, 32×32, rounded-full), symbol, name, balance (formatted), USD value.
   - Sorted by USD value descending (tokens without USD price at the bottom, sorted by symbol).
   - If USD price is unavailable for a token, show "—" in the value column.
   - Grouped by category (`token.category` from `tokens.ts`): show a subtle category header when the category changes. Categories: Native, Stablecoin, DeFi, Liquid Staking, etc. Only show categories that have tokens with balance.
   - **"Swap" action button** on each row — clicking it calls `onSwapToken(token)` prop callback.
4. **Empty state** (wallet not connected): "Connect your wallet to view your portfolio" message with the same style as other empty states in the app.
5. **Empty state** (connected, zero balances): "No tokens found in this wallet on Ethereum mainnet."
6. **Loading state:** Skeleton rows (3-4 animated placeholder rows) while `isLoading` is true.
7. **Error state:** "Failed to load portfolio. Try again." with retry button.
8. **Mobile responsive:** Single-column layout, token rows stack nicely. Logo + symbol/name on left, balance + value on right.
9. Use `dynamic(() => import(...), { ssr: false })` pattern — this component should NOT server-render (depends on wallet connection).
10. Props interface:
    ```ts
    interface PortfolioTabProps {
      onSwapToken?: (token: Token) => void
    }
    ```

### Do NOT

- Do NOT add charts, graphs, or historical data.
- Do NOT add "24h change" or price change indicators — MVP scope.
- Do NOT add token import/add functionality to this tab.
- Do NOT use any external UI library (no shadcn, no radix).
- Do NOT make it wider than `max-w-[540px]` (consistent with Swap/History tabs).

### Files affected

- `src/components/PortfolioTab.tsx` — **NEW**

### Expected output

1 commit. Component created. `npm run typecheck` passes.

### Quality criteria

- Token logos have `onError` fallback (show first letter of symbol in a colored circle).
- Numbers are formatted with thousand separators and 2 decimal places for USD.
- Category grouping is visually subtle (not heavy section breaks).
- Skeleton loading matches approximate layout of real rows.
- `onSwapToken` callback receives the correct `Token` object.

---

## P167 — Wire Portfolio tab into app navigation

### Context

`src/app/page.tsx` defines `SwapMode = 'instant' | 'dca' | 'limit' | 'sltp' | 'orders' | 'history' | 'analytics'` and renders a tab bar at line 96-131. Each tab maps to a component via the conditional block at lines 133-158.

After P166, `PortfolioTab` exists but isn't wired into the app.

### Objective

Add "Portfolio" as a new tab in the app, positioned between "Swap" and "DCA".

### Requirements

1. Add `'portfolio'` to the `SwapMode` union type.
2. Add `['portfolio', 'Portfolio']` to the tab bar array, positioned **second** (after `['instant', 'Swap']`, before `['dca', 'DCA']`).
3. Add a dynamic import for `PortfolioTab`:
   ```ts
   const PortfolioTab = dynamic(() => import('@/components/PortfolioTab'), { ssr: false })
   ```
4. Add a render branch for `swapMode === 'portfolio'` in the conditional block (lines 133-158). Use `max-w-[540px]` wrapper like History.
5. Wire the `onSwapToken` callback: when user clicks "Swap" on a token row, switch to `swapMode = 'instant'` and (if possible) pre-select that token in the SwapBox. If pre-selecting is complex, just switch to Swap tab — the user can select manually. Do NOT over-engineer this.
6. The tab should be visible only when wallet is connected. If wallet is not connected, still show the tab but the PortfolioTab component handles the empty state internally.

### Do NOT

- Do NOT reorder other existing tabs (DCA, Limit, SL/TP, Orders, History, Analytics stay in their current order).
- Do NOT change the tab bar styling or dimensions.
- Do NOT add icons or badges to the Portfolio tab.
- Do NOT hide the tab behind a feature flag — ship it directly.

### Files affected

- `src/app/page.tsx` — EDIT (type, tab array, dynamic import, render branch)

### Expected output

1 commit. Portfolio tab accessible in the app. `npm run typecheck` passes.

### Quality criteria

- Tab bar scrolls smoothly on mobile with 8 tabs (was 7).
- Clicking "Portfolio" shows the PortfolioTab component.
- Clicking "Swap" on a portfolio row navigates to the Swap tab.
- All existing tabs still work exactly as before.

---

## P168 — Tests for Portfolio hook, API route, and component

### Context

After P165-P167, the Portfolio feature is complete. TeraSwap convention: every feature needs tests. Current test stack: Vitest + React Testing Library. Mock patterns established in `src/test-utils/mock-wagmi.ts`.

### Objective

Add comprehensive tests for all three new files.

### Requirements

1. **`src/hooks/usePortfolio.test.ts`**
   - Test: returns empty tokens array when wallet not connected.
   - Test: returns tokens with balances when wallet connected (mock `useBalance` + `useReadContracts`).
   - Test: filters out zero-balance tokens.
   - Test: sorts by valueUsd descending.
   - Test: handles DefiLlama API failure gracefully (tokens show `priceUsd: null`).
   - Test: `totalValueUsd` sums only non-null values.
   - Test: `isLoading` is true initially, false after data loads.

2. **`src/app/api/portfolio/prices/route.test.ts`**
   - Test: returns prices for valid token addresses.
   - Test: returns 400 for missing `tokens` param.
   - Test: returns 400 for invalid address format.
   - Test: rate limiting triggers after threshold.
   - Test: handles DefiLlama failure (returns empty prices, not 500).

3. **`src/components/PortfolioTab.test.tsx`**
   - Test: renders "connect wallet" message when not connected.
   - Test: renders token list with balances when connected.
   - Test: renders loading skeletons while loading.
   - Test: renders error state with retry button.
   - Test: calls `onSwapToken` when Swap button clicked.
   - Test: renders "—" for tokens without USD price.
   - Test: groups tokens by category.

### Do NOT

- Do NOT use snapshot tests.
- Do NOT test implementation details (internal state, private functions).
- Do NOT mock at module level if it can be done at the test level.

### Files affected

- `src/hooks/usePortfolio.test.ts` — **NEW**
- `src/app/api/portfolio/prices/route.test.ts` — **NEW**
- `src/components/PortfolioTab.test.tsx` — **NEW**

### Expected output

1 commit. All new tests pass. `npm test` shows 0 failures. Existing 989 tests unaffected.

### Quality criteria

- Each test file has ≥5 test cases.
- Tests are independent (no shared mutable state between tests).
- Mock cleanup in `afterEach`.
- No `any` type assertions — use proper typed mocks.

---

## Sprint 31 — Summary

| Prompt | Scope | Files | Deps |
|--------|-------|-------|------|
| P165 | `usePortfolio` hook + API route | 2 new | — |
| P166 | `PortfolioTab` component | 1 new | P165 |
| P167 | Wire into `page.tsx` navigation | 1 edit | P166 |
| P168 | Tests (hook + API + component) | 3 new | P167 |

**Total:** 4 prompts, 7 files (6 new + 1 edit), 0 new dependencies.

**Audit scope:** Standard sprint audit (0C/0H required). Key areas: XSS in token data rendering, rate limiting on API route, no client-side DefiLlama calls leaking user IP, proper error boundaries.
