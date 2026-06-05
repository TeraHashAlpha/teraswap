# Sprint 25F — Disable fee integrity check for non-partner-fee sources (P156)

> **Date:** 2026-05-20
> **Branch:** `fix/fee-integrity-false-positive` (from `main` — Sprint 25D/25E just merged via PR #77)
> **Priority:** P0 — false positives blocking swaps in production
> **Context:** PR #77 (Sprints 25C–25E) merged to main. Fee integrity
>   false positive still fires for all sources. Root cause: P150 guard
>   (`!routeViaFeeCollector`) is now always true because P153 made ALL
>   sources fee-incompatible. The check runs for every swap and triggers
>   on volatile routing with small amounts.

---

## P156 — Guard fee integrity check with FEE_NATIVE_SOURCES, not routeViaFeeCollector

### Context

`validateFeeIntegrity()` was designed for the **partner-fee model** —
where the aggregator API applies a 0.1% fee and the check verifies the
fee was actually deducted (swap output should be ~0.1% lower than quote
output). It catches the case where the partner fee parameter was silently
ignored.

There are currently THREE fee modes:

1. **FeeCollector routing** (`routeViaFeeCollector=true`) — fee enforced
   on-chain by the FeeCollector contract. The check is irrelevant because
   the API never sees the fee. P150 correctly skips this.

2. **Partner fee via API** (`FEE_NATIVE_SOURCES`) — fee applied by the
   aggregator's API. The check is designed for this. Currently
   `FEE_NATIVE_SOURCES = []` — no source uses partner fees.

3. **No fee at all** (`FEE_INCOMPATIBLE_SOURCES`) — source bypasses all
   fee collection. Quote and swap both use the full amount. The check
   is meaningless — any difference is just routing volatility.

P150's guard (`!routeViaFeeCollector`) conflates cases 2 and 3. With
Sprint 25D's expansion of FEE_INCOMPATIBLE_SOURCES to all 11 sources,
every swap hits case 3, the check runs, and volatile routing triggers
"Fee verification failed — swap output is unexpectedly high."

### Objective

Change the guard from `!routeViaFeeCollector` to
`FEE_NATIVE_SOURCES.includes(source)` so the check only runs for
sources that actually apply fees via their API.

Since `FEE_NATIVE_SOURCES` is currently empty, this effectively disables
the check for all sources — which is correct because no source currently
uses partner-fee mode.

### Requirements

1. In `src/hooks/useSwap.ts`, change the fee integrity guard (~line 320):

   ```typescript
   // Before (P150):
   if (quoteToAmount && !routeViaFeeCollector) {

   // After:
   // [M-01] Fee integrity check — only for sources that collect fees via
   // the aggregator API (partner-fee model, FEE_NATIVE_SOURCES). When
   // routeViaFeeCollector=true the on-chain contract enforces the fee.
   // When the source is fee-incompatible (no fee at all), comparing
   // quote vs swap output produces false positives because any difference
   // is just routing volatility — not a missing fee.
   const usesPartnerFee = FEE_NATIVE_SOURCES.includes(source as AggregatorName)
   if (quoteToAmount && usesPartnerFee) {
   ```

2. Add the import for `FEE_NATIVE_SOURCES` at the top of `useSwap.ts`
   if not already imported:

   ```typescript
   import { FEE_NATIVE_SOURCES, type AggregatorName } from '@/lib/constants'
   ```

3. Update the comment block to explain all three fee modes and why the
   check is currently inactive.

4. Do NOT remove `validateFeeIntegrity` — it's still valid for future
   partner-fee integrations when `FEE_NATIVE_SOURCES` has entries.

5. Update the test in `src/hooks/__tests__/swap-validations.test.ts`:
   - The existing test "skips fee integrity when routeViaFeeCollector=true"
     should be updated or supplemented to test "skips fee integrity when
     source is NOT in FEE_NATIVE_SOURCES"
   - Add test: "runs fee integrity when source IS in FEE_NATIVE_SOURCES"
     (mock FEE_NATIVE_SOURCES to include a test source)

### Files affected

- `src/hooks/useSwap.ts` — fee integrity guard (~line 320)
- `src/hooks/__tests__/swap-validations.test.ts` — updated tests

### Do NOT

- Do NOT remove `validateFeeIntegrity` function from `src/lib/api.ts`
- Do NOT modify `FEE_NATIVE_SOURCES` — it stays empty
- Do NOT change `FEE_INCOMPATIBLE_SOURCES`

### Expected output

One commit. Fee integrity false positive stops firing for all current
sources. The check remains available for future partner-fee integrations.

### Quality criteria

- All existing tests pass (update affected tests)
- TypeScript clean
- No swap-blocking false positives on volatile pairs
- `validateFeeIntegrity` function body unchanged
