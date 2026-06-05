# Sprint 42 Audit — L2 Order Engine Security Cleanup (Pre-Phase 2)

**Role:** You are a Senior Security Auditor reviewing Sprint 42 of the TeraSwap DEX aggregator. Your job is to verify the correctness of the order-engine security fixes that close all deferred findings before Phase 2 (Base L2) deployment.

**Branch:** `fix/sprint-42-order-engine-cleanup`  
**Base:** `main` (with Sprints 40+41 merged)  
**Commits:** 6 (P211 `70a02f8`, P212 `ebb58fc`, P213 `97a327e`, P214 `f9c5966`, P215 `52ad59f`, P215 review `0afa288`)  
**Files changed:** lib modules (price-monitor, chainlink), hooks (useConditionalOrder, useOrderEngine), test files  
**Test count:** 1204 → 1219 (+15)

**Risk level:** MEDIUM — P211 changes oracle reads that gate real swap executions (order engine not yet live). P212-P214 are bug fixes in currently-inactive hooks. All changes are to L2-only code paths.

---

## Context

Sprint 42 closes the last 5 deferred findings from the comprehensive audit (2026-05-28). These were deferred because they only affect the order engine (DCA/Limit/SL·TP), which is L2-only. With Phase 2 (Base) approaching, they must be resolved.

| Prompt | Finding | Description |
|--------|---------|-------------|
| P211 | FULL-H-04 + FULL-M-03 | Oracle staleness: price-monitor.ts + chainlink.ts historical reads had no staleness/validity guards |
| P212 | FULL-M-05 | Stale poll snapshot: useConditionalOrder interval closed over stale order list |
| P213 | FULL-M-06 | Nonce collision: rapid order creation could produce same nonce |
| P214 | FULL-M-07 | Trigger validation: no check that trigger is on correct side of current price |
| P215 | Coverage | 15 tests + 1 review rescope |

After this sprint, the order engine should be at **0C / 0H / 0M** for all comprehensive audit findings.

---

## Audit Checklist

### 1. P211 — Oracle Staleness for Conditional Orders (`70a02f8`)

#### price-monitor.ts — `getChainlinkPriceUSD`

- [ ] **All 5 fields destructured:** `latestRoundData()` returns `[roundId, answer, startedAt, updatedAt, answeredInRound]` — all must be destructured.
- [ ] **answer <= 0 → null:** Zero or negative answer rejected.
- [ ] **answeredInRound < roundId → null:** Stale/incomplete round rejected.
- [ ] **startedAt <= 0 → null:** Incomplete round rejected.
- [ ] **updatedAt beyond CHAINLINK_MAX_STALENESS_SEC → null:** Expired data rejected.
- [ ] **Warning logged:** When returning null, a descriptive warning is logged with round details.
- [ ] **Same gates as swap path:** Compare the validation logic with `chainlink.ts:175-182` — must be equivalent.

#### chainlink.ts — `fetchHistoricalPrice` / `getRoundData`

- [ ] **All 5 fields destructured:** `getRoundData` also returns 5 fields.
- [ ] **answer <= 0 → skip:** Zero/negative answer rounds excluded.
- [ ] **answeredInRound < roundId → skip:** Incomplete rounds excluded.
- [ ] **startedAt <= 0 → skip:** Not-started rounds excluded.
- [ ] **No staleness check needed:** Historical rounds are inherently past — only completeness matters.

#### Shared validation (if implemented)

- [ ] **`validateRoundData` helper:** If extracted, verify it's used in all three paths (swap, price-monitor, historical). If not extracted, verify the logic is duplicated correctly.
- [ ] **CHAINLINK_MAX_STALENESS_SEC exported:** If it was previously not exported, verify the export doesn't break existing imports.

#### isTriggerMet integration

- [ ] **Null handling:** When `getChainlinkPriceUSD` returns `null`, `isTriggerMet` returns `false` (does NOT fire trigger).
- [ ] **No crash:** Null propagation doesn't throw — graceful fallback.
- [ ] **Warning logged:** "Skipping trigger check — oracle unavailable" or similar.

#### Swap path unchanged

- [ ] **`chainlink.ts:175-182` untouched:** The existing swap-path oracle validation is NOT modified. Verify via diff.

### 2. P212 — Conditional Order Poll Fix (`ebb58fc`)

- [ ] **Ref read moved inside callback:** `ordersRef.current.filter(...)` is called INSIDE the `setInterval` callback, not at effect setup.
- [ ] **No stale closure:** The interval does NOT close over a captured `submitted` array from outside the callback.
- [ ] **Empty guard:** If `ordersRef.current.filter(...)` returns empty array inside callback, the iteration is skipped (no unnecessary API calls).
- [ ] **submittedCount still gates effect:** The effect's dependency array still includes `submittedCount` to start/stop the interval.
- [ ] **useLimitOrder unchanged:** The already-correct `useLimitOrder.pollAll` pattern is NOT modified.
- [ ] **Polling interval unchanged:** The interval duration is the same as before.

### 3. P213 — Nonce Collision Prevention (`97a327e`)

- [ ] **localNonceRef exists:** `useRef<bigint | null>(null)` tracking session's highest used nonce.
- [ ] **getNextNonce logic:** Returns `max(onChainNonce, localNonce + 1)`. Correctly handles null (first create this session).
- [ ] **Used in createOrder:** The order's nonce field uses `getNextNonce()` instead of raw `currentNonce`.
- [ ] **Refetch after create:** After successful Supabase insert, `refetch()` is called on the nonces read contract.
- [ ] **Concurrent guard:** `creatingRef` mutex prevents simultaneous `createOrder` calls. Second call gets clear error message.
- [ ] **Reset on disconnect:** When `address` changes, `localNonceRef.current` resets to `null`.
- [ ] **EIP-712 unchanged:** The order signing flow (domain, types, message structure) is NOT modified — only the nonce value changes.
- [ ] **No contract changes:** OrderExecutor nonce model untouched.

### 4. P214 — Trigger Direction Validation (`f9c5966`)

- [ ] **Pre-creation price fetch:** Current price fetched before signing, using the staleness-guarded oracle from P211.
- [ ] **ABOVE validation:** `triggerDirection === 'ABOVE' && currentPrice >= triggerPrice` → rejected with user-friendly error.
- [ ] **BELOW validation:** `triggerDirection === 'BELOW' && currentPrice <= triggerPrice` → rejected with user-friendly error.
- [ ] **Oracle unavailable:** If current price is `null`, a warning is logged but the order proceeds (not blocked).
- [ ] **DCA exception:** DCA orders skip trigger validation entirely.
- [ ] **Error surfaces in UI:** Rejection error propagates to the user via existing error state.
- [ ] **isTriggerMet unchanged:** The execution-time trigger check is NOT modified.

### 5. P215 — Tests (`52ad59f` + `0afa288`)

#### price-monitor.test.ts (5 tests)

- [ ] **Stale round test:** `updatedAt` beyond threshold → null.
- [ ] **Incomplete round test:** `answeredInRound < roundId` → null.
- [ ] **Zero/negative answer test:** `answer = 0n` and `answer < 0` → null.
- [ ] **Valid round test:** All checks pass → correct price.
- [ ] **isTriggerMet null oracle test:** Oracle returns null → `isTriggerMet` returns false.

#### chainlink.test.ts (2 tests added)

- [ ] **Historical incomplete round:** `answeredInRound < roundId` → skipped.
- [ ] **Historical zero answer:** `answer = 0n` → skipped.

#### useConditionalOrder.test.ts (4 tests)

- [ ] **Fresh ref on each tick:** New submitted order picked up without count change.
- [ ] **ABOVE trigger rejection:** Current price above trigger → rejected.
- [ ] **BELOW trigger rejection:** Current price below trigger → rejected.
- [ ] **DCA trigger skip:** DCA order accepted regardless.

#### useOrderEngine.test.ts (3 tests added)

- [ ] **Incrementing nonces:** Two sequential creates → different nonces.
- [ ] **Concurrent rejection:** Simultaneous creates → second rejected.
- [ ] **Account switch reset:** Nonce cache clears on address change.

#### Review commit (`0afa288`)

- [ ] **P212 test rescoped:** The review found the P212 poll test was false-green. Verify the rescoped test actually exercises the stale-closure fix (not just passing trivially).

### 6. FEEDBACK.md

- [ ] **Branch stacking noted:** Code Agent documented that Sprints 40/41/42 are stacked on unmerged branches. Verify this was resolved via sequential merge before audit.
- [ ] **P212 regression guard:** Deferred true regression test. Verify the current test provides meaningful coverage even if not a full regression test.

### 7. General

- [ ] **No scope creep:** Changes limited to order-engine code paths (price-monitor, chainlink historical, useConditionalOrder, useOrderEngine).
- [ ] **No new dependencies:** No npm packages added.
- [ ] **Swap path untouched:** The mainnet swap flow (useSwap, useSplitSwap, SwapBox, swap API routes) is NOT modified.
- [ ] **TypeScript:** `npm run typecheck` must pass.
- [ ] **Lint:** `npm run lint` must pass.
- [ ] **All tests:** `npm run test` must pass with 0 failures. Report actual test count.
- [ ] **Commits signed:** All 6 commits must be SSH/GPG signed.

---

## Expected Output

```markdown
## Sprint 42 Audit Verdict

**Branch:** fix/sprint-42-order-engine-cleanup
**Commits reviewed:** 70a02f8, ebb58fc, 97a327e, f9c5966, 52ad59f, 0afa288
**Tests:** 1204 → {actual count}

### Verdict: {APPROVED | APPROVED WITH WARNINGS | REJECTED}

{0C / 0H / 0M / 0L / NI INFO}

### Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 42-{severity}-{NN} | {C/H/M/L/INFO} | {file} | {description} |

### Comprehensive Audit Findings Closure

| Finding | Status | Verified |
|---------|--------|----------|
| FULL-H-04 (oracle no staleness — price-monitor) | {CLOSED/OPEN} | {yes/no} |
| FULL-M-03 (historical reads no completeness) | {CLOSED/OPEN} | {yes/no} |
| FULL-M-05 (poll stale snapshot) | {CLOSED/OPEN} | {yes/no} |
| FULL-M-06 (nonce collision) | {CLOSED/OPEN} | {yes/no} |
| FULL-M-07 (trigger no direction validation) | {CLOSED/OPEN} | {yes/no} |

### Full Audit Status (Comprehensive Audit 2026-05-28)

After Sprints 39-42:
- Mainnet swap path: 0C / 0H / 0M / 0L
- Order engine path: 0C / 0H / 0M (all deferred findings closed)
- Remaining: INFO only + accepted/backlog LOWs
- Deferred to L2: NONE (all resolved)

### FEEDBACK Deviations

| # | Item | Auditor Assessment |
|---|------|-------------------|
| 1 | Branch stacking (40→41→42) | {Accept / Flag / Fix required} |
| 2 | P212 regression guard deferred | {Accept / Flag / Fix required} |

### Recommendation

{Merge / Fix required / ...}
```

Run `npm run typecheck`, `npm run lint`, and `npm run test` before delivering the verdict. Report the actual test count.
