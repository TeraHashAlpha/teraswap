# Sprint 37 Audit — Portfolio Discovery Fixes

**Role:** You are a Senior Security Auditor reviewing Sprint 37 of the TeraSwap DEX aggregator. Your job is to verify correctness, security, and test coverage of all changes.

**Branch:** `fix/sprint-37-portfolio-fallback`  
**Base:** `main`  
**Commits:** 3 (P193 `392ec6c`, P195 `9b68f2c`, P194 `7d4a2fd`)  
**Files changed:** 2 (`src/hooks/usePortfolio.ts`, `src/hooks/usePortfolio.test.ts`)  
**Test count:** 1146 → 1151 (5 new tests)

---

## Context

Sprint 37 fixes two issues in the Portfolio tab's Alchemy discovery path:

1. **P195 — Native ETH missing:** `alchemy_getTokenBalances` only returns ERC-20 tokens. The user's native ETH balance was invisible when the Alchemy path was active. Fix: standalone `useBalance()` gated on `useAlchemyPath`, prepends ETH to `heldEntries`.

2. **P193 — No fallback on persistent failure:** When `/api/portfolio/tokens` returned non-503 errors (e.g. 502 Bad Gateway), the hook set `isError=true` but kept `isAvailable=true`, never activating the multicall fallback. Users saw a permanent error. Fix: consecutive failure counter (`failCountRef`), falls back to multicall after `MAX_DISCOVERY_FAILURES` (2) consecutive non-503 failures.

3. **P194 — Tests:** 5 new tests covering ETH inclusion, 502/429/network-error fallback, and recovery.

---

## Audit Checklist

Review each item and classify findings as C (Critical), H (High), M (Medium), L (Low), or INFO.

### 1. P195 — Native ETH in Alchemy path

**Source file:** `src/hooks/usePortfolio.ts`

- [ ] **Double-counting check:** Verify that only ONE `useBalance()` call is active at any time. The new standalone call (gated on `useAlchemyPath && !!address`) and the existing one inside `useTokenBalances()` (gated on `!useAlchemyPath`) must be mutually exclusive.
- [ ] **ETH token lookup:** The code uses `DEFAULT_TOKENS.find(isNativeETH)`. Verify that `isNativeETH` is imported and works correctly with the sentinel address `0xEeee...`.
- [ ] **Prepend order:** ETH must appear first in `heldEntries` when on the Alchemy path. Check that `out.push()` for ETH happens before the `for (const d of discovery.tokens)` loop.
- [ ] **Zero balance guard:** ETH should only appear if `nativeEthBalance.value > 0n`. Check the guard condition.
- [ ] **Dependency array:** `nativeEthBalance` must be in the `useMemo` dependency array for `heldEntries`. Missing dependency = stale data.
- [ ] **refetchInterval:** The standalone `useBalance()` uses `refetchInterval: 30_000`, matching the existing pattern.

### 2. P193 — Consecutive failure fallback

**Source file:** `src/hooks/usePortfolio.ts`

- [ ] **failCountRef initialization:** `useRef(0)` — verify it starts at 0.
- [ ] **503 path unchanged:** 503 must still set `isAvailable(false)` immediately (not count toward the threshold). Verify `failCountRef.current = 0` on 503.
- [ ] **Non-ok path (e.g. 502):** Verify `failCountRef.current` increments, and when `>= MAX_DISCOVERY_FAILURES` sets `isAvailable(false)` + `isError(false)`.
- [ ] **Below threshold:** First failure should set `isError(true)` + `isAvailable(true)` — transient error, retry on next interval.
- [ ] **Success resets counter:** `failCountRef.current = 0` on successful response. Verify placement — must happen before state updates.
- [ ] **Catch block parity:** Network errors (catch block) must use the same counter logic as the non-ok branch. Verify both paths are identical in structure.
- [ ] **Recovery path:** After fallback engages, the interval still fires. On next successful response, `isAvailable` flips back to `true` re-enabling Alchemy. Verify this works.
- [ ] **MAX_DISCOVERY_FAILURES exported:** Verify the constant is exported and set to 2.
- [ ] **console.warn:** Verify the fallback logs a warning with the failure count for debugging.

### 3. P194 — Test coverage

**Test file:** `src/hooks/usePortfolio.test.ts`

- [ ] **ETH test:** Verify the test asserts ETH is first in the array, has the correct balance (2 ETH from mock), and totalValueUsd includes both ETH and USDC.
- [ ] **502 fallback test:** Verify the test triggers 2 consecutive failures (via `refresh()`), then asserts multicall tokens appear.
- [ ] **Recovery test:** Verify the test transitions from fallback back to Alchemy path when discovery succeeds.
- [ ] **Network error test:** Verify `TypeError('Failed to fetch')` is counted toward the threshold.
- [ ] **429 test:** Verify 429 is treated the same as 502 (counted toward threshold).
- [ ] **Existing test updates:** Check that the 3 modified existing tests (`wagmi mocks not consulted`, `discovered token addresses in price fetch`, `>100 tokens batched prices`) are correct after P195 changes. The key assertions should verify USDC balance matches discovery (not multicall) and UNK is present in price URLs.
- [ ] **No mock bleed:** Verify each test properly sets up and tears down its mocks. Check that `fetchMock.mockImplementation` is scoped per-test.

### 4. General

- [ ] **No scope creep:** Only `usePortfolio.ts` and `usePortfolio.test.ts` changed. No other files touched.
- [ ] **No new dependencies:** No new imports added beyond what was already in the file.
- [ ] **TypeScript:** `npm run typecheck` must pass.
- [ ] **Lint:** `npm run lint` must pass.
- [ ] **All tests:** `npm run test` must pass with 0 failures.

---

## Expected Output

```markdown
## Sprint 37 Audit Verdict

**Branch:** fix/sprint-37-portfolio-fallback
**Commits reviewed:** 392ec6c, 9b68f2c, 7d4a2fd
**Tests:** {before} → {after}

### Verdict: {APPROVED | APPROVED WITH WARNINGS | REJECTED}

{0C / 0H / 0M / 0L / NI INFO}

### Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 37-{severity}-{NN} | {C/H/M/L/INFO} | {file} | {description} |

### Recommendation

{Merge / Fix required / ...}
```

Run `npm run typecheck`, `npm run lint`, and `npm run test` before delivering the verdict. Report the actual test count.
