# Sprint 25 — Quote Routing Fix + Swap Simulation Diagnostic

**Date:** 2026-05-20
**Architect:** Claude (Senior Architect)
**Branch:** `fix/quote-routing-and-sim` (single branch, single PR)
**Estimated effort:** ~1 pw (3 prompts)

---

## Motivation

Two user-facing bugs have been identified that work together to degrade the swap experience:

1. **CoW MEV preference promotes a worse price.** The smart MEV preference in `SwapBox.tsx` promotes CoW Protocol as `best` whenever its output is within 30 bps (0.3%) of the true best quote — regardless of the absolute USD loss. In a ~$2,130 swap, this allows CoW to be selected with a $6.19 shortfall vs KyberSwap (29 bps, just under the 30 bps threshold). On a $100k swap, the same threshold would silently sacrifice ~$300. The threshold is purely percentage-based with no USD cap and no consideration of whether gas savings make the user net-positive.

2. **Non-CoW swaps revert on simulation.** When the user disables MEV protection (or when a non-CoW source wins), clicking "Swap" produces "Simulation reverted: swap would fail on-chain." The pre-swap `eth_call` simulation consistently fails. Root cause analysis points to two likely factors:
   - **`sender` mismatch:** The swap calldata is built with `sender: userWallet` / `recipient: userWallet`, but when routed through the FeeCollector contract, the actual `msg.sender` is the FeeCollector. Some routers (KyberSwap, Odos) validate that `msg.sender == sender` or attempt `transferFrom(sender, ...)` using the sender from the calldata, which fails because the FeeCollector is the caller.
   - **Quote staleness + tight minimumOutput:** The `minimumOutput` passed to the FeeCollector is based on `swapData.toAmount` (a fresh swap-time quote), but price can move between the 15s quote poll and the user clicking "Swap". If the actual router output is below `minimumOutput`, the FeeCollector's `InsufficientOutput` check reverts.

The first bug causes users to unknowingly lose money; the second completely blocks all non-CoW swap execution through the FeeCollector. Together they mean the only working swap path is CoW Protocol — which pays a worse price.

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 138 | MEV preference: net-positive check + USD cap | 10 | 3 | 0.95 | 0.20 | 142.5 | P0 |
| 139 | Simulation revert: diagnostic + sender/staleness fix | 10 | 3 | 0.80 | 0.40 | 60.0 | P0 |
| 140 | Regression tests for both fixes | 10 | 2 | 0.90 | 0.40 | 45.0 | P1 |

---

## Prompt 138 — MEV Preference: Net-Positive Check

### Context

`SwapBox.tsx` lines 115–173 implement "smart MEV preference" — a `useMemo` that inspects the raw quote set and optionally promotes a MEV-protected source (CoW) into `best` even when it doesn't have the highest `toAmount`. The current logic (line 157–159):

```ts
const shortfallBps = ((bestAmount - cowAmount) * 10_000n) / bestAmount
const thresholdBps = safeBigInt(Math.round(MEV_PREFERENCE_THRESHOLD * 10_000)) ?? 0n
if (shortfallBps <= thresholdBps) { /* promote CoW */ }
```

`MEV_PREFERENCE_THRESHOLD` is `0.003` (30 bps) in `constants.ts` line 215. This is a flat percentage with:
- No USD cap — $6 loss on $2k swap, $300 on $100k swap
- No consideration of gas savings — CoW is gasless, but the promotion doesn't check if gas savings compensate the shortfall
- No user visibility — the UI shows CoW as "best" with a checkmark, hiding the actual best price

The gasless engine (`gasless-engine.ts`) already computes `gasSavingsUsd` and `priceDifferencePercent`, but these are used only for a banner — not for the promotion decision.

### Objective

Promote CoW only when the user ends up net-positive (gas savings exceed the price shortfall), and add a USD cap as a safety rail.

### Requirements

1. **Net-positive promotion logic** — In `SwapBox.tsx`, replace the current shortfall-only check (lines 154–168) with:
   ```
   // Compute shortfall in USD (approximate: use dstDecimals to scale)
   // shortfallUsd ≈ (bestAmount - cowAmount) / 10^dstDecimals * ethPriceUsd
   // However, since we don't have ethPriceUsd in scope here, use a simpler approach:
   
   // 1. Check bps threshold (keep as backstop, reduce from 30 to 15 bps)
   // 2. If within 15 bps: promote only if gasless.recommended is true
   //    (gasless engine already factors gas savings vs price gap)
   // 3. Add absolute USD cap: never promote if shortfall > MAX_MEV_SHORTFALL_USD
   ```

   Concrete implementation:
   - Import `analyzeGasless` from `@/lib/gasless-engine` (already imported indirectly via meta)
   - The `rawMeta` already has `gasless` overlay computed in `useQuote.ts` line 182–184
   - Wait — `rawMeta` in SwapBox is before gasless is applied. The gasless overlay is on the `meta` returned by `useQuote`. Check: `useQuote` returns `{ ...result, gasless }` — so `rawMeta` in SwapBox already has `.gasless`.
   - Change the promotion condition (line 159) from:
     ```ts
     if (shortfallBps <= thresholdBps) {
     ```
     to:
     ```ts
     if (shortfallBps <= thresholdBps && rawMeta.gasless?.recommended) {
     ```
   - This ensures CoW is only promoted when the gasless engine — which already considers gas savings vs price gap — says it's recommended.

2. **Reduce threshold from 30 to 15 bps** — In `constants.ts` line 215:
   ```ts
   export const MEV_PREFERENCE_THRESHOLD = 0.0015  // 15 bps (was 0.003 / 30 bps)
   ```

3. **Add USD cap to gasless engine** — In `gasless-engine.ts`, add a `MAX_SHORTFALL_USD` constant:
   ```ts
   export const GASLESS_MAX_SHORTFALL_USD = 3.0
   ```
   In the `savingsExceedGap` calculation (line 111–116), add a USD-based check. Since we don't have USD price of the output in the gasless engine, use the `referenceGasUsd` as a proxy: if gas savings are less than $0.50 AND the bps shortfall is > 15 bps, don't recommend. The existing `withinThreshold` check already guards this — reduce `GASLESS_PRICE_THRESHOLD_BPS` from 50 to 30.

   Actually, the simpler and more correct approach: the gasless engine's `recommended` flag is already conservative (it checks `withinThreshold` and `savingsExceedGap`). The problem is that the MEV preference in SwapBox ignores the gasless engine entirely. Requirement 1 fixes this by gating promotion on `gasless.recommended`. No changes needed to gasless-engine.ts — just tighten the bps threshold.

4. **UI indicator when CoW is promoted** — When `smartMevApplied` is true (line 163), add a visual indicator in the quote comparison panel. Currently the UI shows CoW with a green checkmark as if it's the natural best. Add a small label:
   - In the quote list area of `SwapBox.tsx` (search for where `smartMevApplied` is used in the JSX), show a subtle text like:
     ```
     ✦ Smart-routed via CoW (gasless, ~$X.XX saved)
     ```
   - If `smartMevApplied` but `meta.gasless.gasSavingsUsd < 0.5`, just show: "✦ Smart-routed via CoW (MEV protected)"
   - Use the existing `text-cream-50 text-[11px]` style for subtlety

### Do NOT

- Do NOT remove the MEV preference feature entirely — it's a good UX feature when properly gated
- Do NOT change the MEV toggle (`mevProtected` state) behaviour — that's user-controlled, distinct from smart preference
- Do NOT modify the gasless engine's core logic — just gate the promotion on its recommendation
- Do NOT change how quotes are fetched or sorted in `api.ts`

### Files affected

| File | Action |
|------|--------|
| `src/components/SwapBox.tsx` | Gate promotion on `gasless.recommended`, add smart-route indicator |
| `src/lib/constants.ts` | Reduce `MEV_PREFERENCE_THRESHOLD` from 0.003 to 0.0015 |

### Expected output

- Both files modified, `npm run build` passes, `npx eslint` passes
- When CoW is within 15 bps but gasless engine says not recommended: CoW is NOT promoted, true best stays
- When CoW is within 15 bps AND gasless recommends: CoW IS promoted, indicator shown
- When CoW is beyond 15 bps: never promoted regardless of gasless recommendation
- Desktop: no change in non-MEV-preference scenarios

### Quality criteria

- No false promotions: CoW should never be promoted when user would be net-negative
- Smart-route indicator is subtle and informative, not distracting
- Existing MEV toggle (force ON/OFF) continues to work exactly as before

---

## Prompt 139 — Simulation Revert: Diagnostic Logging + FeeCollector Sender Fix

### Context

When a user clicks "Swap" on a non-CoW source (KyberSwap, Odos, Velora, etc.) routed through FeeCollector V2, the pre-swap `eth_call` simulation consistently reverts with a generic message: "Simulation reverted: swap would fail on-chain. Try a different route or amount."

The `simulateSwapTx` function (`useSwap.ts` lines 33–73) catches the revert but doesn't parse the specific revert reason. The FeeCollector contract emits three distinct revert types:
- `RouterNotWhitelisted()` — router not in on-chain whitelist
- `SwapFailed(bytes result)` — the underlying router call failed
- `InsufficientOutput(uint256 actual, uint256 minimum)` — H-04 minimum output check

Additionally, there's a potential **sender mismatch** issue:
- `fetchSwapViaApi` is called with `from: userWallet` (useSwap.ts line 256)
- The adapter (e.g., KyberSwap) builds calldata with `sender: userWallet`
- But the FeeCollector is the actual `msg.sender` when calling the router
- For ETH swaps: shouldn't matter (ETH passes via `msg.value`)
- For ERC-20 swaps: the FeeCollector does `forceApprove(router, netAmount)` before calling, so the router should pull tokens from `msg.sender` (FeeCollector) via the approval. But if the router's calldata internally does `transferFrom(sender_from_calldata, ...)` instead of `transferFrom(msg.sender, ...)`, the tokens won't move because the approval is on the FeeCollector, not the user.

The fix has two parts: (A) better revert diagnostics so we know exactly what fails, and (B) pass FeeCollector as `sender`/`from` when building swap calldata for FeeCollector-routed sources.

### Objective

1. Surface the exact revert reason to the user and logs
2. Fix the sender mismatch for FeeCollector routing

### Requirements

1. **Parse FeeCollector revert reasons** — In `simulateSwapTx` (`useSwap.ts` lines 54–72), enhance error parsing:
   ```ts
   // After the existing checks, add FeeCollector-specific revert parsing:
   if (msg.includes('RouterNotWhitelisted')) {
     return { success: false, error: 'Router not whitelisted on FeeCollector contract. Contact support.' }
   }
   if (msg.includes('InsufficientOutput')) {
     // Try to extract actual vs minimum from the revert data
     return { success: false, error: 'Swap output below minimum — price moved since quote. Try again or increase slippage.' }
   }
   if (msg.includes('SwapFailed')) {
     return { success: false, error: 'DEX router call failed. Try a different route or increase slippage.' }
   }
   if (msg.includes('ZeroAmount')) {
     return { success: false, error: 'Swap amount is zero.' }
   }
   ```

2. **Log full revert data** — Add a `console.error` in the simulation catch block that logs the full error for debugging:
   ```ts
   console.error('[TeraSwap] Simulation failed:', {
     source: params.source,
     to: params.to,
     value: params.value.toString(),
     gasLimit: params.gas?.toString(),
     errorMessage: msg,
     // Don't log full calldata (security), just the first 10 chars (selector)
     selector: params.data.slice(0, 10),
   })
   ```

3. **Fix sender for FeeCollector routing** — In `useSwap.ts`, when `routeViaFeeCollector` is true, the swap calldata should be built with `from: FEE_COLLECTOR_ADDRESS` instead of `from: userWallet`. This ensures the router's calldata uses the FeeCollector as the token source.

   Change in the `execute` function (line 251–260):
   ```ts
   const swapData = await fetchSwapViaApi(
     source,
     tokenIn.address,
     tokenOut.address,
     apiAmountBn.toString(),
     routeViaFeeCollector ? FEE_COLLECTOR_ADDRESS : address,  // ← KEY CHANGE
     slippage,
     tokenIn.decimals,
     tokenOut.decimals,
   )
   ```

   **IMPORTANT:** The `recipient` in the calldata must still be the user wallet (not the FeeCollector), so tokens go to the user. Check each adapter:
   - KyberSwap: uses `sender` (for transferFrom source) and `recipient` (for output destination) — both are separate. Passing FeeCollector as `sender` and user as `recipient` is correct.
   - BUT: KyberSwap's `fetchSwapData` (line 74) sets `sender: from` and `recipient: recipient ?? from`. Currently `recipient` is not passed from `fetchSwapViaApi` to the adapter. Need to add recipient param.

   Add `recipient` parameter to the swap chain:
   - `fetchSwapViaApi` → add optional `recipient` param
   - `/api/swap` route → pass `recipient` from body to `fetchSwapFromSource`
   - `fetchSwapFromSource` → already has `recipient` param (line 248)
   - Each adapter's `fetchSwapData` → already accepts `recipient` via `SwapParams`

   In `useSwap.ts`:
   ```ts
   const swapData = await fetchSwapViaApi(
     source,
     tokenIn.address,
     tokenOut.address,
     apiAmountBn.toString(),
     routeViaFeeCollector ? FEE_COLLECTOR_ADDRESS : address,
     slippage,
     tokenIn.decimals,
     tokenOut.decimals,
     undefined,  // quoteMeta
     undefined,  // chainId
     routeViaFeeCollector ? address : undefined,  // recipient = user wallet when FeeCollector routes
   )
   ```

4. **Update `fetchSwapViaApi`** to accept and pass `recipient`:
   ```ts
   async function fetchSwapViaApi(
     source: string, src: string, dst: string, amount: string,
     from: string, slippage: number, srcDecimals: number, dstDecimals: number,
     quoteMeta?: QuoteMeta, chainId?: number, recipient?: string,
   ): Promise<NormalizedQuote> {
     const res = await fetch('/api/swap', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         source, src, dst, amount, from, slippage,
         srcDecimals, dstDecimals, quoteMeta, chainId, recipient,
       }),
     })
     ...
   ```

5. **Update `/api/swap` route** to extract and pass `recipient`:
   In `src/app/api/swap/route.ts`, add `recipient` to the destructured body (line 49–60) and pass it to `fetchSwapFromSource`.

6. **Recipient validation adjustment** — The existing R1 recipient check (`validateCallDataRecipient`, useSwap.ts line 290) validates that the calldata recipient matches the connected wallet. When `from` is the FeeCollector, the calldata's output recipient should still be the user wallet. The R1 check uses `address` (user wallet) which is correct — no change needed.

7. **Allowance check adjustment** — The pre-flight allowance check (useSwap.ts line 419–437) verifies `allowance(userWallet, FeeCollector) >= rawAmountBn`. This stays correct — the user must approve the FeeCollector, not the router.

### Do NOT

- Do NOT change the FeeCollector contract — this is a frontend-only fix
- Do NOT change how CoW Protocol swaps work (they bypass FeeCollector entirely)
- Do NOT change the 0x adapter path (it's already in FEE_INCOMPATIBLE_SOURCES)
- Do NOT modify `validateRouterAddress` — the frontend whitelist is separate from on-chain
- Do NOT log full calldata (security risk — could contain token amounts)

### Files affected

| File | Action |
|------|--------|
| `src/hooks/useSwap.ts` | Revert reason parsing, sender fix, recipient param, diagnostic logging |
| `src/app/api/swap/route.ts` | Pass `recipient` from body to `fetchSwapFromSource` |

### Expected output

- Both files modified, `npm run build` passes, `npx eslint` passes
- Simulation errors now show specific messages instead of generic "swap would fail"
- Non-CoW swaps through FeeCollector no longer revert due to sender mismatch
- Console shows structured diagnostic data on simulation failure

### Quality criteria

- Specific revert messages for each FeeCollector error type
- No security data leaked in console logs (no full calldata, no private keys)
- Recipient validation (R1) still passes — user wallet receives tokens
- All existing security checks (router whitelist, selector check, calldata size, fee integrity) unchanged

---

## Prompt 140 — Regression Tests for MEV Preference + Simulation

### Context

Prompts 138 and 139 fix two critical routing bugs. This prompt adds targeted tests to prevent regressions.

### Objective

Cover both fixes with unit tests that verify the new behaviour.

### Requirements

1. **MEV preference tests** — Create `src/components/__tests__/mev-preference.test.ts`:
   - Test: CoW within 15 bps AND gasless.recommended=true → promoted
   - Test: CoW within 15 bps AND gasless.recommended=false → NOT promoted
   - Test: CoW beyond 15 bps AND gasless.recommended=true → NOT promoted
   - Test: CoW beyond 15 bps AND gasless.recommended=false → NOT promoted
   - Test: CoW is actually best (0 bps shortfall) → promoted regardless of gasless
   - Test: No CoW quote available → best stays as-is
   - Test: MEV toggle forced ON → only MEV sources shown (existing behaviour)
   - Test: MEV toggle forced OFF → smart preference still applies (not the force-filter path)

   To test this, extract the MEV preference logic from the `useMemo` in SwapBox.tsx into a pure function (e.g., `selectBestWithMevPreference`) in a new file `src/lib/mev-preference.ts`. The `useMemo` in SwapBox then calls this function. This makes it testable without rendering the full SwapBox component.

   The function signature:
   ```ts
   export function selectBestWithMevPreference(
     rawMeta: MetaQuoteResult,
     mevProtected: boolean,
     aggregatorMeta: typeof AGGREGATOR_META,
     threshold: number,
   ): { meta: MetaQuoteResult | null; smartMevApplied: boolean; mevExposedBest: boolean }
   ```

2. **Simulation revert parsing tests** — Create `src/hooks/__tests__/simulate-swap.test.ts`:
   - Test: `RouterNotWhitelisted` in error message → specific user-facing message
   - Test: `InsufficientOutput` in error message → slippage-related message
   - Test: `SwapFailed` in error message → router failure message
   - Test: `execution reverted` (generic) → generic message
   - Test: `insufficient funds` → balance message
   - Test: Unknown error → `success: true` (non-critical, don't block)

   To test this, extract the error parsing from `simulateSwapTx` into a pure function (e.g., `parseSimulationError`) in the same file or a new `src/lib/simulation.ts`. The `simulateSwapTx` function calls it.

3. **FeeCollector sender routing test** — In `src/hooks/__tests__/simulate-swap.test.ts` or a new file:
   - Test: `routeViaFeeCollector = true` → `fetchSwapViaApi` called with `from: FEE_COLLECTOR_ADDRESS` and `recipient: userWallet`
   - Test: `routeViaFeeCollector = false` → `fetchSwapViaApi` called with `from: userWallet` and `recipient: undefined`
   - These can be mock-based tests that verify the arguments passed to the API call.

### Do NOT

- Do NOT modify any non-test source files except the extraction of pure functions (mev-preference.ts, simulation error parser)
- Do NOT add new test dependencies
- Do NOT test the full SwapBox rendering — test the extracted pure functions only
- Do NOT make network calls in tests — mock all API calls

### Files affected

| File | Action |
|------|--------|
| `src/lib/mev-preference.ts` | New — extracted pure function from SwapBox useMemo |
| `src/lib/simulation.ts` | New — extracted `parseSimulationError` pure function |
| `src/components/SwapBox.tsx` | Import + call `selectBestWithMevPreference` from new module |
| `src/hooks/useSwap.ts` | Import + call `parseSimulationError` from new module |
| `src/components/__tests__/mev-preference.test.ts` | New — 8 test cases |
| `src/hooks/__tests__/simulate-swap.test.ts` | New — 6+ test cases for revert parsing |

### Expected output

- All new + existing files modified, `npm run build` passes, `npx eslint` passes
- `npx vitest run` passes — all new tests green alongside existing 806 tests
- Pure functions are importable and testable without React rendering context

### Quality criteria

- Each test case has a clear name describing the scenario
- No flaky tests (no timers, no network, no randomness)
- Extracted functions are drop-in replacements (SwapBox and useSwap behaviour unchanged)
- Test coverage for all boundary conditions (exactly at threshold, 1 bp above/below)

---

_Sprint 25 deliverables: fix MEV preference promotion logic (user never loses money), fix simulation revert for non-CoW FeeCollector swaps, add regression tests. No contract changes. Two P0 bugs blocking real swap execution._
