# Sprint 13B — Personal Analytics & CSV Export

**Sprint window:** Post-Sprint 13A APPROVED → TBD
**Sprint goal:** Per-wallet analytics dashboard with KPI cards, source win-rates, timing insights, and CSV export. ROADMAP Phase 2.4.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 13A APPROVED (gasless engine + tracking in place). `is_gasless` column available in `swap_history`.
**References:**
- ROADMAP.md Phase 2.4 (Swap Analytics & Personal Insights)
- Existing analytics: `src/components/AnalyticsDashboard.tsx` (protocol-wide), `src/components/WalletHistory.tsx` (basic history)
- Types: `src/lib/analytics-types.ts`
- Supabase: `swap_history` table with RLS (user reads own rows)

---

## Architecture Context

**What exists:** `AnalyticsDashboard` shows protocol-wide metrics (all wallets). `WalletHistory` shows per-wallet swap records in a table but no aggregated insights — no total volume, no source breakdown, no timing analysis.

**What's needed:** A personal analytics layer that aggregates `swap_history` rows per wallet into KPI cards (total swaps, volume, gas saved), source win-rate breakdown, best timing patterns, and downloadable CSV export.

---

## RICE Prioritisation

| # | Prompt | R | I | C | E | RICE | Priority |
|---|--------|---|---|---|---|------|----------|
| 98 | Personal analytics: data layer + API | 8 | 2 | 0.8 | 1.5 | 8.5 | P2 |
| 99 | Personal analytics: dashboard UI | 8 | 2 | 0.8 | 2.0 | 6.4 | P2 |
| 100 | CSV export for swap history | 6 | 1 | 0.9 | 0.5 | 10.8 | P2 |

**Execution order:** P98 → P99 → P100

**Dependency graph:**
```
P98 ──→ P99 (UI consumes the data layer)
P98 ──→ P100 (export uses the same query logic)
```

---

## Sprint status table

| # | Prompt | Description | ROADMAP | Status |
|---|--------|------------|---------|--------|
| 98 | Personal analytics data layer | Supabase aggregation + API route + KV cache | 2.4 | Pending |
| 99 | Personal analytics dashboard | /analytics page with KPI cards + charts | 2.4 | Pending |
| 100 | CSV export | Download swap history as CSV | 2.4 | Pending |

---

## Prompt 98 — Personal analytics: data layer + API [Phase 2.4]

**Status:** Pending

**Context:** `swap_history` has per-wallet rows (RLS enforced). `AnalyticsDashboard` aggregates across ALL wallets. Users have no way to see their own performance summary — total volume, gas saved, which sources won most for them.

**Objective:** Build a personal analytics data layer with a Next.js API route and Upstash KV caching.

**Requirements:**

1. **Create `src/lib/personal-analytics.ts`** with:

   ```typescript
   export interface PersonalAnalytics {
     wallet: string
     totalSwaps: number
     totalVolumeUsd: number
     totalGasSavedUsd: number          // sum of gas_savings_usd where is_gasless=true
     gaslessSwapCount: number
     gaslessRatio: number               // gaslessSwapCount / totalSwaps
     sourceWinRates: Record<string, number>  // source → percentage (0-100)
     topPairs: Array<{ pair: string; count: number; volumeUsd: number }>
     bestHour: number | null            // hour (0-23) with most swaps
     bestDayOfWeek: number | null       // day (0=Sun, 6=Sat) with most swaps
     periodStart: string                // ISO date of first swap
     periodEnd: string                  // ISO date of last swap
     lastUpdated: string                // ISO timestamp
   }

   export async function fetchPersonalAnalytics(wallet: string): Promise<PersonalAnalytics>
   ```

2. **Supabase query:** Single RPC call or aggregation query on `swap_history` filtered by `wallet_address`. Compute all fields server-side (don't fetch all rows to client).

3. **Create API route `src/app/api/analytics/personal/route.ts`:**
   - `GET /api/analytics/personal?wallet=0x...`
   - Validate wallet address (checksum format)
   - Rate limit: 10 req/min per wallet (use existing Upstash rate limiter)
   - Cache result in Upstash KV for 5 minutes (key: `analytics:personal:{wallet}`)
   - Return `PersonalAnalytics` JSON

4. **Create `src/hooks/usePersonalAnalytics.ts`:**
   - Takes connected wallet address from Wagmi
   - Calls the API route
   - Returns `{ data: PersonalAnalytics | null, isLoading, error }`
   - Auto-refetch on wallet change
   - No refetch on window focus (stale data is fine for analytics)

**Do NOT**

- Expose other wallets' data — the API must only return data for the requested wallet (RLS handles this, but validate anyway)
- Create a new Supabase table — aggregate from existing `swap_history`
- Fetch all swap rows to the client — aggregation must happen server-side
- Remove or modify `AnalyticsDashboard` — this is a separate personal view

**Files affected**

- `src/lib/personal-analytics.ts` (new)
- `src/app/api/analytics/personal/route.ts` (new)
- `src/hooks/usePersonalAnalytics.ts` (new)
- Test file for personal-analytics

**Expected output**

- 1 atomic commit
- API returns aggregated personal analytics for any wallet
- KV caching reduces Supabase load
- Hook ready for dashboard consumption

**Quality criteria**

- Server-side aggregation (no N+1, no client-side compute)
- KV cache with 5-minute TTL
- Rate limited to prevent abuse
- TypeScript compiles cleanly
- Wallet validation prevents injection

---

## Prompt 99 — Personal analytics: dashboard UI [Phase 2.4]

**Status:** Pending

**Context:** With P98's data layer in place, we need a dashboard page that shows users their personal swap performance. This builds engagement and gives users a reason to return.

**Objective:** Build a `/analytics` page showing personal swap insights with KPI cards and charts.

**Requirements:**

1. **Create `src/components/PersonalDashboard.tsx`:**

   - **KPI row** (4 cards):
     - Total Swaps (count)
     - Total Volume (USD, formatted with abbreviations: $1.2K, $45.6K)
     - Gas Saved (USD, only from gasless swaps)
     - Gasless Ratio (percentage with small chart)

   - **Source win-rate section:**
     - Horizontal bar chart showing which sources won most often for this wallet
     - Top 5 sources with percentage bars
     - Use existing color scheme from `AnalyticsDashboard`

   - **Top pairs table:**
     - Top 5 most-traded pairs
     - Columns: Pair, Swaps, Volume

   - **Timing insights:**
     - "Best hour" and "Best day" badges
     - Simple text: "You trade most on Tuesdays around 2pm UTC"
     - Only show if enough data (>10 swaps)

2. **Create page `src/app/analytics/page.tsx`:**
   - Uses `usePersonalAnalytics` hook
   - Requires wallet connection (show connect prompt if disconnected)
   - Loading skeleton while data fetches
   - Empty state: "No swaps yet. Make your first swap to see analytics."

3. **Add navigation link:**
   - Add "My Analytics" link in the app navigation (wherever existing nav links are)
   - Only show when wallet is connected

4. **Responsive design:**
   - KPI cards: 4-column on desktop, 2-column on tablet, 1-column on mobile
   - Charts: full-width on mobile
   - Use existing Tailwind breakpoints

**Do NOT**

- Duplicate the protocol-wide `AnalyticsDashboard` — this is personal only
- Add charts that require heavy JS libraries — use simple CSS bars for win-rates
- Fetch data on every render — rely on the hook's caching
- Show other wallets' data or allow wallet address input (use connected wallet only)

**Files affected**

- `src/components/PersonalDashboard.tsx` (new)
- `src/app/analytics/page.tsx` (new)
- Navigation component (add link)

**Expected output**

- 1 atomic commit
- `/analytics` page accessible from navigation
- KPI cards, source win-rates, top pairs, timing insights all rendering
- Responsive across desktop/tablet/mobile

**Quality criteria**

- Accessible: proper headings, aria labels, keyboard navigation
- Dark theme compatible (existing palette)
- Loading and empty states handled gracefully
- No layout shift during load (skeleton matches final layout)
- Capacitor/mobile friendly

---

## Prompt 100 — CSV export for swap history [Phase 2.4]

**Status:** Pending

**Context:** Users and integrators want to export their swap history for tax reporting, accounting, or analysis. The data exists in `swap_history` but there's no export mechanism.

**Objective:** Add CSV export to the swap history API and UI.

**Requirements:**

1. **Create API route `src/app/api/analytics/export/route.ts`:**
   - `GET /api/analytics/export?wallet=0x...&format=csv`
   - Query `swap_history` for the wallet (RLS enforced)
   - Return CSV with headers:
     ```
     Date,Pair,Source,Amount In,Token In,Amount Out,Token Out,Volume USD,Gas USD,Gas Saved USD,Gasless,TX Hash
     ```
   - Dates in ISO 8601 format (UTC)
   - Amounts in human-readable format (not wei)
   - Set response headers: `Content-Type: text/csv`, `Content-Disposition: attachment; filename="teraswap-history-{wallet-short}-{date}.csv"`
   - Rate limit: 5 req/hour per wallet (expensive query)

2. **Add export button to `WalletHistory.tsx`:**
   - "Export CSV" button in the header area
   - Downloads via the API route
   - Show loading spinner while generating
   - Disabled if no swaps exist

3. **Add export button to `PersonalDashboard.tsx`:**
   - "Export History" link in the dashboard header
   - Same API endpoint

4. **Add tests:**
   - CSV format validation (correct headers, proper escaping)
   - Empty wallet returns CSV with only headers
   - Date format is ISO 8601
   - Amounts are human-readable (not raw BigInt)

**Do NOT**

- Generate CSV client-side — server generates to handle large histories
- Allow exporting other wallets' data
- Include sensitive data (no private keys, no session info)
- Add PDF or Excel export (CSV only for v1)

**Files affected**

- `src/app/api/analytics/export/route.ts` (new)
- `src/components/WalletHistory.tsx` (add export button)
- `src/components/PersonalDashboard.tsx` (add export link)
- Test file for export route

**Expected output**

- 1 atomic commit
- CSV downloads with proper formatting
- Export accessible from both WalletHistory and PersonalDashboard
- Rate limited to prevent abuse

**Quality criteria**

- CSV properly escaped (commas in values, quotes)
- Human-readable amounts (wei → token decimals)
- ISO 8601 dates (tax software compatible)
- TypeScript compiles cleanly

---

## Post-sprint

After all prompts are committed and CI green:
1. Run full test suite (expected: 542+)
2. Test personal analytics: connect wallet → view /analytics → verify KPI cards match swap_history data
3. Test CSV export: download → open in Excel/Sheets → verify formatting
4. Submit for auditor review — focus on: RLS enforcement, wallet validation, rate limiting, CSV injection prevention
5. After APPROVED: update ROADMAP.md Phase 2.4 checkboxes
