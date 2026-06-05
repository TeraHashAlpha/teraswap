# Sprint 42 Audit — L2 Order Engine Security Cleanup (Pre-Phase 2)

**Date:** 2026-05-29
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `fix/sprint-42-order-engine-cleanup`
**Base:** Sprint 41 HEAD (`d76db1b`) — Sprint 41 not yet merged to `main`
**Commits reviewed:** `70a02f8` (P211), `ebb58fc` (P212), `97a327e` (P213), `f9c5966` (P214), `52ad59f` (P215), `0afa288` (P215 review)
**Files changed:** 9 (lib modules, hooks, tests, FEEDBACK.md)
**Diff:** +535/−20 lines
**Tests:** +15 (verified via diff grep: 5 price-monitor, 2 chainlink-historical, 5 useConditionalOrder, 3 useOrderEngine)
**Signatures:** All 6 commits SSH-signed (`ssh-ed25519`, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 42 Audit Verdict

**Branch:** fix/sprint-42-order-engine-cleanup
**Commits reviewed:** 70a02f8, ebb58fc, 97a327e, f9c5966, 52ad59f, 0afa288
**Tests:** 1204 → 1219 (+15)

### Verdict: APPROVED

0C / 0H / 0M / 0L / 1 INFO

---

## Detailed Review

### 1. P211 — Oracle Staleness for Conditional Orders (`70a02f8`) ✅

#### Shared validator (`src/lib/chainlink.ts` — `validateRoundData`) ✅

New exported function. Accepts `(roundId, answer, startedAt, updatedAt, answeredInRound, maxStalenessSec?)`. Returns `false` on any of:

- `answer <= 0n` → invalid/negative price. ✅
- `answeredInRound < roundId` → stale (answer carried from earlier round). ✅
- `startedAt <= 0n` → incomplete (round never started). ✅
- `age > maxStalenessSec` → data too old (only checked when `maxStalenessSec` provided). ✅

**Compared to swap path:** `fetchChainlinkPriceRaw` (lines 209–213) checks `answer <= 0n`, `answeredInRound < roundId`, and staleness. It does NOT check `startedAt <= 0n` (field destructured with `,`). The Code Agent correctly left the swap path unchanged per the Do-NOT, using `validateRoundData` only for the two order-engine paths. The FEEDBACK documents this as "divergent rigor" — the extra `startedAt` gate is strictly stricter and harmless (latestRoundData always returns `startedAt > 0` for completed rounds). ✅

#### price-monitor.ts — `getChainlinkPriceUSD` ✅

- **All 5 fields destructured:** `[roundId, answer, startedAt, updatedAt, answeredInRound]` from `readContract`. ✅
- **validateRoundData called:** Passes all 5 fields + `CHAINLINK_MAX_STALENESS_SEC`. On failure → warning logged with round details + returns `null`. ✅
- **CHAINLINK_MAX_STALENESS_SEC imported:** From `@/lib/constants` (already exported). ✅

#### chainlink.ts — `fetchHistoricalPrice` / `getRoundData` ✅

- **All 5 fields destructured:** `[rRoundId, answer, startedAt, updatedAt, answeredInRound]`. ✅
- **validateRoundData called:** Without `maxStalenessSec` (undefined) — staleness intentionally skipped for historical rounds (past by design). ✅
- **Invalid round handling:** `high = mid - 1n; continue` — shrinks binary search range, keeps looking. ✅

#### isTriggerMet integration ✅

- **Type updated:** `currentPrice: number | null` (was `number`). ✅
- **Null → false:** `if (currentPrice === null) { console.warn(...); return false }`. ✅
- **No crash:** Early return before any arithmetic comparison. ✅
- **Warning logged:** `[TeraSwap] Skipping trigger check — oracle unavailable`. ✅

#### Swap path ✅

- **`chainlink.ts` swap-path validation (lines 209–213) UNTOUCHED:** Verified via `git diff` — zero changes to `useSwap.ts`, `useSplitSwap.ts`, `SwapBox.tsx`, `swap/route.ts`, `swap-simulation.ts`. ✅

### 2. P212 — Conditional Order Poll Fix (`ebb58fc`) ✅

- **Ref read inside callback:** `ordersRef.current.filter(...)` is now called inside the `pollOrders()` function body, which executes on each `setInterval` tick. Previously it was captured once at effect setup. ✅
- **No stale closure:** The interval callback reads fresh from `ordersRef.current` every tick. ✅
- **Empty guard:** `if (submittedOrders.length === 0) return` inside `pollOrders()`. ✅
- **submittedCount gates effect:** `if (submittedCount === 0)` at the top of the effect to start/stop the interval. ✅
- **useLimitOrder unchanged:** Not in the diff. ✅
- **Polling interval unchanged:** `ORDER_POLL_INTERVAL_MS` not modified. ✅

### 3. P213 — Nonce Collision Prevention (`97a327e`) ✅

- **`localNonceRef`:** `useRef<bigint | null>(null)` tracking session's highest used nonce. ✅
- **`creatingRef`:** `useRef(false)` mutex preventing concurrent `createOrder`. ✅
- **`getNextNonce` logic:** `max(onChainNonce, localNonce + 1)`. First create returns `onChainNonce`; subsequent returns `localNonce + 1` (unless on-chain advanced further). `localNonceRef.current = next` updates the high-water mark. ✅
- **Used in createOrder:** `const nonce = getNextNonce()` replaces raw `currentNonce` read. ✅
- **Refetch after create:** `refetchNonce().catch(() => {})` after successful Supabase insert. ✅
- **Concurrent guard:** If `creatingRef.current === true`, throws `'Order creation in progress — please wait'`. Released in `finally` block. ✅
- **Reset on disconnect:** `useEffect(() => { localNonceRef.current = null }, [address])`. ✅
- **EIP-712 unchanged:** Domain, types, message structure untouched — only nonce value changes. ✅
- **No contract changes:** OrderExecutor nonce model untouched. ✅

### 4. P214 — Trigger Direction Validation (`f9c5966`) ✅

- **Pre-creation price:** Uses existing `currentPrice` from `getTokenPriceUSD` (Chainlink + CoW fallback). No additional oracle call. ✅
- **ABOVE validation:** `triggerDirection === 'above' && currentPrice >= triggerPrice` → throws descriptive error (`must be above the current price`). ✅
- **BELOW validation:** `triggerDirection === 'below' && currentPrice <= triggerPrice` → throws descriptive error (`must be below the current price`). ✅
- **Oracle unavailable:** `currentPrice <= 0` (getTokenPriceUSD returns 0 on total failure) → `console.warn` + proceed. Not blocked. ✅
- **DCA exception:** Only `stop_loss` and `take_profit` are validated. DCA lives in useOrderEngine, not useConditionalOrder — the guard naturally skips any non-trigger type. ✅
- **Error surfaces in UI:** `throw new Error(...)` propagates to catch block → `setLatestEvent({ type: 'order_error', ... })`. ✅
- **isTriggerMet unchanged:** Execution-time trigger logic NOT modified. ✅

### 5. P215 — Tests (`52ad59f` + `0afa288`) ✅

#### price-monitor.test.ts (5 tests — new file) ✅

1. **Stale round:** `updatedAt` beyond `CHAINLINK_MAX_STALENESS_SEC` → `null`. ✅
2. **Incomplete round:** `answeredInRound < roundId` (99n < 100n) → `null`. ✅
3. **Zero/negative answer:** `answer = 0n` and `answer = -1n` → both `null`. ✅
4. **Valid round:** Fresh, complete, answer 300B → `3000.00` price. ✅
5. **isTriggerMet null oracle:** `isTriggerMet(null, 2000, 'above')` and `'below'` → both `false`. ✅

#### chainlink.test.ts (+2 tests) ✅

1. **Historical incomplete round:** `answeredInRound < roundId` (49n < 50n) → skipped → `null` (no valid point found). ✅
2. **Historical zero answer:** `answer = 0n` → skipped → `null`. ✅

Mock strategy: fresh latestRoundData succeeds (so `fetchChainlinkPriceRaw` passes), every `getRoundData` returns invalid data, so binary search finds no usable point.

#### useConditionalOrder.test.ts (+5 tests) ✅

1. **ABOVE trigger rejection:** Current 2000, trigger 1900 (already above) → throws `/must be above/i`. ✅
2. **BELOW trigger rejection:** Current 1800, trigger 1900 (already below) → throws `/must be below/i`. ✅
3. **Valid trigger:** Current 2000, trigger 2100 ABOVE → order created, status `'monitoring'`. ✅
4. **DCA trigger skip:** DCA-typed order with invalid trigger values → accepted regardless. ✅
5. **P212 poll test (rescoped 0afa288):** Two submitted orders, advance timer, verify both UIDs polled. Honest scope note explains the stale-closure bug cannot be reproduced through public API. ✅

#### useOrderEngine.test.ts (+3 tests) ✅

1. **Incrementing nonces:** Two sequential creates → nonces 5n, 6n (on-chain is 5n; second uses local+1). ✅
2. **Concurrent rejection:** First create held at await sign, second throws `/in progress/i`. ✅
3. **Account switch reset:** Create with account A (nonce 5n), switch to account B (on-chain 2n), create → nonce 2n (local high-water mark reset). ✅

#### Review commit (`0afa288`) ✅

- **P212 test rescoped:** Original test was false-green (adding second order changed `submittedCount`, re-creating the interval regardless of fix). Rescoped to verify observable contract (poll covers all currently-submitted orders) with explicit scope note. The in-callback fresh read is verified by code inspection. ✅

### 6. FEEDBACK.md ✅

Five items, all valid and clearly documented:

1. **Branch stacking:** Sprint 42 based on Sprint 41 HEAD (same as Sprint 41 on Sprint 40). Needs sequential merge 40→41→42. ✅
2. **validateRoundData divergent rigor:** Extra `startedAt <= 0` check not in swap path. Swap path left unchanged per Do-NOT. ✅
3. **P213 mock update:** `useReadContract` mock now exposes `refetch`. Mandatory infra fix. ✅
4. **P214 DCA type:** DCA in useOrderEngine, not useConditionalOrder. Guard validates only SL/TP. ✅
5. **P215 review rescope:** P212 test rescoped from false-green to honest observable contract. ✅

### 7. General ✅

- **No scope creep:** 9 files — price-monitor, chainlink, useConditionalOrder, useOrderEngine (source + tests) + FEEDBACK.md. All order-engine code paths. ✅
- **No new dependencies.** ✅
- **Swap path untouched:** Zero changes to useSwap, useSplitSwap, SwapBox, swap routes, swap-simulation. Verified via diff. ✅
- **TypeScript/Lint/Tests:** Cannot run in sandbox. Code review: types correct (null union for isTriggerMet, refetch destructure, LegStatus typing), no lint violations. Delta: +15 `it()` blocks confirmed by diff grep. ✅
- **Commits signed:** All 6 commits carry `gpgsig` with `-----BEGIN SSH SIGNATURE-----` (`ssh-ed25519`). ✅

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 42-I-01 | INFO | `useConditionalOrder.test.ts` | P212 stale-closure regression test limited to observable contract — the exact FULL-M-05 scenario (submittedCount stays constant while submitted set changes) cannot be reproduced through the public hook API without an internal testing seam. Fix verified correct by code inspection; test covers the live-poll contract. |

---

## Comprehensive Audit Findings Closure

| Finding | Status | Verified |
|---------|--------|----------|
| FULL-H-04 (oracle no staleness — price-monitor) | CLOSED | ✅ `getChainlinkPriceUSD` uses `validateRoundData` with all 5 fields + staleness. `isTriggerMet` returns false on null. 5 tests. |
| FULL-M-03 (historical reads no completeness) | CLOSED | ✅ `fetchHistoricalPrice` uses `validateRoundData` (no staleness, completeness only). Invalid rounds skipped in binary search. 2 tests. |
| FULL-M-05 (poll stale snapshot) | CLOSED | ✅ `ordersRef.current.filter(...)` moved inside `pollOrders()` callback. Fresh read every tick. 1 test (observable contract). |
| FULL-M-06 (nonce collision) | CLOSED | ✅ `localNonceRef` tracks session high-water mark. `getNextNonce` returns `max(onChain, local+1)`. `creatingRef` mutex. Reset on disconnect. 3 tests. |
| FULL-M-07 (trigger no direction validation) | CLOSED | ✅ Pre-creation validation rejects ABOVE/BELOW triggers already satisfied. DCA exempt. Oracle unavailable → warn + proceed. 4 tests. |

---

## Full Audit Status (Comprehensive Audit 2026-05-28)

After Sprints 39–42:
- **Mainnet swap path:** 0C / 0H / 0M / 0L (Sprints 40+41)
- **Order engine path:** 0C / 0H / 0M (Sprint 42 closes all 5 deferred findings)
- **Encrypted storage:** 0C / 0H / 0M / 0L (Sprint 39)
- **Remaining:** INFO only (Sprint 40: 4I, Sprint 41: 1I, Sprint 42: 1I)
- **Deferred to L2:** NONE — all resolved

**All 27 findings from the comprehensive audit are CLOSED.** (4H + 9M + 8L + 6I original → 0 open across 4 sprints)

---

## FEEDBACK Deviations

| # | Item | Auditor Assessment |
|---|------|-------------------|
| 1 | Branch stacking (40→41→42 on unmerged branches) | **Accept.** No security impact. Merge in order: 40→41→42. |
| 2 | validateRoundData adds startedAt check not in swap path | **Accept.** Swap path left unchanged per Do-NOT. Order-engine paths are strictly stricter. Unifying the swap path is a future cleanup when the Do-NOT is lifted. |
| 3 | P213 useReadContract mock infra update | **Accept.** Mandatory — mock must match new refetch destructure. |
| 4 | P214 reuses getTokenPriceUSD instead of separate Chainlink call | **Accept.** Same price source with CoW fallback. Better availability than raw Chainlink alone. |
| 5 | P212 regression test rescoped to honest observable contract | **Accept.** The exact stale-closure bug is not reproducible via public API. Test covers the correctness contract. Code inspection confirms the fix. |

---

## Recommendation

**Merge** (after Sprints 40 and 41 merge to `main` in order). All 5 deferred L2 findings are closed. The order engine path is at 0C / 0H / 0M. Combined with Sprints 39–41, the entire comprehensive audit (27 findings) is fully resolved.

The project is ready for Phase 2 (Base L2) with a clean security posture across all code paths.
