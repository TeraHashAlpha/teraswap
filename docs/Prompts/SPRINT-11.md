# Sprint 11 — Public API v1 + Auditor Pre-requisites

**Sprint window:** Post-Sprint 10 → TBD
**Sprint goal:** Fix 4 LOW findings from Sprint 10 audit (pre-requisites for public API exposure), then build a public-facing API that exposes TeraSwap's meta-aggregation as infrastructure for third-party integrations.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 10 APPROVED (0C/0H/0M).
**References:**
- Auditor Sprint 10 report: `Audits/Sprint/audit-sprint-10.md`
- ROADMAP.md Phase 2.1 (Public API) + Phase 2.3 (Positive Slippage analysis)

---

## Sprint status table

| # | Prompt | Description | Priority | Status |
|---|--------|------------|----------|--------|
| 75 | Fix toAmount BigInt render crash (10-L-01) | Validate toAmount before BigInt conversion across all consumers | P1 (pre-req) | Pending |
| 76 | Type-safe CoW orderParams (10-L-02) | Replace `any` with proper interface in cow.ts | P1 (pre-req) | Pending |
| 77 | Server-side amountInUsd computation (10-L-03) | Remove client-controlled USD amount, compute server-side via Chainlink | P1 (pre-req) | Pending |
| 78 | On-chain monitor alert resilience (10-L-04) | Prevent alert loss on double failure (KV write + alert dispatch) | P2 (pre-req) | Pending |
| 79 | Public API v1 — /api/v1/quote | Versioned quote endpoint with API key auth, rate limiting, OpenAPI docs | P1 (RICE 9.6) | Pending |
| 80 | Public API v1 — /api/v1/swap | Versioned swap-data endpoint returning unsigned transaction | P1 (RICE 9.6) | Pending |
| 81 | API key management + usage tracking | Supabase table for API keys, tiers, rate limits, usage counters | P1 (RICE 9.6) | Pending |
| 82 | Positive slippage analysis (design) | Research + ADR for surplus capture on non-CoW routes | P2 (RICE 11.2) | Pending |

---

## Prompt 75 — Fix toAmount BigInt render crash (10-L-01)

**Status:** Pending

**Context:** Auditor finding 10-L-01. Multiple components and hooks call `BigInt(quote.toAmount)` without validating that `toAmount` is a valid numeric string. With a public API, malformed quotes from third-party consumers become more likely. A non-numeric `toAmount` (e.g. `undefined`, `"NaN"`, `""`) would throw a `SyntaxError` at `BigInt()` and crash the component tree or API route.

**Objective:** Add a validation/sanitization layer for `toAmount` before any `BigInt()` conversion.

**Requirements:**

1. **Create a utility function `safeBigInt(value: unknown): bigint | null`** in `src/lib/utils.ts`:
   - Returns `BigInt(value)` if value is a valid integer string or number
   - Returns `null` for `undefined`, `null`, `""`, `"NaN"`, non-numeric strings
   - Never throws

2. **Replace all bare `BigInt(*.toAmount)` calls** with `safeBigInt()`:
   - `src/components/QuoteBreakdown.tsx` (lines 54, 65, 343)
   - `src/components/SplitRouteVisualizer.tsx` (line 70)
   - `src/hooks/useSwap.ts` (lines 297, 327)
   - `src/hooks/useSplitSwap.ts` (lines 203-204)
   - `src/lib/mev-savings.ts` (lines 44, 57)

3. **Handle the `null` case** gracefully:
   - In UI components: show "—" or skip the line instead of crashing
   - In hooks: skip fee validation / minimumOutput calc if amount invalid
   - In mev-savings: filter out quotes with invalid toAmount from median calc

4. **Add unit tests** for `safeBigInt` covering edge cases

**Do NOT**

- Change quote fetching logic or API adapters
- Modify how toAmount is set by aggregator responses
- Suppress errors silently — log a warning when safeBigInt returns null

**Files affected**

- `src/lib/utils.ts` (add `safeBigInt`)
- `src/components/QuoteBreakdown.tsx`
- `src/components/SplitRouteVisualizer.tsx`
- `src/hooks/useSwap.ts`
- `src/hooks/useSplitSwap.ts`
- `src/lib/mev-savings.ts`
- Test file for `safeBigInt`

**Expected output**

- 1 commit with utility + all callsite migrations + tests
- Zero `BigInt(*.toAmount)` bare calls remaining in codebase

**Quality criteria**

- `safeBigInt(undefined)` → `null` (no throw)
- `safeBigInt("12345678901234567890")` → `12345678901234567890n`
- `safeBigInt("not-a-number")` → `null` + console.warn
- All 427+ tests pass, build clean

---

## Prompt 76 — Type-safe CoW orderParams (10-L-02)

**Status:** Pending

**Context:** Auditor finding 10-L-02. In `src/lib/adapters/cow.ts` line 130, `orderParams` is typed as `any`. With a public API, type safety at adapter boundaries is critical to prevent runtime errors from malformed data propagating silently.

**Objective:** Replace `orderParams: any` with a proper TypeScript interface.

**Requirements:**

1. **Define `CowOrderParams` interface** in `src/lib/adapters/cow.ts` or a shared types file:
   - Based on CoW Protocol SDK types (check `@cowprotocol/cow-sdk` or API docs)
   - Must include at minimum: `sellToken`, `buyToken`, `sellAmount`, `buyAmount`, `validTo`, `appData`, `feeAmount`, `kind`, `partiallyFillable`, `receiver`
   - All fields properly typed (address as `0x${string}`, amounts as `string`, etc.)

2. **Apply the interface** to line 130 and all related functions that pass/receive orderParams

3. **Add runtime validation** at the boundary where orderParams is constructed:
   - Validate required fields are present
   - Validate address formats
   - Return typed error if validation fails (don't crash)

**Do NOT**

- Change CoW Protocol API calls or integration logic
- Install new dependencies (use existing CoW SDK types if available, otherwise define manually)
- Modify other adapters

**Files affected**

- `src/lib/adapters/cow.ts` (type definition + application)

**Expected output**

- 1 commit with type-safe CoW orderParams
- Zero `any` types remaining in cow.ts adapter public interface

**Quality criteria**

- `orderParams: any` replaced with `orderParams: CowOrderParams`
- TypeScript compiler catches malformed orderParams at build time
- All 427+ tests pass

---

## Prompt 77 — Server-side amountInUsd computation (10-L-03)

**Status:** Pending

**Context:** Auditor finding 10-L-03. In `src/app/api/log-swap/route.ts`, `amountInUsd` is sent by the client and trusted for large-trade monitoring thresholds. A malicious client could send `amountInUsd: 1` for a $50,000 swap to bypass monitoring alerts. With a public API, this becomes an exploitable vector.

**Objective:** Compute `amountInUsd` server-side using Chainlink price feeds instead of trusting client input.

**Requirements:**

1. **Server-side USD computation in `log-swap/route.ts`:**
   - Import the existing Chainlink price feed logic (already in `src/lib/chainlink.ts` or similar)
   - Look up the price of `tokenIn` using the Chainlink feed
   - Compute: `amountInUsd = amountIn * tokenPrice / 10^tokenDecimals`
   - Use the server-computed value for all monitoring/analytics
   - If Chainlink feed unavailable for the token, fall back to client value but flag it as `usdSourceClient: true`

2. **Deprecate client-sent `amountInUsd`:**
   - Still accept it in the request body (backward compat)
   - Ignore it for monitoring thresholds — use server-computed value
   - Log both values for comparison during transition period

3. **Apply same logic to `amountOutUsd`** if present

**Do NOT**

- Break existing log-swap callers (keep accepting the field)
- Add new Chainlink oracle calls — reuse existing feed lookup functions
- Block swaps if Chainlink lookup fails — this is analytics, not execution

**Files affected**

- `src/app/api/log-swap/route.ts` (server-side USD computation)
- Possibly `src/lib/chainlink.ts` (if price lookup needs to be extracted as reusable function)

**Expected output**

- 1 commit with server-side USD computation
- Client-sent amountInUsd no longer trusted for monitoring

**Quality criteria**

- Large-trade monitoring cannot be bypassed by client-controlled value
- Chainlink fallback works when feed unavailable
- All 427+ tests pass

---

## Prompt 78 — On-chain monitor alert resilience (10-L-04)

**Status:** Pending

**Context:** Auditor finding 10-L-04. In `on-chain-monitor.ts`, when a critical event is detected, the alert dispatch and KV persistence run via `Promise.allSettled()`. If the alert dispatch fails AND KV persistence fails in the same tick, the event is lost — it won't be retried because `lastScannedBlock` wasn't advanced (good), but if only the alert fails while KV succeeds, the block advances and the alert is never re-sent.

**Objective:** Ensure critical alerts are never silently lost, even on partial failure.

**Requirements:**

1. **Separate alert dispatch from block advancement:**
   - Only advance `lastScannedBlock` after BOTH alert dispatch AND KV persistence succeed
   - If alert dispatch fails but KV write succeeds, do NOT advance block — retry next tick
   - If KV write fails but alert succeeds, advance block (alert was delivered)

2. **Add alert retry queue:**
   - On alert failure, push the event to a KV-backed retry queue (`onchain:alert-retry`)
   - Next tick: check retry queue before scanning new blocks, re-attempt failed alerts
   - Max 3 retries per event, then log as permanently failed

3. **Add metric: `alerts_lost_total`** — increment when an alert permanently fails after 3 retries. Track in KV for monitoring dashboard.

**Do NOT**

- Change event detection or classification logic
- Modify the tick cadence
- Add external dependencies (use existing KV)

**Files affected**

- `src/lib/on-chain-monitor.ts` (alert resilience logic)
- Test file if exists

**Expected output**

- 1 commit with resilient alert dispatch
- Zero alert loss scenario on transient failures

**Quality criteria**

- Critical alert + KV both fail → block NOT advanced, retry next tick
- Alert fails + KV succeeds → block NOT advanced, retry next tick
- Alert succeeds + KV fails → block advanced (alert delivered)
- After 3 retries, event logged as permanently failed with metric

---

## Prompt 79 — Public API v1: /api/v1/quote

**Status:** Pending

**Context:** TeraSwap's meta-aggregation across 11 sources is valuable infrastructure. Currently the `/api/quote` endpoint is internal (used by the frontend). A public versioned API enables third-party integrations (bots, other dApps, Telegram bot in Sprint 14) and creates a B2B revenue stream.

**Objective:** Create a versioned, authenticated `/api/v1/quote` endpoint that returns the best quote and all source quotes.

**Requirements:**

1. **New route: `src/app/api/v1/quote/route.ts`:**
   - Accept GET with query params: `tokenIn`, `tokenOut`, `amount`, `slippage` (optional, default 0.5%), `chainId` (optional, default 1)
   - Require `X-API-Key` header for authentication
   - Rate limit per API key (not per IP) — use tier from API key record
   - Call existing `fetchMetaQuote()` internally
   - Return JSON response:
     ```json
     {
       "best": { "source": "1inch", "toAmount": "...", "estimatedGas": "..." },
       "quotes": [ ... all source quotes ... ],
       "meta": { "timestamp": "...", "sourcesQueried": 11, "sourcesResponded": 8, "mevProtected": false }
     }
     ```

2. **API key validation middleware:**
   - Look up `X-API-Key` in Supabase `api_keys` table
   - Check key is active, not expired, within rate limit
   - Return 401 for missing/invalid key, 429 for rate exceeded
   - Increment usage counter

3. **CORS headers:**
   - Allow all origins for API v1 (public API)
   - Include `Access-Control-Allow-Headers: X-API-Key`

4. **Error responses:**
   - 400: missing/invalid params
   - 401: missing/invalid API key
   - 429: rate limit exceeded (include `Retry-After` header)
   - 503: system halted (circuit breaker)

**Do NOT**

- Modify the existing `/api/quote` endpoint (frontend still uses it)
- Expose any internal endpoints or admin routes
- Include swap execution in this endpoint (that's P80)

**Files affected**

- `src/app/api/v1/quote/route.ts` (new)
- `src/lib/api-auth.ts` (new — API key validation middleware)

**Expected output**

- 1 commit with versioned quote endpoint + auth middleware
- Existing frontend unaffected

**Quality criteria**

- Valid API key → returns best quote + all quotes
- Invalid/missing key → 401
- Rate limit exceeded → 429 with Retry-After
- System halted → 503
- All existing tests pass + new tests for v1 endpoint

---

## Prompt 80 — Public API v1: /api/v1/swap

**Status:** Pending

**Context:** Companion to P79. After getting a quote, third-party consumers need transaction data to execute the swap. This endpoint returns unsigned transaction data (to, data, value, gas) that the consumer signs and submits themselves.

**Objective:** Create `/api/v1/swap` that returns unsigned transaction data for the best route.

**Requirements:**

1. **New route: `src/app/api/v1/swap/route.ts`:**
   - Accept POST with body: `tokenIn`, `tokenOut`, `amount`, `slippage`, `sender` (wallet address), `source` (optional — force specific source)
   - Require `X-API-Key` header
   - Call existing swap data fetching logic
   - Return:
     ```json
     {
       "tx": { "to": "0x...", "data": "0x...", "value": "0", "gasEstimate": "..." },
       "source": "1inch",
       "toAmount": "...",
       "minimumOutput": "...",
       "mevProtected": false
     }
     ```

2. **Route through FeeCollector:**
   - All swap data must route through FeeCollector V2 (same as frontend flow)
   - Include fee in response metadata

3. **Validation:**
   - Validate all addresses (tokenIn, tokenOut, sender)
   - Validate amount is positive integer string
   - Apply `safeBigInt` from P75

**Do NOT**

- Execute transactions on behalf of the user
- Expose private keys or signing functionality
- Skip FeeCollector routing (all API swaps must collect protocol fee)

**Files affected**

- `src/app/api/v1/swap/route.ts` (new)

**Expected output**

- 1 commit with swap data endpoint
- Consumer can take the response, sign the tx, and broadcast

**Quality criteria**

- Returns valid transaction data that can be signed and broadcast
- FeeCollector routing included
- Invalid params → 400 with descriptive error
- All existing tests pass + new tests

---

## Prompt 81 — API key management + usage tracking

**Status:** Pending

**Context:** P79 and P80 require API key authentication. Need a Supabase table for key management and an admin route for key creation.

**Objective:** Create API key infrastructure: storage, tiers, rate limiting, usage tracking.

**Requirements:**

1. **Supabase migration — `api_keys` table:**
   ```sql
   CREATE TABLE api_keys (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     key_hash TEXT UNIQUE NOT NULL,  -- SHA-256 hash of the API key (never store plaintext)
     name TEXT NOT NULL,              -- human-readable label
     tier TEXT NOT NULL DEFAULT 'free', -- 'free', 'pro', 'enterprise'
     rate_limit_per_min INT NOT NULL DEFAULT 10,
     rate_limit_per_day INT NOT NULL DEFAULT 100,
     is_active BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMPTZ DEFAULT NOW(),
     expires_at TIMESTAMPTZ,
     last_used_at TIMESTAMPTZ,
     total_requests BIGINT DEFAULT 0
   );
   ```

2. **API key generation admin route: `src/app/api/admin/api-keys/route.ts`:**
   - POST: generate new API key, return plaintext key (only shown once), store hash
   - GET: list all keys (without hashes) — for admin dashboard
   - DELETE: deactivate a key (soft delete — set `is_active = false`)
   - Protected by existing admin auth

3. **Rate limiting per API key:**
   - Use Upstash KV for sliding window rate limiting (existing pattern)
   - Key format: `api:${keyHash}:min` and `api:${keyHash}:day`
   - Return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers

4. **Tier definitions (in constants):**
   - Free: 10 req/min, 100 req/day
   - Pro: 60 req/min, 10,000 req/day
   - Enterprise: 300 req/min, 100,000 req/day

**Do NOT**

- Store plaintext API keys (always hash with SHA-256)
- Expose admin routes publicly (require admin auth)
- Use JWT or sessions — simple API key in header is sufficient for v1

**Files affected**

- `supabase/api-keys.sql` (new — migration)
- `src/app/api/admin/api-keys/route.ts` (new)
- `src/lib/api-auth.ts` (key validation + rate limiting)
- `src/lib/constants.ts` (tier definitions)

**Expected output**

- 1 commit with full API key infrastructure
- Supabase migration SQL provided

**Quality criteria**

- Keys stored as SHA-256 hashes only
- Rate limiting works per-key with correct tier limits
- Admin can create/list/deactivate keys
- Usage counter increments on each authenticated request

---

## Prompt 82 — Positive slippage analysis (design ADR)

**Status:** Pending

**Context:** Phase 2.3 in roadmap. When a swap executes better than the quoted minimum output, the surplus (positive slippage) currently goes entirely to the user. Many aggregators capture a portion of this surplus as additional revenue. This is separate from the 0.1% fee which is deducted upfront.

**Objective:** Research and produce an ADR (Architectural Decision Record) for surplus capture on non-CoW routes. No code changes — design only.

**Requirements:**

1. **Produce `docs/ADR/ADR-006-positive-slippage-sharing.md`:**
   - Analyse how surplus currently flows (post-execution-validator already measures it)
   - Compare industry approaches: 1inch (Fusion surplus), CoW (solver surplus), 0x (trade surplus)
   - Propose mechanism: what % to capture, where to capture (contract vs API), transparency requirements
   - Evaluate: FeeCollector V3 with surplus capture vs off-chain tracking
   - Risk analysis: user perception, competitive impact, regulatory considerations
   - Recommend: build vs wait, and if build, which sprint

2. **Include data analysis:**
   - Query existing `swap_logs` to estimate how much surplus has been generated historically
   - Calculate potential revenue at 30% and 50% capture rates
   - Identify which sources generate most surplus

**Do NOT**

- Write any application code
- Deploy any contract changes
- Make commitments — this is a design document for decision-making

**Files affected**

- `docs/ADR/ADR-006-positive-slippage-sharing.md` (new)

**Expected output**

- 1 commit with ADR
- Clear recommendation with data backing

**Quality criteria**

- ADR follows existing format (Proposed → Accepted lifecycle)
- Industry comparison is factually accurate
- Revenue estimates based on actual swap_logs data
- Risk analysis covers user trust and competitive positioning

---

## Pre-audit checklist

Before passing Sprint 11 to the Auditor:

- [ ] All 427+ tests passing
- [ ] `npm run build` succeeds
- [ ] `npx eslint src/` — 0 errors
- [ ] No new npm audit HIGH findings
- [ ] API key generation tested manually
- [ ] v1/quote returns valid response with test API key
- [ ] v1/swap returns valid unsigned transaction data
- [ ] Rate limiting works per-key (test free tier: 10 req/min)
- [ ] Supabase migration applied and tested

---

## Dependencies

```
P75 (safeBigInt) ──┐
P76 (CoW types)  ──┤
P77 (server USD) ──┼── P79 (v1/quote) ── P80 (v1/swap)
P78 (alert fix)  ──┘        │
                        P81 (API keys) ─── P79 + P80
                        P82 (ADR) — independent, can run anytime
```

P75–P78 (auditor pre-requisites) should be completed BEFORE P79–P81 (public API).
P82 (design ADR) is independent and can be done in parallel.

---

## RICE Summary

| Item | Reach | Impact | Confidence | Effort | Score |
|------|-------|--------|------------|--------|-------|
| P75-P78 Auditor pre-reqs (batch) | 10 | 2 | 90% | 1pw | 18.0 |
| P79-P81 Public API v1 (batch) | 8 | 3 | 80% | 2pw | 9.6 |
| P82 Positive slippage ADR | 8 | 2 | 70% | 0.5pw | 22.4 |
