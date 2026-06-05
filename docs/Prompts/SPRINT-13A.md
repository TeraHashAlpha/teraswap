# Sprint 13A — Gasless Swaps Enhancement

**Sprint window:** Post-Sprint 12 APPROVED → TBD
**Sprint goal:** Enhance the existing CoW gasless flow with auto-detection, explicit UX, Supabase tracking, and Public API fields. First product-facing sprint since Public API. ROADMAP Phase 2.2.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 12 APPROVED (0C/0H/0M/0L, 2026-05-13). 538 tests passing.
**References:**
- ROADMAP.md Phase 2.2 (Gasless Swaps) + 2.4 (Swap Analytics)
- Existing CoW flow: `src/lib/adapters/cow.ts`, `src/hooks/useSwap.ts` (EIP-712 signing, already gasless)
- Existing analytics: `src/components/AnalyticsDashboard.tsx` (protocol-wide), `src/components/WalletHistory.tsx` (basic history)
- Types: `src/lib/analytics-types.ts`

---

## Architecture Context

**Gasless — what exists vs what's needed:**
CoW swaps are already gasless technically — user signs EIP-712, solver pays gas, deducted from output. The "Gasless" badge shows in QuoteBreakdown when `estimatedGas === 0 && bestIsIntent`. What's MISSING: (a) auto-detection when CoW is competitive enough to recommend gasless, (b) prominent "Zero Gas" UX beyond a tiny badge, (c) gasless vs standard analytics, (d) the v1/quote API doesn't expose gasless info.

**Analytics — what exists vs what's needed:**
`AnalyticsDashboard` shows protocol-wide metrics (all wallets). `WalletHistory` shows per-wallet swap records but no aggregated insights. What's MISSING: personal dashboard with total swaps/volume/savings, source win-rate per user, best timing insights, CSV export.

---

## RICE Prioritisation

| # | Prompt | R | I | C | E | RICE | Priority |
|---|--------|---|---|---|---|------|----------|
| 94 | Gasless auto-detect + recommendation engine | 10 | 3 | 0.8 | 1.0 | 24.0 | P1 |
| 95 | Gasless UX: "Zero Gas" prominence + swap flow | 10 | 2 | 0.9 | 1.0 | 18.0 | P1 |
| 96 | Gasless analytics tracking (Supabase) | 8 | 2 | 0.9 | 0.5 | 28.8 | P1 |
| 97 | v1/quote + v1/swap gasless fields | 8 | 2 | 0.9 | 0.5 | 28.8 | P1 |
| 98 | Personal analytics: data layer + API | 8 | 2 | 0.8 | 1.5 | 8.5 | P2 |
| 99 | Personal analytics: dashboard UI | 8 | 2 | 0.8 | 2.0 | 6.4 | P2 |
| 100 | CSV export for swap history | 6 | 1 | 0.9 | 0.5 | 10.8 | P2 |

**Execution order:** P94 → P95 → P96 → P97 → P98 → P99 → P100

**Dependency graph:**
```
P94 ──→ P95 (UX depends on detection logic)
    └──→ P96 (tracking depends on detection flag)
    └──→ P97 (API depends on detection engine)
```

---

## Sprint status table

| # | Prompt | Description | ROADMAP | Status |
|---|--------|------------|---------|--------|
| 94 | Gasless auto-detect | Recommend CoW when competitive + gasless available | 2.2 | Pending |
| 95 | Gasless UX prominence | "Zero Gas" card, swap flow enhancement | 2.2 | Pending |
| 96 | Gasless analytics tracking | Track gasless vs standard in Supabase | 2.2 | Pending |
| 97 | v1/quote + v1/swap gasless fields | Expose gasless info in Public API | 2.2 | Pending |

---

## Prompt 94 — Gasless auto-detect + recommendation engine [Phase 2.2]

**Status:** Pending

**Context:** CoW swaps are already gasless (EIP-712 sign, solver pays gas). But the user has to manually choose CoW or rely on it winning the quote competition. For small swaps (<$500), gas can be 5-15% of value — gasless is a killer feature. We need an engine that detects when gasless is available and competitive, then surfaces a recommendation.

**Objective:** Build a gasless recommendation engine that analyses quote results and flags when CoW gasless is the best option.

**Requirements:**

1. **Create `src/lib/gasless-engine.ts`** with:

   ```typescript
   export interface GaslessRecommendation {
     available: boolean          // CoW returned a quote
     recommended: boolean        // CoW is within threshold of best price
     reason: string              // Human-readable reason
     gasSavingsUsd: number       // Estimated gas savings in USD
     priceDifferencePercent: number // How far CoW is from best non-CoW quote
     bestNonCowSource: string    // For comparison display
   }

   export function analyzeGasless(
     quotes: NormalizedQuote[],
     meta: QuoteMeta,
     estimatedGasUsd: number,
   ): GaslessRecommendation
   ```

2. **Logic:**
   - `available`: CoW quote exists in the quotes array
   - `recommended`: CoW output is within **0.5%** of the best non-CoW quote OR CoW is the outright best. This threshold accounts for the fact that gasless savings often exceed a small price difference.
   - `gasSavingsUsd`: estimated gas cost of the best non-CoW route (from `estimatedGas * gasPrice`). This is what the user saves by going gasless.
   - If `gasSavingsUsd > priceDifference`, gasless is recommended even when CoW gives slightly less output (net positive for user).
   - `reason`: e.g. "Save ~$4.20 in gas fees" or "Best price AND zero gas"

3. **Integration point:** Call `analyzeGasless()` in `useQuote` hook after all quotes return. Store result alongside `QuoteMeta`.

4. **Constants:**
   ```typescript
   const GASLESS_PRICE_THRESHOLD_BPS = 50  // 0.5% — CoW within this range triggers recommendation
   const GASLESS_MIN_SAVINGS_USD = 0.50    // Don't recommend gasless if savings < $0.50
   ```

5. **Add tests:**
   - CoW best price → `recommended: true`, reason includes "best price"
   - CoW 0.3% worse but gas savings $5 → `recommended: true` (net positive)
   - CoW 2% worse → `recommended: false`
   - No CoW quote → `available: false, recommended: false`
   - Gas savings < $0.50 → not recommended (noise)

**Do NOT**

- Change the existing quote ranking logic in `useQuote` — this is a parallel analysis, not a replacement
- Auto-switch to CoW without user consent — this is a recommendation, not an override
- Modify the cow.ts adapter — it already works correctly

**Files affected**

- `src/lib/gasless-engine.ts` (new)
- `src/hooks/useQuote.ts` (integrate analyzeGasless call)
- Test file for gasless-engine

**Expected output**

- 1 atomic commit
- `GaslessRecommendation` available wherever quotes are consumed
- Tests cover all recommendation scenarios

**Quality criteria**

- Engine is pure function (no side effects, easy to test)
- Threshold constants are configurable, not hardcoded in logic
- TypeScript compiles cleanly

---

## Prompt 95 — Gasless UX: "Zero Gas" prominence + swap flow [Phase 2.2]

**Status:** Pending

**Context:** Currently the "Gasless" badge in QuoteBreakdown is a tiny 10px span. When gasless is recommended, we should make it much more prominent — this is a key differentiator for TeraSwap.

**Objective:** Enhance the swap UI to prominently surface gasless recommendations.

**Requirements:**

1. **QuoteBreakdown enhancement** — when `gaslessRecommendation.recommended === true`:
   - Show a prominent card above the quote comparison:
     ```
     ⚡ Zero Gas Available
     Save ~$X.XX in gas fees by using CoW Protocol.
     Your swap is fully MEV-protected.
     [Use Gasless Route]  [Keep Current]
     ```
   - Card uses a gradient border (purple/blue) to stand out
   - "Use Gasless Route" button switches the selected source to CoW
   - If CoW is already selected, show a simpler confirmation: "✓ You're using the gasless route — saving ~$X.XX"

2. **SwapBox enhancement** — when gasless is recommended but user has a non-CoW source selected:
   - Show a subtle banner below the swap button: "💡 Gasless option available — save ~$X.XX"
   - Clickable — scrolls to QuoteBreakdown gasless card

3. **Swap confirmation modal** — if executing via CoW:
   - Replace "Estimated Gas: ~$X.XX" with "Gas Fee: $0.00 (paid by solver)"
   - Add a "Gasless" chip next to the source name

4. **Keep existing "Gasless" badge** in QuoteBreakdown for when gasless is available but not actively recommended (e.g. CoW quote exists but is >0.5% worse)

**Do NOT**

- Force users onto gasless — always give the choice
- Remove the existing quote ranking — gasless is an overlay, not a replacement
- Add animations or confetti — keep it professional
- Change the MEV protection logic or routing

**Files affected**

- `src/components/QuoteBreakdown.tsx`
- `src/components/SwapBox.tsx`
- `src/components/SwapConfirmModal.tsx` (or equivalent confirmation UI)

**Expected output**

- 1 atomic commit
- Gasless recommendation prominently displayed when available
- User can accept or dismiss the gasless recommendation
- No change to existing non-gasless swap flow

**Quality criteria**

- Visual hierarchy: gasless card is noticeable without being annoying
- Accessible: proper aria labels, keyboard navigable
- Responsive: works on mobile (Capacitor)
- Dark theme compatible (existing palette)

---

## Prompt 96 — Gasless analytics tracking [Phase 2.2]

**Status:** Pending

**Context:** We need to track gasless vs standard swap ratio to measure feature adoption and compute aggregate gas savings. The existing `swap_history` table in Supabase has `mev_protected` boolean but no gasless flag.

**Objective:** Add gasless tracking to the swap logging pipeline.

**Requirements:**

1. **Add column to Supabase `swap_history` table:**
   ```sql
   ALTER TABLE swap_history ADD COLUMN is_gasless BOOLEAN DEFAULT false;
   ALTER TABLE swap_history ADD COLUMN gas_savings_usd NUMERIC(12,4) DEFAULT 0;
   ```

2. **Update `logSwapToSupabase()`** in `src/lib/api.ts` (or wherever swap logging happens):
   - Accept new fields: `isGasless: boolean`, `gasSavingsUsd: number`
   - Pass through to Supabase insert

3. **Update `useSwap.ts`** — when executing a CoW swap:
   - Set `isGasless: true`
   - Set `gasSavingsUsd` from the `GaslessRecommendation.gasSavingsUsd` value
   - For non-CoW swaps: `isGasless: false`, `gasSavingsUsd: 0`

4. **Update `src/app/api/stats/route.ts`** (or create `/api/stats/gasless`) to expose:
   ```json
   {
     "totalGaslessSwaps": 42,
     "totalGasSavedUsd": 1234.56,
     "gaslessRatio": 0.35,
     "avgGasSavingsPerSwap": 5.21
   }
   ```

5. **Add to AnalyticsDashboard** — new section showing gasless adoption metrics:
   - Total gasless swaps / total swaps (ratio)
   - Total gas savings in USD
   - Trend: gasless ratio over last 7 days

**Do NOT**

- Create a new Supabase table — extend the existing `swap_history`
- Add tracking for quotes (only track completed swaps)
- Modify RLS policies — `swap_history` already has appropriate RLS

**Files affected**

- Supabase migration: `supabase/migrations/` (new migration file)
- `src/lib/api.ts` (or swap logging module)
- `src/hooks/useSwap.ts`
- `src/app/api/stats/route.ts`
- `src/components/AnalyticsDashboard.tsx`

**Expected output**

- 1 atomic commit
- Gasless flag persisted on every swap
- Stats API returns gasless metrics
- Dashboard shows gasless adoption

**Quality criteria**

- Migration is backwards-compatible (DEFAULT false)
- Existing swap records remain valid
- Stats API is performant (index on `is_gasless` if needed)

---

## Prompt 97 — v1/quote + v1/swap gasless fields [Phase 2.2]

**Status:** Pending

**Context:** The Public API (v1/quote, v1/swap) doesn't expose gasless information. Third-party integrators need to know if a gasless option is available and how much gas they'd save.

**Objective:** Add gasless recommendation data to the v1/quote and v1/swap API responses.

**Requirements:**

1. **v1/quote response** — add a `gasless` object:
   ```json
   {
     "best": { ... },
     "all": [ ... ],
     "gasless": {
       "available": true,
       "recommended": true,
       "gasSavingsUsd": 4.20,
       "priceDifferencePercent": -0.12,
       "reason": "Save ~$4.20 in gas fees"
     }
   }
   ```
   Use `analyzeGasless()` from P94 to compute.

2. **v1/swap response** — when `source=cowswap` is requested:
   - Add `"gasless": true` to the response
   - Add `"gasSavingsUsd": X.XX`
   - When a non-CoW source is requested but gasless is available, add:
     ```json
     "gaslessAlternative": {
       "available": true,
       "gasSavingsUsd": 4.20
     }
     ```

3. **OpenAPI documentation** — update the JSDoc/comments in both route files with the new fields.

4. **Add tests:**
   - v1/quote with CoW competitive → gasless.recommended = true
   - v1/quote without CoW → gasless.available = false
   - v1/swap with source=cowswap → gasless = true
   - v1/swap with source=1inch but CoW available → gaslessAlternative present

**Do NOT**

- Change the authentication or rate limiting logic
- Add gasless fields to the admin API
- Modify the existing fields — only add new ones (backwards compatible)

**Files affected**

- `src/app/api/v1/quote/route.ts`
- `src/app/api/v1/swap/route.ts`
- Test files for both routes

**Expected output**

- 1 atomic commit
- v1/quote and v1/swap responses include gasless data
- Backwards compatible (new fields, no breaking changes)
- Tests cover gasless available/unavailable scenarios

**Quality criteria**

- Existing v1 consumers don't break
- Gasless fields are always present (not undefined)
- TypeScript compiles cleanly

---

## Post-sprint

After all prompts are committed and CI green:
1. Run full test suite (expected: 538+)
2. Test gasless flow: connect wallet → get CoW quote → see "Zero Gas" recommendation → verify tracking
3. Test v1/quote and v1/swap gasless fields with curl
4. Submit for auditor review — focus on: gasless recommendation thresholds, Supabase migration safety, new API fields
5. After APPROVED: proceed to Sprint 13B (Personal Analytics)
