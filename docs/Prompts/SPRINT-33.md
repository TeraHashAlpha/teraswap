# Sprint 33 — Security-Critical Test Coverage + CodeQL Triage

> **Objective:** Bring the three security-critical utility modules (`validation.ts`, `simulation.ts`, `api-auth.ts`) from 0% to comprehensive unit-test coverage, and dismiss all 9 CodeQL false-positive findings with inline suppression comments so the workflow stays green.
>
> **Prerequisite:** Sprint 32 (Security Hardening) merged to main. Branch from latest `main`.
>
> **Audit references:** FULL-AUDIT-2026-05-26.md §"Security-Critical Test Coverage" (0% coverage on three fund-flow-adjacent modules). CodeQL findings from initial security-extended scan (9 alerts, all false positives after manual analysis).

---

## P175 — Unit tests for `src/lib/validation.ts`

### Context

`src/lib/validation.ts` exports 6 functions used across every API route and the swap flow: `isValidAddress`, `isValidTxHash`, `isValidAmount`, `cap`, `isAllowedOrigin`, `safeCompare`. All are pure (except `safeCompare` which imports `timingSafeEqual` from `node:crypto`). Zero test coverage today.

### Objective

Create `src/lib/validation.test.ts` with exhaustive unit tests for all 6 exported functions.

### Requirements

1. **`isValidAddress`** — test cases:
   - Valid: `'0x' + 40 hex chars` (lowercase, uppercase, mixed-case) → `true`
   - Invalid: empty string, `null`, `undefined`, number, `'0x'` alone, 39 chars, 41 chars, non-hex chars, missing `0x` prefix, `'0X'` uppercase prefix → `false`

2. **`isValidTxHash`** — test cases:
   - Valid: `'0x' + 64 hex chars` → `true`
   - Invalid: empty, `null`, 63 chars, 65 chars, non-hex, missing prefix → `false`

3. **`isValidAmount`** — test cases:
   - Valid: `'1'`, `'0.5'`, `'1000000'`, `'0.000001'` → `true`
   - Invalid: `'0'`, `'-1'`, `''`, `'abc'`, `null`, `undefined`, number type `42`, `'Infinity'`, `'NaN'`, `' 1 '` (whitespace — check actual behaviour and test accordingly) → `false`

4. **`cap`** — test cases:
   - String shorter than max → returns unchanged
   - String exactly at max → returns unchanged
   - String longer than max → truncated to `max` chars
   - Default max = 500 (pass a 501-char string)
   - Custom max (e.g. `cap('abcdef', 3)` → `'abc'`)
   - Non-string input (`null`, `undefined`, number, object) → returns `''`

5. **`isAllowedOrigin`** — test cases:
   - Allowed: `'https://teraswap.app'`, `'https://www.teraswap.app'`, `'http://localhost:3000'`, `'http://127.0.0.1:3000'` → `true`
   - Rejected: `null`, `''`, `'https://evil.com'`, `'https://teraswap.app.evil.com'`, `'http://localhost'` (no port) — check actual regex and test accordingly → `false`

6. **`safeCompare`** — test cases:
   - Equal strings → `true`
   - Different strings same length → `false`
   - Different lengths → `false`
   - Non-string inputs (`null`, `undefined`, number) → `false`
   - Empty strings (both empty) → `true`

### Do NOT

- Import or mock any external modules except `node:crypto` (which `safeCompare` uses internally — no need to mock it).
- Add tests for functions not exported from `validation.ts`.

### Files affected

- `src/lib/validation.test.ts` — NEW

### Expected output

- 1 commit: `test(validation): add unit tests for all validation utilities [P175]`
- All tests pass (`npm test -- validation.test`)
- Minimum 20 test cases across the 6 functions.

### Quality criteria

- Each function has at least 3 test cases (happy path + boundary + invalid input).
- No flaky tests (all pure/deterministic).
- Uses `describe` blocks per function for readability.

---

## P176 — Unit tests for `src/lib/simulation.ts`

### Context

`src/lib/simulation.ts` exports `parseSimulationError` (pure error parser matching FeeCollector custom error selectors + generic revert heuristics), `buildFeeCollectorSwapArgs` (pure helper), and the `FEE_COLLECTOR_ERROR_SELECTORS` constant. Zero test coverage today. These are on the critical swap path — a parser regression would either swallow real errors or block valid swaps.

### Objective

Create `src/lib/simulation.test.ts` with unit tests covering every branch of `parseSimulationError` and `buildFeeCollectorSwapArgs`.

### Requirements

1. **`parseSimulationError` — FeeCollector custom errors** (4 branches):
   - For each of `RouterNotWhitelisted`, `InsufficientOutput`, `SwapFailed`, `ZeroAmount`:
     - Test with the human-readable name in the error message (e.g. `new Error('RouterNotWhitelisted')`)
     - Test with the raw 4-byte selector from `FEE_COLLECTOR_ERROR_SELECTORS` embedded in a hex revert string (e.g. `new Error('execution reverted: 0x' + selector.slice(2) + '...')`)
     - Verify `success: false` and the correct `error` string matches the expected user-facing message.

2. **`parseSimulationError` — Generic reverts** (4 branches):
   - `'insufficient funds'` → success false, ETH balance message
   - `'STF'` and `'TRANSFER_FROM_FAILED'` → success false, token transfer message
   - `'Too little received'` and `'INSUFFICIENT_OUTPUT'` → success false, slippage message
   - `'execution reverted'` (generic, no specific match above) → success false, generic revert message

3. **`parseSimulationError` — Unrecognised error**:
   - Unknown error string (e.g. `new Error('something random')`) → `{ success: true }` (no `error` field)
   - Non-Error input (plain string) → handled correctly (function uses `String(error)` fallback)

4. **`parseSimulationError` — Priority / ordering**:
   - When a message matches both a FeeCollector selector AND a generic pattern (e.g. `'SwapFailed execution reverted'`), the FeeCollector-specific message takes priority (it's checked first). Add at least 1 test verifying this.

5. **`buildFeeCollectorSwapArgs`**:
   - `routeViaFeeCollector = true` → `{ from: feeCollectorAddress, recipient: userWallet }`
   - `routeViaFeeCollector = false` → `{ from: userWallet, recipient: undefined }`

6. **`FEE_COLLECTOR_ERROR_SELECTORS`**:
   - Verify all 4 keys exist and each value matches `0x` + 8 hex chars (4-byte selector format).

### Do NOT

- Mock `viem` or call `toFunctionSelector` in tests — import `FEE_COLLECTOR_ERROR_SELECTORS` directly from the module (they're pre-computed constants).
- Test any private/non-exported functions.

### Files affected

- `src/lib/simulation.test.ts` — NEW

### Expected output

- 1 commit: `test(simulation): add unit tests for error parser and swap args builder [P176]`
- All tests pass (`npm test -- simulation.test`)
- Minimum 18 test cases.

### Quality criteria

- Every `if` branch in `parseSimulationError` has at least one dedicated test.
- Both the name-match AND selector-match paths are tested for each FeeCollector error.
- `describe` blocks: one for `parseSimulationError`, one for `buildFeeCollectorSwapArgs`, one for `FEE_COLLECTOR_ERROR_SELECTORS`.

---

## P177 — Unit tests for `src/lib/api-auth.ts`

### Context

`src/lib/api-auth.ts` exports `hashApiKey` (SHA-256 hex digest) and `verifyApiKey` (full auth flow: header extraction → hash → Supabase lookup → active/expired/revoked checks → dual-window rate limiting → fire-and-forget usage bump). This is the authentication gate for all `/v1/*` public API routes. Zero test coverage today.

The function has external dependencies that must be mocked:
- `@/lib/supabase` → `getSupabase()` returns a Supabase client or `null`
- `@/lib/kv-rate-limiter` → `checkRateLimit()` returns `{ allowed, remaining, resetAt }`
- `node:crypto` → `createHash` (used by `hashApiKey`, can be tested directly)

### Objective

Create `src/lib/api-auth.test.ts` with unit tests covering `hashApiKey` and all branches of `verifyApiKey`.

### Requirements

1. **`hashApiKey`**:
   - Returns a 64-char lowercase hex string for any input.
   - Same input → same output (deterministic).
   - Different inputs → different outputs.

2. **`verifyApiKey` — missing/empty header**:
   - Request with no `X-API-Key` header → `{ ok: false, status: 401, error: 'Missing X-API-Key header.' }`

3. **`verifyApiKey` — Supabase unavailable** (`getSupabase()` returns `null`):
   - → `{ ok: false, status: 503 }`

4. **`verifyApiKey` — Supabase lookup error** (`.maybeSingle()` returns `{ data: null, error: { message: '...' } }`):
   - → `{ ok: false, status: 503 }`

5. **`verifyApiKey` — Supabase lookup throws** (simulate network error):
   - → `{ ok: false, status: 503 }`

6. **`verifyApiKey` — key not found** (lookup returns `null` data, no error):
   - → `{ ok: false, status: 401 }` with unified rejection message `'Invalid or inactive API key.'`

7. **`verifyApiKey` — key revoked** (`is_active: false`):
   - → `{ ok: false, status: 401 }` same unified message

8. **`verifyApiKey` — key expired** (`expires_at` in the past):
   - → `{ ok: false, status: 401 }` same unified message

9. **`verifyApiKey` — per-minute rate limit exceeded**:
   - Mock `checkRateLimit` to return `{ allowed: false, resetAt: Date.now() + 30000 }` on first call (minute window).
   - → `{ ok: false, status: 429 }` with `rateLimitHeaders` including `Retry-After`

10. **`verifyApiKey` — per-day rate limit exceeded**:
    - Mock `checkRateLimit` to return allowed on first call (minute), disallowed on second call (day).
    - → `{ ok: false, status: 429 }` with `rateLimitHeaders` including `Retry-After`

11. **`verifyApiKey` — success path**:
    - Valid key, active, not expired, both rate limits pass.
    - → `{ ok: true, keyId, keyName, tier, rateLimitHeaders }` with correct tier mapping (`'free'` default if unknown tier).
    - Verify `bumpUsage` was called (fire-and-forget Supabase update).

12. **`verifyApiKey` — tier mapping**:
    - `tier: 'pro'` → returns `'pro'`
    - `tier: 'enterprise'` → returns `'enterprise'`
    - `tier: 'unknown_value'` → defaults to `'free'`

### Mocking strategy

```typescript
// Mock getSupabase
jest.mock('@/lib/supabase', () => ({
  getSupabase: jest.fn(),
}))

// Mock checkRateLimit
jest.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: jest.fn(),
}))
```

Create a helper function `mockRequest(apiKey?: string)` that returns a minimal `NextRequest` with the appropriate header set.

Create a helper function `mockSupabaseClient(row: Partial<ApiKeyRow> | null, error?: object)` that returns a chainable `.from().select().eq().maybeSingle()` mock.

### Do NOT

- Test `bumpUsage` internals (it's a private function). Only verify it fires via the Supabase mock receiving an update call on the success path.
- Test `rateLimitHeadersFromResult` directly (private helper). Test it indirectly via the headers in rate-limit responses.
- Mock `node:crypto` — let `hashApiKey` use the real implementation.

### Files affected

- `src/lib/api-auth.test.ts` — NEW

### Expected output

- 1 commit: `test(api-auth): add unit tests for API key auth and rate limiting [P177]`
- All tests pass (`npm test -- api-auth.test`)
- Minimum 14 test cases covering all failure modes + success path.

### Quality criteria

- Every `if` branch in `verifyApiKey` (lines 160–292) has a dedicated test.
- Mocks are reset between tests (`beforeEach(() => jest.resetAllMocks())`).
- Unified rejection message `'Invalid or inactive API key.'` is verified for key-not-found, revoked, and expired (security requirement from 11-M-03).
- `describe` blocks: `hashApiKey`, `verifyApiKey` (with nested `describe` per failure mode).

---

## P178 — Dismiss CodeQL false positives with inline suppression comments

### Context

The CodeQL `security-extended` scan (`.github/workflows/codeql.yml`, added in Sprint 32) flagged 9 findings on the initial run. After manual analysis, ALL 9 are confirmed false positives:

1. **`js/disabling-certificate-validation`** (×2) — `rejectUnauthorized: false` in TLS config. This is intentional for TLS fingerprinting to match browser signatures (avoiding bot detection by DEX APIs). Without it, requests get 403'd.

2. **`js/insufficient-key-size`** (×1) — SHA-256 in `hashApiKey()`. API keys are 256-bit random strings — SHA-256 is industry standard for high-entropy API key hashing (Stripe, GitHub, AWS pattern). bcrypt/scrypt would add unnecessary latency.

3. **`js/log-injection`** (×3) — Template literals in `console.warn()` calls. These log server-side only (Vercel logs), the interpolated values are internal state (key hash prefixes, error messages), not user-controlled URLs. No injection risk.

4. **`js/incomplete-url-substring-sanitization`** (×1) — `.includes()` in a test assertion checking URL presence. This is test code, not URL sanitization.

5. **`js/missing-origin-check`** (×2) — Two scripts that no longer exist in the codebase (deleted in prior sprints). These findings will auto-resolve once CodeQL re-scans after the scripts are confirmed absent.

### Objective

Add CodeQL inline suppression comments to the still-present findings (items 1–4) so the workflow stays green. Items 5 will self-resolve.

### Requirements

1. For each finding in items 1–4 above, add a comment on the line ABOVE the flagged code:
   ```typescript
   // codeql[js/rule-id] Justification explaining why this is a false positive.
   ```

2. **TLS fingerprinting** (`rejectUnauthorized: false`):
   - Find the 2 locations where `rejectUnauthorized: false` is set.
   - Add: `// codeql[js/disabling-certificate-validation] Intentional: TLS fingerprinting to match browser signatures — required to avoid 403s from DEX APIs.`

3. **SHA-256 for API keys** (`hashApiKey` in `src/lib/api-auth.ts`):
   - Line with `createHash('sha256')`.
   - NOTE: There is already a comment block explaining this. Replace or augment with the CodeQL suppression format:
   - `// codeql[js/insufficient-key-size] SHA-256 is appropriate for high-entropy API key hashing (not passwords). Industry standard: Stripe, GitHub, AWS.`

4. **Template literal logging** (`console.warn` calls):
   - Find the 3 flagged `console.warn(...)` calls with template literals.
   - Add: `// codeql[js/log-injection] Server-side log only (Vercel). Interpolated values are internal state, not user input.`

5. **Test `.includes()`**:
   - Find the flagged `.includes()` in the test file.
   - Add: `// codeql[js/incomplete-url-substring-sanitization] Test assertion, not URL sanitization.`

6. Do NOT add suppressions for items 5 (missing scripts) — let them auto-resolve on next scan.

### Do NOT

- Add blanket `// codeql-disable` comments. Each suppression must be rule-specific.
- Remove or modify any functional code. Only add comments.
- Suppress findings that are NOT in the 9 analysed above.

### Files affected

- Files containing `rejectUnauthorized: false` (2 locations — grep to find)
- `src/lib/api-auth.ts` (line ~97, `createHash('sha256')`)
- Files containing the 3 flagged `console.warn` calls (grep to find)
- The test file containing the flagged `.includes()` assertion (grep to find)

### Expected output

- 1 commit: `ci(codeql): add inline suppression comments for 7 false-positive findings [P178]`
- CodeQL workflow passes on next PR scan with 0 new findings.
- All existing tests still pass (no functional changes).

### Quality criteria

- Each suppression comment is on the line immediately above the flagged code.
- Each comment includes a concise but specific justification (not just "false positive").
- No functional code changes — only comments added.
- Total: 7 suppression comments across ~5 files.

---

## Sprint 33 — Summary

| Prompt | Scope | New tests | Files |
|--------|-------|-----------|-------|
| P175 | `validation.ts` unit tests | ~20+ | 1 new |
| P176 | `simulation.ts` unit tests | ~18+ | 1 new |
| P177 | `api-auth.ts` unit tests | ~14+ | 1 new |
| P178 | CodeQL false positive dismissal | 0 | ~5 edits |

**Branch:** `test/sprint-33-security-coverage`

**Expected total tests after sprint:** ~1066+ (1014 current + ~52 new)

**Acceptance criteria:**
- All new tests pass.
- All existing tests pass (no regressions).
- CodeQL workflow produces 0 new findings.
- `npm test` exits 0.
- Each prompt = 1 atomic commit with hash referenced.
