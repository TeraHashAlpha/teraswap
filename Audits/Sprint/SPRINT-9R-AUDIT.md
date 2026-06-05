# Sprint 9R Audit — Review Integrity (Frozen Calldata + Split Review Gate)

**Date:** 2026-06-04
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `feat/sprint-9r-review-integrity`
**Commits reviewed:** `965928e` (R2 frozen modal), `b9cd4b3` (R1 two-phase split), `fc71377` (audit remediation), `f124607` (FEEDBACK)
**Files changed:** 9 (+858/−182 lines)
**Tests:** +12 new `it()` blocks
**Signatures:** All 4 commits SSH-signed (`ssh-ed25519`, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 9R Audit Verdict

### Verdict: APPROVED

0C / 0H / 0M / 0L / 1 INFO

---

## Principle: NO wallet signature without TeraSwap review of the exact FROZEN calldata being signed.

### Check 1: No-bypass — no signature path reaches the wallet un-reviewed ✅

| Path | Pre-review gate | Verified |
|------|----------------|----------|
| **Single swap** | `execute()` builds pendingSwap → status `'confirming'` → TransactionPreview modal opens → `confirmSwap()` signs the frozen pendingSwap 1:1 | ✅ `sendTransactionAsync` only in `confirmSwap()`, never in `execute()` |
| **Split leg (every leg)** | Phase A `execute()`: fetch + validate + simulate + encode → freeze `PlannedLeg[]` → status `'awaiting-review'`. Phase B `confirmPlan()`: iterates frozen legs → `sendTransactionAsync(p.txTo, p.txData, ...)`. Only legs with `status === 'reviewed'` are signed. | ✅ No `sendTransactionAsync` in Phase A. `confirmPlan()` guard: `if (status !== 'awaiting-review') return` |
| **Post-9O-fallback rebuild** | Re-invoking `execute()` resets to `'planning'`, builds a NEW plan → `'awaiting-review'`. The new plan must be re-reviewed via the modal. | ✅ `setPlannedLegs([])` at start of execute → plan superseded |
| **Retries** | User rejection in Phase B aborts remaining legs. Retrying requires re-invoking `execute()` → full rebuild → re-review. | ✅ No "resume where you left off" path without re-review |

### Check 2: Frozen fidelity — modal renders the frozen snapshot ✅

**Single swap (R2):**
- `PendingSwapData` now includes frozen `tokenIn: Token` and `tokenOut: Token` fields (commit 965928e). ✅
- TransactionPreview receives `pendingSwap.tokenIn`, `pendingSwap.tokenOut`, `pendingSwap.swapToAmount` — all frozen at calldata-build time. Previously received live SwapBox state (`tokenIn`/`tokenOut`) which could change if the user clicked a different token while the modal was open. ✅
- `amountInDisplay` now derived from `formatUnits(pendingSwap.rawAmountBn, pendingSwap.tokenIn.decimals)` (frozen), not live `displayAmountIn`. ✅

**Split swap (R1):**
- `SplitReviewModal` receives `plannedLegs` which contain frozen `routerAddress`, `routerCalldata`, `txTo`, `txData`, `txValue`, `txGas`, `legMinOutput`, `expectedOut`. ✅
- `confirmPlan()` signs these frozen values byte-for-byte — no re-fetch, no re-encode. ✅
- The encoding in Phase A is byte-identical to what was previously encoded inline in the single-phase execute (same `encodeFunctionData` calls with same args — pure extraction, no behavioral change). ✅

### Check 3: Remediation holds (audit commit `fc71377`) ✅

**Chain/account switch invalidates the plan:**

| Guard | Mechanism | Verified |
|-------|-----------|----------|
| Account switch/disconnect | `prevAddressRef` + `useEffect([address])` → `reset()` clears `plannedLegs`, status → `'idle'`, `planContextRef → null` | ✅ Parity with useSwap's [FULL-M-04] pattern |
| Chain switch | `prevChainIdRef` + `useEffect([chainId])` → `reset()` | ✅ Parity with useSwap's [P219] pattern |
| confirmPlan defense-in-depth | Synchronous check: `planContextRef.current.chainId !== chainId` or `address` mismatch → `reset()` | ✅ Holds independent of React effect timing |

**Rationale:** The frozen plan's calldata embeds chain-A's FeeCollector address, router target, and account-A as the recipient. Signing it under chain/account B is exactly the [P219]/[FULL-M-04] vulnerability. 9R's review-pause widened the window from near-zero to indefinite human-paced wait → the guard is now load-bearing.

**SwapButton re-entry guard:**
- `executingRef = useRef(false)` — true during Phase B, checked by both `execute()` (blocks rebuild) and `confirmPlan()` (blocks double-submit). Released in `finally`. ✅

**TokenSelector.onSelect resets:**
- Both selectors now call `resetSplitSwap()` alongside `resetSwap()` → no stale plan survives a token change. ✅

### Check 4: Scope — display/flow-control only ✅

| Scope area | Changed? |
|-----------|----------|
| Price gate / deviation / oracle | NO |
| Simulation (swap-simulation.ts) | NO |
| FeeCollector routing / encoding | Moved from Phase B to Phase A — same `encodeFunctionData` calls, same args. Byte-identical calldata. |
| Adapters | NO (no adapter file changed) |
| Selectors (swap-selectors.ts) | NO |
| Calldata-recipient validation | NO |
| 9Q chainId threading | NO |
| Router whitelist | NO |

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 9R-I-01 | INFO | `useSplitSwap.ts` | The frozen plan in Phase A embeds calldata at build-time. If the underlying quote expires while the user reviews (e.g., liquidity shifts), the on-chain `minimumOutput` still protects the fill — a worse-than-expected execution reverts at the FeeCollector/router level. The stale-calldata risk is bounded by the same on-chain guard that protects all swaps. |

---

## Recommendation

**Merge.** The two-phase split architecture correctly enforces the review-integrity principle: no wallet signature without a TeraSwap review of the exact frozen calldata. The audit remediation (chain/account-switch invalidation + Phase-B re-entry guard) holds the invariant under all observable race conditions. Scope is strictly display/flow-control — no changes to gates, simulation, FeeCollector routing, adapters, or selectors.
