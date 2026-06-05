# Sprint 41 Audit — Mainnet Cleanup (Final MEDIUMs + LOWs)

**Role:** You are a Senior Security Auditor reviewing Sprint 41 of the TeraSwap DEX aggregator. Your job is to verify the correctness of the split-swap simulation, the AbortController concurrency fix, and the simulation fail-open warning.

**Branch:** `fix/sprint-41-mainnet-cleanup`  
**Base:** `main` (with Sprint 40 merged)  
**Commits:** 5 (P207 `4a562c2`, P208 `6c635b0`, P209 `6d78dc3`, P210 `fe102b9`, P210 review `d76db1b`)  
**Files changed:** hooks, lib modules, components, test files  
**Test count:** 1195 → 1204 (+9: 8 spec + 1 review)

**Risk level:** MEDIUM — P207 adds to the swap execution hot path (fund-adjacent), P208 changes concurrency model of quote fetching, P209 is UI-only (low risk). The Code Agent ran an adversarial 4-dimension review (behavior-preservation, concurrency/abort, fail-open security, spec/edges) and added 1 test gap fix.

---

## Context

Sprint 41 closes the last 3 non-deferred findings on the mainnet path. After Sprint 40 (0C/0H), the mainnet still carried 1 MEDIUM and 2 LOWs:

| Prompt | Finding | Description |
|--------|---------|-------------|
| P207 | FULL-M-02 | Split-swap legs broadcast without pre-simulation — now simulated via `eth_call` per leg |
| P208 | FULL-L-01 | Quote `inFlightRef` drop-guard caused stale data — now replaced with AbortController |
| P209 | FULL-L-05 | `simulateSwapTx` fail-open was silent — now surfaces warning to user |
| P210 | Coverage | 8 spec tests + 1 adversarial review test |

After this sprint, the mainnet path should be at **0C / 0H / 0M / 0L** for all non-deferred findings.

---

## Audit Checklist

### 1. P207 — Split-Swap Pre-Simulation (`4a562c2`)

#### Shared helper (`src/lib/swap-simulation.ts`)

- [ ] **`buildSimulationTx` exported:** Accepts `SimulationParams` (swapData, routeViaFeeCollector, isNativeIn, tokenIn, tokenOut, rawAmount, slippage, fromAddress, source). Returns `{ to, data, value, gas, from, expectedOutput, tokenOut, source }`.
- [ ] **FeeCollector path:** When `routeViaFeeCollector === true`, builds `encodeFunctionData` for FeeCollector's `swap` function with correct args (`router`, `swapCalldata`, `tokenIn`, `tokenOut`, `rawAmount`, `minimumOutput`, `source`). `to` = FeeCollector address, `value` = rawAmount if native-in else 0.
- [ ] **Direct path:** When `routeViaFeeCollector === false`, uses the DEX router's tx directly. `to` = `swapData.tx.to`, `data` = `swapData.tx.data`.
- [ ] **Gas floor:** Uses `SIM_GAS_FLOOR = 500_000n`. If `swapData.tx.gas` < floor, floor is used.
- [ ] **`simulateSwapTx` exported:** Calls `publicClient.call({ to, data, value, gas, account: from })`. On success returns `{ success: true, simulated: true, gasUsed }`. On failure, parses error and returns `{ success: false, error, simulated: true }`. On inconclusive, returns `{ success: true, simulated: false }`.
- [ ] **Byte-identical to single-swap:** Verify the refactored single-swap path (`useSwap.ts`) produces the EXACT same calldata as before the refactor — the helper must be a pure extraction, not a behavioral change.

#### Split-swap integration (`src/hooks/useSplitSwap.ts`)

- [ ] **Simulation before broadcast:** Each leg calls `buildSimulationTx` → `simulateSwapTx` BEFORE `sendTransactionAsync`. No wallet prompt until simulation passes.
- [ ] **`simulating` status:** Leg status is set to `'simulating'` before simulation call. Type definition updated to include `'simulating'`.
- [ ] **Failed leg skipped:** If `sim.success === false`, leg status = error with sim.error message. `errorCount++` and `continue` to next leg. No `sendTransactionAsync` call for that leg.
- [ ] **Continue, not abort:** A failing leg does NOT abort the entire split. Other legs proceed independently.
- [ ] **All-fail = overall error:** If ALL legs fail simulation, overall status is set to error.
- [ ] **Existing validation preserved:** Router whitelist check, calldata validation, recipient validation, fee integrity check — all still run BEFORE simulation (simulation is additive).
- [ ] **No `sendTransactionAsync` without simulation:** Verify there is NO code path where a split leg broadcasts without passing through simulation first.

#### useSwap.ts refactor

- [ ] **Uses shared helper:** `useSwap.ts` now imports and uses `buildSimulationTx` + `simulateSwapTx` from `swap-simulation.ts` instead of inline logic.
- [ ] **Behavior unchanged:** Single-swap simulation flow (simulate → wallet prompt → broadcast) is identical to pre-Sprint-41.

### 2. P208 — Quote AbortController (`6c635b0`)

#### useQuote.ts

- [ ] **AbortController per fetch:** `abortControllerRef = useRef<AbortController | null>(null)`. At start of `doFetch`: abort existing controller, create new one, extract signal.
- [ ] **Signal passed to fetch:** `fetchQuoteViaApi` receives the signal and forwards it to the underlying `fetch()` call.
- [ ] **AbortError handling:** In catch block, `AbortError` detected (via `err instanceof DOMException && err.name === 'AbortError'` or equivalent). On AbortError: silent return — NO error state set, NO meta cleared, NO backoff triggered.
- [ ] **inFlightRef removed:** The `if (inFlightRef.current) return` guard is gone. `inFlightRef` declaration removed (or repurposed for cleanup only).
- [ ] **Unmount cleanup:** Effect cleanup aborts any pending controller.
- [ ] **Backoff preserved:** 429 handling and `inBackoffRef` logic unchanged. An abort does NOT trigger backoff (verify the AbortError early return is BEFORE the 429/backoff check).
- [ ] **Token/amount change triggers abort:** When deps change (tokenIn, tokenOut, amount), the next `doFetch` aborts the previous in-flight request and starts fresh.
- [ ] **No stale data:** A superseded request's `.then()` does NOT update state (because it was aborted).

#### fetchQuoteViaApi (quote-fetcher.ts or similar)

- [ ] **Signal parameter added:** `signal?: AbortSignal` as last parameter (optional, backward-compatible).
- [ ] **Signal forwarded:** `fetch(url, { ..., signal })` — the browser-level fetch receives the signal.
- [ ] **No other changes:** Return type, URL construction, response parsing unchanged.

### 3. P209 — Simulation Fail-Open Warning (`6d78dc3`)

#### SimulationResult type

- [ ] **`simulated` field added:** `simulated?: boolean` on `SimulationResult` interface.
- [ ] **Success + simulated:** Successful `eth_call` → `{ success: true, simulated: true }`.
- [ ] **Success + unsimulated:** Inconclusive catch → `{ success: true, simulated: false }`.
- [ ] **Failure:** Parseable error → `{ success: false, error: '...', simulated: true }`.
- [ ] **console.warn preserved:** `[TeraSwap] Simulation inconclusive:` log still present.

#### useSwap.ts

- [ ] **`simulationSkipped` state:** `useState<boolean>(false)` (or equivalent).
- [ ] **Set on inconclusive:** After simulation, if `sim.success && sim.simulated === false`, sets `simulationSkipped(true)`.
- [ ] **Clear on new swap:** Flag resets when a new swap starts (tokens change, amount changes, or swap initiated).
- [ ] **Exposed to SwapBox:** `simulationSkipped` is returned from the hook or accessible by SwapBox.

#### SwapBox.tsx

- [ ] **Warning displayed:** When `simulationSkipped === true`, a warning message is visible near the swap button.
- [ ] **Non-blocking:** Warning is purely informational — no modal, no confirmation dialog, swap button still functional.
- [ ] **Clear on change:** Warning disappears when tokens or amount change, or when a new swap starts.
- [ ] **Styling consistent:** Uses existing warning/info styling from the design system.

#### Split-swap integration

- [ ] **`simulated: false` handled in legs:** When a split-swap leg simulation returns `simulated: false`, the leg proceeds but its status reflects the inconclusive state (not silently swallowed).

### 4. P210 — Tests (`fe102b9` + `d76db1b`)

#### Split-swap simulation tests (`useSplitSwap.test.ts`)

- [ ] **`'simulates each leg before broadcast'`:** Mocks `simulateSwapTx` to succeed. Verifies it's called per leg. Verifies `sendTransactionAsync` called after simulation.
- [ ] **`'skips leg on simulation failure'`:** Mocks simulation to fail for one leg, succeed for another. Verifies failed leg has error status, successful leg proceeds to broadcast.
- [ ] **`'aborts all legs if all simulations fail'`:** Mocks all simulations to fail. Verifies overall error status. Verifies zero `sendTransactionAsync` calls.

#### Quote AbortController tests (`useQuote.test.ts`)

- [ ] **`'aborts in-flight request on token change'`:** Triggers fetch, changes token mid-request. Verifies `AbortController.abort()` called and new request initiated.
- [ ] **`'ignores AbortError silently'`:** Mocks fetch to throw AbortError. Verifies no error state, no meta cleared.
- [ ] **`'cleans up on unmount'`:** Unmounts hook during in-flight request. Verifies abort called.

#### Simulation warning tests (`useSwap.test.ts`)

- [ ] **`'sets simulationSkipped when simulation is inconclusive'`:** Mocks `simulateSwapTx` returning `{ success: true, simulated: false }`. Verifies `simulationSkipped` is true.
- [ ] **`'clears simulationSkipped on new swap'`:** Verifies flag resets on new swap initiation.

#### Review test (`d76db1b`)

- [ ] **Adversarial review finding:** Identify what the review test covers (described as "inconclusive-sim split leg test"). Verify it tests the `simulated: false` path in split-swap legs specifically.
- [ ] **No overlap with spec tests:** Review test adds coverage the 8 spec tests don't have.

### 5. FEEDBACK.md

- [ ] **Reviewed:** If the Code Agent added feedback, verify all items are valid and triaged.
- [ ] **Sprint 40 branching note:** The Code Agent noted it branched from Sprint 40 HEAD (not `main`) because Sprint 40 wasn't merged in its working tree. Verify this was resolved via rebase before the audit.

### 6. General

- [ ] **No scope creep:** Changes limited to the specified files + the new `swap-simulation.ts`.
- [ ] **No new dependencies:** No npm packages added.
- [ ] **TypeScript:** `npm run typecheck` must pass.
- [ ] **Lint:** `npm run lint` must pass.
- [ ] **All tests:** `npm run test` must pass with 0 failures. Report actual test count.
- [ ] **Commits signed:** All 5 commits must be SSH/GPG signed.

---

## Expected Output

```markdown
## Sprint 41 Audit Verdict

**Branch:** fix/sprint-41-mainnet-cleanup
**Commits reviewed:** 4a562c2, 6c635b0, 6d78dc3, fe102b9, d76db1b
**Tests:** 1195 → {actual count}

### Verdict: {APPROVED | APPROVED WITH WARNINGS | REJECTED}

{0C / 0H / 0M / 0L / NI INFO}

### Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 41-{severity}-{NN} | {C/H/M/L/INFO} | {file} | {description} |

### Comprehensive Audit Findings Closure

| Finding | Status | Verified |
|---------|--------|----------|
| FULL-M-02 (split-swap no simulation) | {CLOSED/OPEN} | {yes/no} |
| FULL-L-01 (quote no AbortController) | {CLOSED/OPEN} | {yes/no} |
| FULL-L-05 (simulation fail-open silent) | {CLOSED/OPEN} | {yes/no} |

### Mainnet Path Status

After Sprint 40 + 41:
- Critical: {count}
- High: {count}
- Medium: {count}
- Low: {count}
- Info: {count}
- Deferred to L2: {count}

### FEEDBACK Deviations

| # | Item | Auditor Assessment |
|---|------|-------------------|
| 1 | Branched from Sprint 40 HEAD, not main | {Accept / Flag / Fix required} |
| {N} | {any Code Agent FEEDBACK items} | {Accept / Flag / Fix required} |

### Recommendation

{Merge / Fix required / ...}
```

Run `npm run typecheck`, `npm run lint`, and `npm run test` before delivering the verdict. Report the actual test count.
