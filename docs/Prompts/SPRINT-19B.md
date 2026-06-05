# Sprint 19B — /api/swap Route Test Coverage

**Date:** 2026-05-18
**Architect:** Claude (Senior Architect)
**Closes:** 17-I-02 (swap route partially covered by unit tests)
**Branch:** `test/swap-route-coverage` (single branch, single PR)
**Estimated effort:** ~0.15 pw (1 prompt)

---

## Motivation

The `/api/swap` POST handler has 15 distinct validation branches. Only 2 are
covered by tests (P121's source allow-list guard + 1 happy path). The other 11
are bypassed by mocks that always return the success case. This is the biggest
test gap in the backend — the most security-critical endpoint has the least
coverage.

Sprint 17's auditor flagged this as 17-I-02 (INFO). This sprint closes it.

**Deploy strategy:** Single branch `test/swap-route-coverage`, one commit, one
PR. Test-only change — zero production code modified.

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 127 | Add 11 missing validation tests to /api/swap route | 10 | 2 | 0.95 | 0.15 | 126.7 | P0 |

---

## Prompt 127 — Complete /api/swap Route Test Coverage

**Context:** `src/app/api/swap/route.test.ts` exists with mocks for all dependencies but only exercises 2 of 15 branches. The following mocks are already declared:
- `mockIsSystemHalted` → `false`
- `mockCheckRateLimit` → `{ allowed: true, remaining: 99 }`
- `mockFetchSwapFromSource` → valid result with `tx.data` and `tx.to`
- `mockIsKnownSwapSelector` → `true`
- `mockValidateCallDataRecipient` → `{ valid: true, extracted: null, implicitRecipient: true }`
- `mockValidateSwapPrice` → `null`
- `mockFetchDefiLlamaPrice` → `null`

The existing `VALID_BASE` request body has: `{ source: '1inch', src: '0x...', dst: '0x...', amount: '1000000', from: '0x...', slippage: '0.5' }`.

**Objective:** Add test cases for all 11 untested validation branches, achieving full branch coverage of the POST handler.

**Requirements:**

Add these test cases to the existing test file. Use `mockResolvedValueOnce` / `mockReturnValueOnce` to override the default mock returns per-test.

### V1 — Circuit Breaker Halt (503)
```
test: system halted → 503 with halted:true and Retry-After header
setup: mockIsSystemHalted.mockResolvedValueOnce(true)
assert: status 503, body.halted === true, header Retry-After === '300'
assert: mockFetchSwapFromSource NOT called (early exit)
```

### V2 — Request Body Too Large (413)
```
test: Content-Length > 10000 → 413
setup: pass request with header Content-Length: '99999'
assert: status 413, body.error contains 'too large'
```

### V3 — Missing Required Fields (400)
```
test: missing source field → 400
setup: body without 'source' key
assert: status 400, body.error contains 'Missing required fields'
```

### V5 — Rate Limit Exceeded (429)
```
test: rate limit exceeded → 429 with rate limit headers
setup: mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60000 })
assert: status 429, body.error contains 'Rate limit'
assert: header X-RateLimit-Remaining === '0'
assert: mockFetchSwapFromSource NOT called
```

### V6 — Invalid Address Format (400)
```
test: malformed src address → 400
setup: body with src: 'not-an-address'
assert: status 400, body.error contains 'Invalid address'
```

### V7 — Slippage Out of Range (400)
```
test: slippage > 15 → 400
setup: body with slippage: '50'
assert: status 400, body.error contains 'Slippage must be between'

test: slippage NaN → 400
setup: body with slippage: 'abc'
assert: status 400, body.error contains 'Slippage must be between'
```

### V8 — Unknown Swap Selector (400)
```
test: unknown function selector → 400 with selector in response
setup: mockIsKnownSwapSelector.mockReturnValueOnce(false)
assert: status 400, body.error contains 'Unknown swap function selector'
assert: body.selector is a string starting with '0x'
```

### V9 — Calldata Recipient Mismatch (400)
```
test: recipient mismatch → 400
setup: mockValidateCallDataRecipient.mockReturnValueOnce({ valid: false, extracted: '0xattacker...', implicitRecipient: false })
assert: status 400, body.error contains 'recipient does not match'
```

### V11 — Price Guard: Oracle Deviation Blocked (422)
```
test: price deviation > 8% → 422 with priceGuard flag
setup: mockValidateSwapPrice.mockReturnValueOnce({ valid: false, reason: 'Price deviation exceeds threshold', deviation: -12.5, blocked: true })
assert: status 422, body.priceGuard === true, body.blocked === true
```

### V11b — Price Guard: High-Value + Oracle Unavailable (422)
```
test: high-value swap, oracle unavailable → 422
setup: mockFetchDefiLlamaPrice.mockResolvedValueOnce(50000) (makes estimatedValueUsd > 10000)
       mockValidateSwapPrice.mockReturnValueOnce({ valid: false, reason: 'Price validation unavailable for high-value swap', blocked: true })
assert: status 422, body.priceGuard === true
```

### V12 — Upstream Fetch Error (502)
```
test: fetchSwapFromSource throws → 502
setup: mockFetchSwapFromSource.mockRejectedValueOnce(new Error('1inch API timeout'))
assert: status 502, body.error contains '1inch API timeout'
```

### Happy Path Enhancement
```
test: successful swap with oracle data attached → 200 with oracle fields
setup: mockValidateSwapPrice.mockReturnValueOnce({ valid: true, deviation: -1.2, oraclePriceIn: 3500, oraclePriceOut: 1.0 })
assert: status 200, body.oracleDeviation exists, body.oraclePriceIn exists
```

**Total: 13 new test cases** (some validations get 2 sub-cases).

**Implementation notes:**
- Each test should be independent — use `mockResolvedValueOnce` / `mockReturnValueOnce` so the default mocks reset automatically.
- For V2 (Content-Length), you may need to construct the `NextRequest` with explicit headers.
- For V11b, the `estimatedValueUsd` computation happens inside the route — you need to mock `fetchDefiLlamaPrice` to return a real price AND set the amount high enough that `amount * price / 10^decimals > 10_000`.
- Group tests by validation category using `describe` blocks for readability.

**Do NOT:**
- Change ANY production code (only the test file)
- Remove or modify existing tests (V4 source allow-list tests stay)
- Change mock default values (only use `Once` overrides per-test)
- Add new dependencies

**Files affected:**
- `src/app/api/swap/route.test.ts` (13 new test cases)

**Quality criteria:**
- `npx vitest run src/app/api/swap/route.test.ts` → all tests pass (existing + 13 new)
- `npm test` → all pass (~641 total = 628 + 13)
- `npx tsc --noEmit` clean
- Zero changes to production code
- Every new test verifies both the status code AND the error message/body shape

---

## Execution order

Single prompt, single commit on `test/swap-route-coverage`.

## Post-sprint checklist

- [ ] All 15 validation branches have at least 1 test
- [ ] Total test count ~641 (628 + 13)
- [ ] No production code changed
- [ ] `describe` blocks group tests by validation category
