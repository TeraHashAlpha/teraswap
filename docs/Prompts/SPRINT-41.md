# Sprint 41 — Mainnet Cleanup (Final MEDIUMs + LOWs)

**Sprint goal:** Close the last actionable MEDIUM (M-02: split-swap simulation) and two LOWs (L-01: quote AbortController, L-05: simulation fail-open) on the mainnet path. After this sprint, the mainnet codebase is at **0C / 0H / 0M** for all non-deferred findings.  
**Branch:** `fix/sprint-41-mainnet-cleanup` (from `main`)  
**Prerequisite:** Sprint 40 merged.  
**Test count baseline:** 1195 (vitest count after Sprint 40)  
**Findings addressed:** FULL-M-02, FULL-L-01, FULL-L-05

---

## Background

After Sprint 40, the mainnet path has 0C/0H but still carries:

- **FULL-M-02:** Split-swap legs are broadcast without pre-swap simulation. The single-swap path runs `eth_call` before wallet prompt; the split path signs/broadcasts each leg blind. Legs that would revert (stale routing, FeeCollector `InsufficientOutput`) are still broadcast → wasted gas + mid-sequence partial failures.
- **FULL-L-01:** `useQuote` has no `AbortController` — the in-flight guard drops new fetches when tokens/amount change mid-request rather than aborting and superseding. New pair's quote delayed up to one poll interval, and a stale resolve can briefly show old-pair data.
- **FULL-L-05:** `simulateSwapTx` returns `{success: true}` on any non-parseable error (fail-open). A flaky RPC silently disables the only client-side revert guard. On-chain `minimumOutput` still protects funds, but the user gets no warning.

These are the last three findings worth closing before Phase 2 (Arbitrum).

---

## P207 — Split-swap pre-simulation

### Context

The single-swap path (`useSwap.ts:407-465`) simulates the final transaction via `eth_call` before the wallet prompt. It constructs the exact FeeCollector calldata (or direct calldata), runs `simulateSwapTx`, and only proceeds if `sim.success === true`. The split-swap path (`useSplitSwap.ts:233-279`) has no equivalent — each leg goes straight to `sendTransactionAsync`.

### Objective

Add per-leg `eth_call` pre-simulation to the split-swap execution flow, using the same `simulateSwapTx` function.

### Requirements

1. **Extract simulation helper.** The simulation setup logic in `useSwap.ts:407-465` (building `simTo`, `simData`, `simValue`, `simGas` based on `routeViaFeeCollector` and `isNativeIn`) is duplicated in the split-swap calldata construction. Extract a shared helper function or replicate the same pattern in `useSplitSwap.ts`. Prefer extracting to `src/lib/swap-simulation.ts` if it can be cleanly shared, otherwise replicate inline.

   The helper should:
   ```typescript
   interface SimulationParams {
     swapData: { tx: { to: string; data: string; gas: number; value?: string }; toAmount: string }
     routeViaFeeCollector: boolean
     isNativeIn: boolean
     tokenIn: Token
     tokenOut: Token
     rawAmount: bigint
     slippage: number
     fromAddress: string
     source: string
   }
   
   function buildSimulationTx(params: SimulationParams): {
     to: `0x${string}`
     data: `0x${string}`
     value: bigint
     gas: bigint
     from: string
     expectedOutput: string
     tokenOut: Token
     source: string
   }
   ```

2. **Simulate each leg before broadcast.** In `useSplitSwap.ts`, after the existing validation checks (router, calldata, recipient, fee integrity) but BEFORE `sendTransactionAsync`, add:

   ```typescript
   // Pre-leg simulation — catches reverts before wallet prompt
   updateLeg(i, { status: 'simulating' })
   const simParams = buildSimulationTx({
     swapData, routeViaFeeCollector, isNativeIn,
     tokenIn, tokenOut, rawAmount: legAmount,
     slippage, fromAddress: address, source,
   })
   const sim = await simulateSwapTx(simParams)
   
   if (!sim.success) {
     updateLeg(i, { status: 'error', error: sim.error || 'Simulation failed — leg would revert' })
     errorCount++
     continue // Skip this leg, try next one
   }
   ```

3. **`simulating` status.** Add `'simulating'` to the leg status type if not already present. The UI should show a "Simulating..." state per leg.

4. **Continue vs abort.** When a leg simulation fails:
   - **Continue** to the next leg (don't abort the entire split). Some legs may succeed even if others would revert (e.g., one DEX has stale liquidity, another doesn't).
   - Track the simulation failure in the leg status so the user sees which legs were skipped.
   - If ALL legs fail simulation, set the overall status to error.

5. **Gas floor.** Use the same `SIM_GAS_FLOOR = 500_000n` pattern as `useSwap.ts` to prevent OOG misreports in simulation.

### Do NOT

- Do NOT remove the existing validation checks (router, calldata, recipient, fee integrity) — simulation is additive
- Do NOT change the single-swap simulation path — only add to split-swap
- Do NOT make simulation blocking across legs — each leg simulates independently
- Do NOT change the FeeCollector ABI or contract interaction

### Files affected

- `src/hooks/useSplitSwap.ts` — add per-leg simulation
- `src/lib/swap-simulation.ts` — **CREATE** (shared helper) OR inline in useSplitSwap
- `src/hooks/useSwap.ts` — refactor to use shared helper (if extracting)

### Expected output

1 commit: `fix(security): add pre-swap simulation to split-swap legs [P207]`

### Quality criteria

- Each split leg is simulated via `eth_call` before wallet prompt
- Failed simulations skip the leg (continue to next)
- All existing validation checks preserved
- Simulation uses the same gas floor as single-swap
- `npm run typecheck` passes
- All existing tests pass

---

## P208 — Quote polling with AbortController

### Context

`useQuote.ts` uses an `inFlightRef` boolean as the only guard against concurrent fetches. When the user changes token pair or amount while a request is in-flight, the new fetch is **dropped** (skipped entirely until the old one completes). This means:

1. The new pair's quote is delayed by up to one full request round-trip
2. A stale resolve from the old request can briefly set `meta` with data for the wrong pair before the next poll corrects it

### Objective

Replace the `inFlightRef` drop-guard with an `AbortController` pattern that cancels the in-flight request and immediately starts the new one.

### Requirements

1. **Create AbortController per fetch.** In `doFetch`:

   ```typescript
   // Abort any in-flight request
   if (abortControllerRef.current) {
     abortControllerRef.current.abort()
   }
   abortControllerRef.current = new AbortController()
   const { signal } = abortControllerRef.current
   ```

2. **Pass signal to fetch.** `fetchQuoteViaApi` (or the underlying `fetch` call) must accept and forward the `AbortSignal`. If `fetchQuoteViaApi` doesn't accept a signal parameter, add one:

   ```typescript
   export async function fetchQuoteViaApi(
     tokenInAddress: string,
     tokenOutAddress: string,
     rawAmount: string,
     decimalsIn: number,
     decimalsOut: number,
     excludeSources?: string[],
     signal?: AbortSignal,  // NEW
   ): Promise<QuoteMeta>
   ```

   Inside, pass `signal` to the `fetch()` call.

3. **Handle AbortError.** In the `catch` block, detect `AbortError` and silently return (don't set error state, don't clear meta — the abort means a newer request is already in-flight):

   ```typescript
   catch (err) {
     if (err instanceof DOMException && err.name === 'AbortError') {
       return // Superseded by a newer request — do nothing
     }
     // ... existing error handling
   }
   ```

4. **Remove inFlightRef guard.** The `if (inFlightRef.current) return` check is no longer needed — the AbortController handles concurrency. Remove it.

5. **Cleanup on unmount.** In the effect cleanup, abort any pending request:

   ```typescript
   return () => {
     if (abortControllerRef.current) {
       abortControllerRef.current.abort()
     }
     // ... existing cleanup (clearInterval, etc.)
   }
   ```

6. **Preserve backoff logic.** The rate-limit backoff (`inBackoffRef`, 429 handling) must continue to work. An aborted request should NOT trigger backoff.

### Do NOT

- Do NOT change the polling interval logic — only the in-flight guard mechanism
- Do NOT change the backoff/429 handling (except to exclude AbortError from error handling)
- Do NOT change `fetchQuoteViaApi`'s return type or core logic — only add the signal parameter
- Do NOT add any npm dependencies — AbortController is a browser built-in

### Files affected

- `src/hooks/useQuote.ts` — AbortController pattern
- `src/lib/quote-fetcher.ts` (or wherever `fetchQuoteViaApi` is defined) — add `signal` parameter

### Expected output

1 commit: `fix(ux): replace in-flight guard with AbortController in useQuote [P208]`

### Quality criteria

- Token/amount change immediately aborts in-flight request and starts new one
- No stale pair data shown after switching tokens
- AbortError silently ignored (no error toast, no meta clear)
- Rate-limit backoff unchanged
- Unmount cleans up pending requests
- `npm run typecheck` passes
- All existing tests pass

---

## P209 — Simulation fail-open hardening

### Context

`simulateSwapTx` (`useSwap.ts:55-73`) returns `{ success: true }` when the simulation error is non-parseable. This fail-open design prevents flaky RPC from blocking swaps, but it silently disables the only client-side revert guard.

### Objective

Make the fail-open transparent to the user by surfacing a warning, without making it fail-closed (which would block swaps on RPC hiccups).

### Requirements

1. **Add `simulated` flag to return type.** Extend `SimulationResult`:

   ```typescript
   interface SimulationResult {
     success: boolean
     error?: string
     gasUsed?: bigint
     simulated?: boolean  // NEW — false when simulation was inconclusive
   }
   ```

2. **Return `simulated: false` on inconclusive.** In the catch block (line ~72):

   ```typescript
   // Non-critical simulation failures — proceed but flag as unsimulated
   console.warn('[TeraSwap] Simulation inconclusive:', err instanceof Error ? err.message : String(err))
   return { success: true, simulated: false }
   ```

   On successful simulation, return `{ success: true, simulated: true }`.

3. **Surface warning in UI.** In `useSwap.ts`, after the simulation call:

   ```typescript
   setSimulationPassed(sim.success)
   
   if (sim.success && sim.simulated === false) {
     // Simulation was inconclusive — warn user but don't block
     console.warn('[TeraSwap] Proceeding without simulation confirmation')
     // Set a flag that SwapBox can use to show a warning
     setSimulationSkipped(true)
   }
   ```

4. **SwapBox warning.** In `SwapBox.tsx`, when `simulationSkipped` is true, show a subtle warning near the swap button (not a blocking modal):

   ```
   ⚠ Simulation unavailable — proceed with caution
   ```

   Use the existing warning/info styling. Clear the flag when a new swap starts or tokens change.

5. **Split-swap too.** Apply the same `simulated` flag handling in the new P207 split-swap simulation. A leg with `simulated: false` should proceed but be flagged in the leg status.

### Do NOT

- Do NOT make simulation fail-closed — the on-chain `minimumOutput` is the real protection
- Do NOT add a blocking modal or confirmation dialog — just a visual warning
- Do NOT change `parseSimulationError` logic
- Do NOT remove the console.warn — keep it for debugging

### Files affected

- `src/hooks/useSwap.ts` — extend SimulationResult, add `simulationSkipped` state
- `src/components/SwapBox.tsx` — show warning when simulation skipped
- `src/hooks/useSplitSwap.ts` — handle `simulated: false` in leg status (if P207 is implemented)

### Expected output

1 commit: `fix(ux): surface warning when swap simulation is inconclusive [P209]`

### Quality criteria

- Inconclusive simulation returns `{ success: true, simulated: false }`
- Successful simulation returns `{ success: true, simulated: true }`
- SwapBox shows subtle warning when simulation skipped
- Warning clears on new swap/token change
- Swap still proceeds (not fail-closed)
- `npm run typecheck` passes
- All existing tests pass

---

## P210 — Tests

### Context

P207-P209 added split-swap simulation, AbortController in quote polling, and simulation warning. This prompt adds test coverage.

### Requirements

#### Split-swap simulation tests (in `src/hooks/useSplitSwap.test.ts` — add or create)

1. **`'simulates each leg before broadcast'`** — mock `simulateSwapTx` to succeed, verify it's called per leg before `sendTransactionAsync`.
2. **`'skips leg on simulation failure'`** — mock simulation to fail for leg 1, succeed for leg 2. Verify leg 1 has status `error`, leg 2 proceeds to broadcast.
3. **`'aborts all legs if all simulations fail'`** — mock all simulations to fail. Verify overall status is error, no `sendTransactionAsync` calls.

#### Quote AbortController tests (in `src/hooks/useQuote.test.ts` — add or create)

4. **`'aborts in-flight request on token change'`** — trigger fetch, change token mid-request, verify the old request is aborted (AbortController.abort called) and new request starts.
5. **`'ignores AbortError silently'`** — mock fetch to throw AbortError, verify no error state set, no meta cleared.
6. **`'cleans up on unmount'`** — unmount hook during in-flight request, verify abort called.

#### Simulation warning tests (in `src/hooks/useSwap.test.ts` — add)

7. **`'sets simulationSkipped when simulation is inconclusive'`** — mock `simulateSwapTx` to return `{ success: true, simulated: false }`, verify `simulationSkipped` is true.
8. **`'clears simulationSkipped on new swap'`** — verify the flag resets when starting a new swap.

### Do NOT

- Do NOT test the exact simulation calldata construction — test the flow (simulate → broadcast vs simulate → skip)
- Do NOT add external dependencies

### Files affected

- `src/hooks/useSplitSwap.test.ts` — add/create (3 tests)
- `src/hooks/useQuote.test.ts` — add/create (3 tests)
- `src/hooks/useSwap.test.ts` — add (2 tests)

### Expected output

1 commit: `test: add split-swap simulation, AbortController, and warning tests [P210]`

### Quality criteria

- All 8 new tests pass
- All existing tests pass
- `npm run typecheck` passes
- Test count: 1195 + 8 = **~1203**

---

## Sprint Summary

| Prompt | Scope | Files | Finding(s) Closed |
|--------|-------|-------|-------------------|
| P207 | Split-swap pre-simulation | 2-3 files | **FULL-M-02** |
| P208 | Quote AbortController | 2 files | **FULL-L-01** |
| P209 | Simulation fail-open warning | 3 files | **FULL-L-05** |
| P210 | Tests | 3 files | Coverage |

**Total estimated scope:** 4 commits, ~8 files, ~8 new tests.

**Test count target:** ~1203

**Risk assessment:** LOW-MEDIUM. P207 adds to an existing execution flow (additive, not changing existing logic). P208 changes the concurrency model of quote fetching (moderate risk — AbortController is well-understood but the interaction with backoff needs care). P209 is mostly UI (low risk).

**Dependency chain:** P207 → P209 (P209 references P207's simulation in split-swap). P208 is independent. P210 depends on all three.

**Post-sprint state:** Mainnet path at **0C / 0H / 0M / 0L** for all non-deferred findings. Ready for Phase 2 (Arbitrum).

---

_Sprint 41 closes FULL-M-02, FULL-L-01, FULL-L-05. After this sprint, the mainnet codebase is fully clean. All remaining findings are deferred to L2/Phase 2._
