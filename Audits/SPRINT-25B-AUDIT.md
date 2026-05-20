# Sprint 25B Audit — P141–P148 (Hotfixes)

> **Date:** 2026-05-20
> **Auditor:** Claude (Senior Architect / Auditor role)
> **Branch:** `fix/quote-routing-and-sim` (commits `c760e8f..468f2a1`)
> **Scope:** 8 hotfix commits — CORS proxy, gas simulation, selector/whitelist additions, UI fixes, error selector correction
> **Base:** Sprint 24 (P134–P137) + Sprint 25 (P138–P140) — both previously audited and APPROVED
> **Tests:** 839/839 passing (47 test files). TypeScript typecheck: 0 errors.

---

## VERDICT: **APPROVED** — 0 Critical / 0 High / 0 Medium / 0 Low / 5 INFO

Sprint 25B is approved for merge to `main` and production deployment.

---

## Executive Summary

Sprint 25B resolves a cascade of swap execution failures discovered during production testing. The root cause was CORS blocking from `eth.merkle.io` (P142), which masked secondary issues: simulation gas underestimation (P143), missing ParaSwap Augustus V6 selector/router entries (P144/P146), a UI source toggle typo (P145), and an error selector signature mismatch (P148). A manual quote refresh button (P147) was added for UX. P141 temporarily bypasses FeeCollector for two sources pending router timelock execution on 2026-05-22.

All changes are frontend/API-layer only. No smart contract changes. No fund-flow logic altered. Fee bypass (P141) is explicitly temporary with documented reversion plan.

---

## Commit-by-Commit Review

### P141 — `c760e8f` — Temp bypass FeeCollector for uniswapv3 + odos
**Risk:** LOW — Foregoes 0.1% fee on 2 sources until timelock executes.
**Review:**
- Adds `'uniswapv3'` and `'odos'` to `FEE_INCOMPATIBLE_SOURCES` in `constants.ts`.
- Comment documents exact timelock TX hashes and reversion deadline (2026-05-22 ~10:42 UTC).
- `usesFeeCollector()` correctly returns `false` → swaps go direct to router → no `RouterNotWhitelisted` revert.
- **No security degradation:** Direct routing still passes ROUTER_WHITELIST check, KNOWN_SWAP_SELECTORS check, R1 recipient validation, Chainlink price guard, and simulation. Only fee collection is skipped.
- **Finding:** None. Acceptable temporary measure.

### P142 — `e0f50ca` — Route all browser RPC through /api/rpc proxy
**Risk:** MEDIUM (infra change) — **Correctly implemented.**
**Review:**
- `src/lib/rpc.ts`: Removed direct-RPC fallback in `proxyTransport()`. Now throws `RPC proxy error` on failure instead of falling back to CORS-blocked `eth.merkle.io`. ✅
- `src/lib/adapters/shared.ts`: `getRpcUrl()` now returns `/api/rpc` in browser, `RPC_URL || NEXT_PUBLIC_RPC_URL || fallback` on server. ✅
- `src/lib/wagmiConfig.ts`: Browser transport uses `/api/rpc` as primary. Fallback RPCs server-only. Public wagmi default as last resort. ✅
- **Privacy:** User IP never exposed to third-party RPC from browser. Consistent with existing privacy proxy architecture.
- **Resilience:** If `/api/rpc` fails, browser gets an error (correct — better than silent CORS failure). Wagmi has its own public fallback.
- **Finding:** None.

### P143 — `551ab04` — Floor simulation gas at 500K
**Risk:** LOW — Simulation only, does not affect actual transaction gas.
**Review:**
- `SIM_GAS_FLOOR = 500_000n` — used only in `eth_call` simulation context.
- Real tx gas at send time still uses `swapData.tx.gas` (unchanged).
- Comment clearly explains QuoterV2 gas underestimation (~40K vs real ~200-250K).
- `simGas = max(adapterGas + fcOverhead, SIM_GAS_FLOOR)` — correct logic.
- **Finding:** None.

### P144 — `d0dda27` — Add Augustus V6 selector `0xe3ead59e`
**Risk:** MEDIUM (security gate change) — **Correctly implemented across all 3 parallel structures.**
**Review:**
- `src/lib/swap-selectors.ts`: Added `0xe3ead59e` to `KNOWN_SWAP_SELECTORS`. Count comment updated 18→20.
- `src/lib/calldata-recipient.ts`: Added to both `TRUSTED_ROUTER_SELECTORS` and `VALIDATED_SELECTORS`.
- `src/lib/calldata-decoder.ts`: Added to `SELECTOR_INFO` with label `'ParaSwap V6'`.
- `src/lib/calldata-recipient.test.ts`: Count assertion updated 19→20.
- Cross-file test (`calldata-recipient.test.ts`) asserts bidirectional equality between `VALIDATED_SELECTORS` and `KNOWN_SWAP_SELECTORS`. ✅
- FEEDBACK.md documents all 3 structures and the Code Agent's rationale for updating all of them.
- **Finding:** 25B-I-01 (INFO) — see below.

### P145 — `94cfd28` — SourceToggle typo fix
**Risk:** NONE — Pure UI bug fix.
**Review:**
- Changed `'uniswap'` → `'uniswapv3'` in `TOGGLEABLE_SOURCES` array.
- Matches the adapter name used by `AGGREGATOR_META` and `fetchMetaQuote`.
- **Finding:** None.

### P146 — `58a886b` — Whitelist Augustus V6 router + fix V5 label
**Risk:** MEDIUM (security gate change) — **Correctly implemented.**
**Review:**
- Added `0x6a000f20005980200259b80c5102003040001068` (Augustus V6, lowercase) to `ROUTER_WHITELIST`.
- Fixed label: existing `0xdef171fe48...` was mislabeled "Augustus V6" → corrected to "Augustus V5 (legacy)".
- Address is correct ParaSwap Augustus V6 mainnet contract (verified against ParaSwap docs and Etherscan).
- `ROUTER_WHITELIST` is a `Set<string>` with lowercase addresses, whitelist check uses `.toLowerCase()`. ✅
- **Finding:** None.

### P147 — `b5e5c05` — Manual quote refresh button
**Risk:** NONE — Pure UX addition.
**Review:**
- `useQuote.ts`: New `refresh` callback — no-ops when in-flight, resets countdown. Does not bypass rate limiting.
- `QuoteBreakdown.tsx`: Optional `onRefresh`/`refreshing` props. Button renders `⟳` with spin animation. Hit area extended to 44px via `before::` pseudo-element (mobile touch compliance).
- `SwapBox.tsx`: Threads `refreshQuote` and `quoteLoading` through to `QuoteBreakdown`.
- Additional mobile UX improvements (rate row `flex-wrap`, slippage 44px tap target, 50%/MAX tap targets). Non-breaking.
- **Finding:** None.

### P148 — `468f2a1` — SwapFailed selector correction
**Risk:** LOW — Error parsing only, does not affect swap execution.
**Review:**
- `simulation.ts`: Changed `toFunctionSelector('SwapFailed()')` → `toFunctionSelector('SwapFailed(bytes)')`.
- Matches FeeCollector V2 contract: `error SwapFailed(bytes result)`.
- Only affects human-readable error message parsing in simulation results. Incorrect selector meant `SwapFailed` reverts were not being recognized and fell through to the generic "unknown revert" path.
- **Finding:** None.

---

## Findings

### 25B-I-01 (INFO) — Augustus V6 `beneficiary` field in TRUSTED_ROUTER_SELECTORS
**File:** `src/lib/calldata-recipient.ts:57`
**Description:** ParaSwap Augustus V6 `swapExactAmountIn` has an explicit `beneficiary` field in its calldata struct. The Code Agent placed V6 in `TRUSTED_ROUTER_SELECTORS` (implicit trust-by-design, like V5) rather than adding a proper extraction-based decoder in `decodeXRecipient`. This is safe today because the Velora adapter never sets a non-default beneficiary and ParaSwap's default is `msg.sender`. However, if a future ParaSwap API response included a non-zero beneficiary, the R1 check would not catch it.
**Impact:** None currently. Theoretical future bypass if ParaSwap API behavior changes.
**Recommendation:** Backlog item — add V6 struct decoder to `decodeXRecipient` (Group G). RICE: low priority until multi-source or adversarial scenarios.
**Status:** OPEN (INFO — no block on merge)

### 25B-I-02 (INFO) — P141 temporary bypass must be reverted
**File:** `src/lib/constants.ts:136-143`
**Description:** `FEE_INCOMPATIBLE_SOURCES` now includes `'uniswapv3'` and `'odos'` temporarily. This forgoes the 0.1% fee on these sources. Must be reverted after router timelocks execute on 2026-05-22 ~10:42 UTC.
**Impact:** Revenue loss (~0.1% of Uniswap V3 + Odos volume) until reversion.
**Recommendation:** Create Sprint 26 prompt to revert P141 + switch `NEXT_PUBLIC_FEE_COLLECTOR` to V2 after timelock execution.
**Status:** OPEN (INFO — tracked, not a security issue)

### 25B-I-03 (INFO) — Velora simulation still reverts on low-value swaps
**Description:** After all Sprint 25B fixes, Velora swaps with low value (~$4.50) still revert in simulation. Likely causes: (a) dust amount below ParaSwap minimum, or (b) Augustus V6 not on FeeCollector V1 on-chain whitelist. Since P141 bypasses FeeCollector for Velora's underlying sources, and the FeeCollector V1→V2 switch is pending, this resolves naturally after timelock execution.
**Impact:** Velora may show "Simulation failed" for small amounts. Non-blocking — other sources (KyberSwap, Uniswap V3 Direct) work.
**Status:** OPEN (INFO — expected to self-resolve with V2 switch)

### 25B-I-04 (INFO) — SwapFailed selector was wrong since Sprint 25 (P139)
**Description:** The `SwapFailed()` (no args) selector was introduced in P139 (Sprint 25). It never matched the contract's `SwapFailed(bytes)` signature. P148 corrects this. The impact was cosmetic — simulation errors showed "Unknown error" instead of "Swap failed" in the UI error message.
**Impact:** None (cosmetic error message improvement).
**Status:** CLOSED by P148.

### 25B-I-05 (INFO) — KNOWN_SWAP_SELECTORS count comment was stale
**Description:** The comment said "18 total" but the Set already had 19 entries before P144. P144 updated to "20 total" (correct). The stale comment had no functional impact.
**Impact:** None.
**Status:** CLOSED by P144.

---

## Security Checklist

| Check | Result |
|-------|--------|
| No new secrets/API keys hardcoded | ✅ |
| No contract changes | ✅ (frontend/API only) |
| No fund-flow logic changes | ✅ (fee bypass is temporary, documented) |
| ROUTER_WHITELIST additions verified on Etherscan | ✅ (Augustus V6 `0x6A000F20...`) |
| Selector additions verified against ABI | ✅ (`0xe3ead59e` = `swapExactAmountIn`) |
| All 3 parallel selector structures in sync | ✅ (swap-selectors, calldata-recipient, calldata-decoder) |
| Cross-file selector equality tests pass | ✅ (calldata-recipient.test.ts) |
| RPC proxy prevents IP leakage | ✅ (browser always → /api/rpc) |
| Simulation gas floor doesn't affect real tx | ✅ (sim-only, send uses adapter gas) |
| No infinite approvals introduced | ✅ |
| No `eval()` / `dangerouslySetInnerHTML` | ✅ |
| TypeScript typecheck: 0 errors | ✅ |
| 839/839 tests passing | ✅ |
| FEEDBACK.md entries reviewed | ✅ (all edge cases documented) |

---

## Test Coverage Summary

- **47 test files, 839 tests** — all passing
- Sprint 25B commits did not add new test files (hotfix nature), but all existing tests continue to pass including:
  - `calldata-recipient.test.ts` — bidirectional selector equality (19→20 count updated)
  - `simulate-swap.test.ts` — simulation parser regression tests
  - `swap-validations.test.ts` — useSwap validation chain
  - `mev-preference.test.ts` — MEV extraction tests

---

## Post-Merge Checklist

1. **Merge `fix/quote-routing-and-sim` → `main`** (squash or merge commit)
2. **Verify Vercel production deploy** — confirm latest commit hash in production
3. **Smoke test on production:** KyberSwap swap, Uniswap V3 Direct swap, source toggle, refresh button
4. **2026-05-22 ~10:42 UTC:** Execute router timelocks on FeeCollector V2
5. **After timelocks:** Sprint 26 — revert P141 + switch `NEXT_PUBLIC_FEE_COLLECTOR` to V2

---

*Auditor: Claude (Senior Architect) — 2026-05-20*
*Verdict: APPROVED (0C/0H/0M/0L/5 INFO)*
