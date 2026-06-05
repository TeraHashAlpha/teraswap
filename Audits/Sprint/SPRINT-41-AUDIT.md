# Sprint 41 Audit — Mainnet Cleanup (Final MEDIUMs + LOWs)

**Date:** 2026-05-29
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `fix/sprint-41-mainnet-cleanup`
**Base:** Sprint 40 HEAD (`386ab2b`) — Sprint 40 not yet merged to `main`
**Commits reviewed:** `4a562c2` (P207), `6c635b0` (P208), `6d78dc3` (P209), `fe102b9` (P210), `d76db1b` (P210 review)
**Files changed:** 9 (hooks, lib, components, tests, FEEDBACK.md + new `swap-simulation.ts`)
**Diff:** +525/−114 lines
**Tests:** +9 (verified via grep: 1167 → 1176 TS `it()`/`test()` blocks; audit prompt baseline 1195 → 1204 includes Foundry)
**Signatures:** All 5 commits SSH-signed (`ssh-ed25519`, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 41 Audit Verdict

**Branch:** fix/sprint-41-mainnet-cleanup
**Commits reviewed:** 4a562c2, 6c635b0, 6d78dc3, fe102b9, d76db1b
**Tests:** 1195 → 1204 (+9: 4 split-sim, 3 abort, 2 warning)

### Verdict: APPROVED

0C / 0H / 0M / 0L / 1 INFO

---

## Detailed Review

### 1. P207 — Split-Swap Pre-Simulation (`4a562c2`)

#### Shared helper (`src/lib/swap-simulation.ts` — 151 lines, new file) ✅

- **`buildSimulationTx` exported:** Accepts `SimulationParams` (swapData, routeViaFeeCollector, isNativeIn, tokenIn, tokenOut, rawAmount, slippage, fromAddress, source). Returns `SimulationTx` (`{ to, data, value, gas, from, expectedOutput, tokenOut, source }`). ✅
- **FeeCollector path:** When `routeViaFeeCollector === true`, calls `encodeFunctionData` for FeeCollector's `swapETHWithFee` or `swapTokenWithFee` with correct args. `to` = `FEE_COLLECTOR_ADDRESS`, `value` = `rawAmount` if native-in else 0. ✅
- **Direct path:** When `routeViaFeeCollector === false`, uses `tx.to` and `tx.data` from the DEX router directly. ✅
- **Gas floor:** `SIM_GAS_FLOOR = 500_000n`. If `adapterGas + fcOverhead < floor`, floor is used. FeeCollector overhead: 100K (native-in) / 120K (token-in). ✅
- **`simulateSwapTx` exported:** Calls `publicClient.call({ to, data, value, gas, account: from })`. On success → `{ success: true, simulated: true, gasUsed }`. On parseable error → `{ success: false, error, simulated: true }`. On inconclusive → `{ success: true, simulated: false }`. ✅
- **`console.warn` preserved:** `[TeraSwap] Simulation inconclusive:` on fail-open path. ✅

#### Byte-identical to single-swap ✅

Verified by comparing the removed inline code from `useSwap.ts` with `buildSimulationTx`:

- **`to`:** `routeViaFeeCollector ? FEE_COLLECTOR_ADDRESS : swapData.tx.to` — identical. ✅
- **`data`:** `encodeFunctionData` with same ABI, functionName, args order — identical. ✅
- **`value`:** `routeViaFeeCollector && isNativeIn ? rawAmount : BigInt(tx.value || '0')` — identical. ✅
- **`gas`:** Same floor logic with same 500K floor and same FC overhead — identical. ✅
- **`minimumOutput`:** Same formula: `safeBigInt(toAmount) * (10_000n - slippageBpsBn) / 10_000n` with same null-guard (`0n`) — identical. ✅
- **`tokenOutForFc`:** Same: `isNativeETH(tokenOut) ? ZERO_ADDRESS : tokenOut.address` — identical. ✅

The refactored `useSwap.ts` now calls `buildSimulationTx(params)` + `simulateSwapTx(simTx)` instead of inline construction. Pure extraction, no behavioral change.

#### Split-swap integration (`src/hooks/useSplitSwap.ts`) ✅

- **Simulation before broadcast:** Each leg: `buildSimulationTx()` → `simulateSwapTx()` → then (only if success) `sendTransactionAsync`. ✅
- **`simulating` status:** `updateLeg(i, { status: 'simulating' })` before simulation call. Type union updated to include `'simulating'`. ✅
- **Failed leg skipped:** `if (!sim.success)` → `updateLeg(i, { status: 'error', error: ... })`, `errorCount++`, `continue`. No `sendTransactionAsync`. ✅
- **Continue, not abort:** Loop continues to next leg — a failing leg does NOT abort others. ✅
- **All-fail = overall error:** After loop, if `errorCount === legs.length` → overall error status. ✅
- **Existing validation preserved:** Router whitelist check, calldata validation, recipient validation, fee integrity check — all run BEFORE simulation (lines 175–209 unchanged). Simulation is additive at lines 214–247. ✅
- **No `sendTransactionAsync` without simulation:** Linear flow — simulation block must execute before `// Step 2: Send transaction`. No alternate path or early jump. ✅

#### useSwap.ts refactor ✅

- **Uses shared helper:** Imports `buildSimulationTx` + `simulateSwapTx` from `swap-simulation.ts`. Old inline `simulateSwapTx` function (45 lines) and inline calldata construction (20 lines) removed. ✅
- **Behavior unchanged:** `setStatus('simulating')`, `simulateSwapTx()`, `setSimulationPassed()` — same flow, just via shared module. ✅

### 2. P208 — Quote AbortController (`6c635b0`) ✅

#### useQuote.ts ✅

- **AbortController per fetch:** `abortControllerRef = useRef<AbortController | null>(null)`. At start of `doFetch`: `abortControllerRef.current?.abort()`, create new `AbortController`, extract `signal`. ✅
- **Signal passed to fetch:** `fetchQuoteViaApi(...)` receives `signal` as last argument. ✅
- **AbortError handling:** `if (err instanceof DOMException && err.name === 'AbortError') return` — no error state set, no meta cleared, no backoff triggered. Early return is BEFORE the 429/backoff check. ✅
- **`inFlightRef` removed:** The `if (inFlightRef.current) return` guard is gone. `inFlightRef` declaration removed entirely. ✅
- **Unmount cleanup:** Effect cleanup calls `abortControllerRef.current?.abort()`. ✅
- **Backoff preserved:** `inBackoffRef` and 429 handling logic unchanged. AbortError early return prevents abort from triggering backoff. ✅
- **Token/amount change triggers abort:** When deps change → `doFetch` identity changes → polling effect re-runs → old interval cleared, new `doFetch` call aborts previous controller. ✅
- **No stale data:** Aborted request rejects with AbortError → early return → no state update. ✅
- **`finally` block:** `if (!signal.aborted) setLoading(false)` — only the current (non-aborted) request clears the spinner. Prevents race where aborted request flips spinner off mid-fetch. ✅
- **`refresh` callback:** No longer checks `inFlightRef.current`. Always calls `doFetchRef.current()` which aborts stale and starts fresh. Manual refresh always works. ✅

#### fetchQuoteViaApi ✅

- **Signal parameter:** `signal?: AbortSignal` as last parameter (optional, backward-compatible). ✅
- **Signal forwarded:** `fetch(url, signal ? { signal } : undefined)`. ✅
- **No other changes:** URL construction, params, response parsing unchanged. ✅

### 3. P209 — Simulation Fail-Open Warning (`6d78dc3`) ✅

#### SimulationResult type ✅

- **`simulated` field:** `simulated?: boolean` on `SimulationResult` interface. ✅
- **Success + simulated:** `{ success: true, simulated: true }` on successful `eth_call`. ✅
- **Success + unsimulated:** `{ success: true, simulated: false }` on inconclusive catch. ✅
- **Failure:** `{ success: false, error, simulated: true }` on parseable revert. ✅
- **`console.warn` preserved.** ✅

#### useSwap.ts ✅

- **`simulationSkipped` state:** `useState<boolean>(false)`. ✅
- **Set on inconclusive:** `if (sim.success && sim.simulated === false) setSimulationSkipped(true)`. ✅
- **Clear on new swap:** `setSimulationSkipped(false)` at start of `executeStandardSwap`, `executeCowSwap`, and in `reset()`. Three clear sites cover all entry points. ✅
- **Exposed to SwapBox:** Returned from hook: `return { ..., simulationSkipped, ... }`. ✅

#### SwapBox.tsx ✅

- **Warning displayed:** `{simulationSkipped && <div>⚠ Simulation unavailable — proceed with caution</div>}`. ✅
- **Non-blocking:** No modal, no dialog, swap button still functional. ✅
- **Clear on change:** Clears at swap start (via `setSimulationSkipped(false)` in execute). ✅
- **Styling consistent:** `text-warning/90`, `text-[11px]`, `flex items-center justify-center gap-1.5` — matches existing pattern (revert warning above). ✅
- **`simulating` status in split-swap legs:** Added to leg status display: `leg.status === 'simulating' ? 'Simulating...'`. ✅

#### Split-swap integration ✅

- **`simulated: false` handled in legs:** `if (sim.simulated === false) updateLeg(i, { simulated: false })` — leg proceeds to broadcast, flagged. ✅
- **LegStatus type updated:** `simulated?: boolean` field added to `LegStatus` interface. ✅

### 4. P210 — Tests (`fe102b9` + `d76db1b`) ✅

#### Split-swap simulation tests (`useSplitSwap.test.ts` — 4 tests) ✅

1. **`'simulates each leg before broadcast'`:** Mocks `simulateSwapTx` success. Verifies called per leg (2 times). Verifies `invocationCallOrder` — simulation before `sendTransactionAsync`. ✅
2. **`'skips leg on simulation failure'`:** Leg 1 fails, leg 2 passes. Verifies leg[0].status = error with revert message, leg[1].status = success, sendTransaction called once. Overall status = partial. ✅
3. **`'aborts all legs if all simulations fail'`:** All simulations fail. Verifies overall error, all legs error, zero `sendTransactionAsync` calls. ✅
4. **`'flags a leg whose simulation is inconclusive (simulated:false) but still broadcasts it'` (d76db1b):** Leg 1 inconclusive (`{ success: true, simulated: false }`), leg 2 conclusive. Verifies both broadcast (fail-open), leg[0].simulated = false, leg[0].status = success, leg[1].simulated ≠ false. ✅

- **Mock strategy:** `buildSimulationTx` left real (pure calldata), only `simulateSwapTx` mocked. Correct — tests the integration, not the pure function. ✅

#### Quote AbortController tests (`useQuote.test.ts` — 3 tests) ✅

1. **`'aborts the in-flight request when the token pair changes'`:** Rerenders with swapped pair. Verifies first signal aborted, new fetch issued. ✅
2. **`'ignores AbortError silently'`:** Mocks fetch to throw `new DOMException('...', 'AbortError')`. Verifies no error state, meta retained from prior successful fetch. ✅
3. **`'cleans up on unmount'`:** Unmounts during in-flight. Verifies signal aborted. ✅

- **Existing test adapted:** `'in-flight guard: no-op'` → `'supersedes in-flight request'`. Mandatory update (old test asserted removed behavior). Not counted as new. ✅

#### Simulation warning tests (`useSwap.test.ts` — 2 tests) ✅

1. **`'sets simulationSkipped when the simulation is inconclusive'`:** Mocks `{ success: true, simulated: false }`. Verifies `simulationSkipped === true`, status still `'confirming'` (not fail-closed). ✅
2. **`'clears simulationSkipped on a new swap'`:** Inconclusive first swap sets flag, conclusive second swap clears it. ✅

#### Review test (d76db1b) ✅

- **Covers:** Inconclusive-sim split leg fail-open (`simulated: false` path in useSplitSwap). ✅
- **No overlap:** Spec tests cover success, failure, all-fail. Review test covers the inconclusive fail-open path in split legs specifically. ✅

### 5. FEEDBACK.md ✅

Three items added, all valid:

1. **Sprint 40 branching:** Branch cut from Sprint 40 HEAD, not `main`, because Sprint 40 wasn't merged. Correctly flagged for Architect: merge Sprint 40 first, or rebase Sprint 41 onto `main` post-merge. ✅
2. **P208 existing test rewrite:** The `'in-flight guard: no-op'` test asserted removed behavior (`inFlightRef` drop-guard). Mandatory rewrite to supersede semantics in same commit. Not deferrable to P210. ✅
3. **P210 review test gap:** Adversarial review found missing split-swap inconclusive path test. Remediated in d76db1b. ✅

### 6. General ✅

- **No scope creep:** 9 files: hooks (useSwap, useSplitSwap, useQuote + tests), lib (new swap-simulation.ts), components (SwapBox), FEEDBACK.md. All within expected scope. ✅
- **No new dependencies:** No npm packages added. ✅
- **TypeScript/Lint/Tests:** Cannot run in sandbox (rolldown ARM binary / path-space issue). Code review verified: types correct, no lint violations visible, test patterns sound. Delta: +9 `it()` blocks confirmed by grep. ✅
- **Commits signed:** All 5 commits carry `gpgsig` with `-----BEGIN SSH SIGNATURE-----` (`ssh-ed25519`). ✅

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 41-I-01 | INFO | `swap-simulation.ts` / `useSwap.ts` | `minimumOutput` is computed independently in both `buildSimulationTx` (shared helper, used for simulation) and the broadcast path in `useSwap.ts` (inline, used for actual tx). Values are guaranteed identical for same inputs, but dual computation is a maintenance risk — a future edit to one without the other could introduce a sim/broadcast discrepancy. Consider extracting `minimumOutput` computation to a shared pure function. |

---

## Comprehensive Audit Findings Closure

| Finding | Status | Verified |
|---------|--------|----------|
| FULL-M-02 (split-swap no simulation) | CLOSED | ✅ Each split leg calls `buildSimulationTx` → `simulateSwapTx` before `sendTransactionAsync`. Failed legs skipped, others proceed. No bypass path. 4 tests. |
| FULL-L-01 (quote no AbortController) | CLOSED | ✅ `AbortController` replaces `inFlightRef`. Signal forwarded to fetch. AbortError silently swallowed (no error state, no backoff). Unmount cleanup aborts. 3 tests. |
| FULL-L-05 (simulation fail-open silent) | CLOSED | ✅ `simulated: false` flag on inconclusive sim. `simulationSkipped` state in useSwap, warning UI in SwapBox. Non-blocking. Split legs also flagged. 3 tests (2 warning + 1 split-leg review). |

---

## Mainnet Path Status

After Sprint 40 + 41:
- Critical: 0
- High: 0
- Medium: 0
- Low: 0
- Info: 5 (Sprint 40: 4, Sprint 41: 1)
- Deferred to L2: 5M + 3L (DCA/Limit/SL·TP, executor gas, order engine scope)

**The mainnet swap path is at 0C / 0H / 0M / 0L.** All non-deferred findings from the comprehensive audit (2026-05-28) are closed.

---

## FEEDBACK Deviations

| # | Item | Auditor Assessment |
|---|------|-------------------|
| 1 | Branched from Sprint 40 HEAD, not main | **Accept.** Sprint 40 wasn't merged when Sprint 41 was cut. All Sprint 40 commits are ancestors. Action: merge Sprint 40 to main first, then Sprint 41 (or rebase Sprint 41 onto post-merge main). No security impact. |
| 2 | P208 existing test rewrite (in-flight guard → supersede) | **Accept.** The old test pinned removed behavior (`inFlightRef` boolean guard). Rewriting it in the same commit as the behavioral change is correct — deferring to P210 would have left a broken test. |
| 3 | P210 review: inconclusive-sim split leg test gap | **Accept.** Adversarial review correctly identified the gap. Test added in d76db1b covers fail-open (not fail-closed) for split legs with `simulated: false`. |

---

## Recommendation

**Merge** (after Sprint 40 merges to `main`). All 3 mainnet findings are closed. The mainnet swap path is clean: 0C / 0H / 0M / 0L. The single INFO finding (dual `minimumOutput` computation) is a code-quality note for future cleanup, not a security concern.

Sprint 41 completes the security hardening arc that started with the comprehensive audit (2026-05-28). Combined with Sprint 40 (2H + 2M closed), the project has resolved all Critical, High, Medium, and Low findings on the mainnet path.
