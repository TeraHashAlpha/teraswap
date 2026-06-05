# Sprint 36 — Quote Rate Limit Relief

> **Objective:** Eliminate the "Rate limited" error that users see during normal quoting by raising outbound API throttles and adding a short-lived server-side quote cache. These changes are safe because the true bottleneck is the upstream aggregator APIs, not our own infrastructure — and with authenticated API keys on 1inch (100 req/min) and 0x (120 req/min) we have far more headroom than our self-imposed limits allow.
>
> **Prerequisite:** Sprint 35 (wagmi v3 prep) merged to main.
>
> **Branch:** `perf/sprint-36-quote-ratelimit-relief`

---

## P187 — Raise outbound rate limits

### Context

`src/lib/rate-limiter.ts` defines three in-memory limiters for **outbound** API calls (i.e. calls TeraSwap's server makes to upstream aggregator APIs):

```typescript
// line 67 — Per-aggregator: max 3 quote requests per 10 seconds
export const quoteLimiter = createRateLimiter({ maxRequests: 3, windowMs: 10_000 })

// line 70 — Global API: max 30 requests per minute
export const globalLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 })

// line 73 — Price feed: max 10 requests per 30 seconds
export const priceLimiter = createRateLimiter({ maxRequests: 10, windowMs: 30_000 })
```

The `globalLimiter` is the primary bottleneck. Each user quote triggers up to 11 parallel upstream calls (one per source). At 30 req/min global, the user can only get ~2.7 full multi-source quotes per minute before hitting the limit. Combined with the 15s auto-refresh, this means a user who types a few amounts manually will exhaust the global limit within seconds.

The `quoteLimiter` (per-adapter) at 3/10s is also conservative. With authenticated API keys on 1inch (100 req/min) and 0x (120 req/min), and the other sources being public with higher limits, we can safely raise this.

**NOTE:** These are NOT the incoming IP-based rate limits (`kv-rate-limiter.ts`). Those protect our Vercel endpoints from abuse and remain unchanged. These are self-imposed throttles on our own outbound calls.

### Objective

Raise the outbound rate limits to match the actual capacity of upstream APIs.

### Requirements

1. In `src/lib/rate-limiter.ts`, change line 67:
   - **From:** `maxRequests: 3, windowMs: 10_000`
   - **To:** `maxRequests: 6, windowMs: 10_000`
   - Rationale: 6/10s = 36/min per adapter. 1inch allows 100/min, 0x allows 120/min, public APIs (KyberSwap, OpenOcean, etc.) are typically 60+/min. 36/min is well within all limits.

2. In `src/lib/rate-limiter.ts`, change line 70:
   - **From:** `maxRequests: 30, windowMs: 60_000`
   - **To:** `maxRequests: 120, windowMs: 60_000`
   - Rationale: 120 global/min allows ~10 full multi-source quotes per minute (10 × 11 sources = 110 calls). This supports typing + auto-refresh without hitting the limit. The circuit breaker already protects against hammering failing sources.

3. Update the inline comments on lines 66 and 69 to reflect the new values.

4. Run `npm run typecheck && npm run build && npm test` — verify no regressions.

### Do NOT

- Change `priceLimiter` (10/30s is fine for DefiLlama price fetches).
- Change anything in `kv-rate-limiter.ts` (those are incoming IP-based limits).
- Change `QUOTE_RATE_LIMIT` or `SWAP_RATE_LIMIT` constants.
- Change any other file.

### Files affected

| File | Action |
|------|--------|
| `src/lib/rate-limiter.ts` | **EDIT** — lines 66–70 (two constant changes + comments) |

### Expected output

- 1 commit: `perf: raise outbound quote rate limits for better UX [P187]`

---

## P188 — Server-side quote response cache (3s TTL)

### Context

When a user types "1500" in the sell input, the debounce (500ms) fires intermediate values: "1", "15", "150", "1500". Each triggers a full multi-source quote (up to 11 upstream API calls). The intermediate quotes for "1", "15", "150" are useless — the user is still typing — but they burn 33 upstream calls.

Additionally, the 15s auto-refresh re-fetches the same pair+amount even if a fresh quote was just returned. If the user manually refreshes right after an auto-refresh, another 11 calls fire for the same inputs.

A short-lived server-side cache (3s TTL) won't help with the intermediate-typing issue directly (different amounts = different cache keys), but it WILL:
1. Prevent duplicate calls when multiple Vercel Lambda instances handle the same user's requests
2. Deduplicate manual refresh + auto-refresh collisions
3. Serve identical responses when two users quote the same pair+amount within 3s (common for popular pairs like ETH→USDC)

### Objective

Add an in-memory quote response cache in `fetchMetaQuote()` with a 3-second TTL.

### Requirements

1. Create a new file `src/lib/quote-cache.ts`:

```typescript
/**
 * Ultra-short-lived in-memory cache for meta-quote responses.
 *
 * Key:   `${src}:${dst}:${amount}` (lowercase, no decimals — raw wei string)
 * Value: { result: MetaQuoteResult, cachedAt: number }
 * TTL:   3 seconds (QUOTE_CACHE_TTL_MS)
 *
 * Why 3s? Quotes go stale quickly in DeFi (block time ~12s), but within
 * 3 seconds of a fresh fetch, the price hasn't moved meaningfully. This
 * window catches: auto-refresh/manual-refresh collisions, duplicate
 * requests from Lambda cold starts, and multiple users quoting popular
 * pairs simultaneously.
 *
 * Why in-memory (not Redis)? The cache is per-Lambda-instance, which is
 * fine — a miss just means a fresh upstream fetch. Redis would add latency
 * (one round-trip per quote) and KV quota burn for minimal benefit at this
 * TTL scale. In-memory also survives KV outages.
 *
 * Memory: Each cached MetaQuoteResult is ~2–5 KB (11 quotes × ~200B each
 * + metadata). At 100 active cache entries, that's 200–500 KB — negligible
 * for a Lambda instance with 1GB+ heap.
 */

import type { MetaQuoteResult } from './adapters'

export const QUOTE_CACHE_TTL_MS = 3_000
const MAX_CACHE_SIZE = 200

interface CacheEntry {
  result: MetaQuoteResult
  cachedAt: number
}

const cache = new Map<string, CacheEntry>()

export function buildCacheKey(src: string, dst: string, amount: string): string {
  return `${src.toLowerCase()}:${dst.toLowerCase()}:${amount}`
}

export function getCachedQuote(key: string): MetaQuoteResult | null {
  const entry = cache.get(key)
  if (!entry) return null

  if (Date.now() - entry.cachedAt > QUOTE_CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }

  return entry.result
}

export function setCachedQuote(key: string, result: MetaQuoteResult): void {
  // Evict expired entries if cache grows beyond max size
  if (cache.size >= MAX_CACHE_SIZE) {
    const now = Date.now()
    for (const [k, v] of cache) {
      if (now - v.cachedAt > QUOTE_CACHE_TTL_MS) {
        cache.delete(k)
      }
    }
    // If still too large after pruning, delete oldest entries
    if (cache.size >= MAX_CACHE_SIZE) {
      const keys = [...cache.keys()]
      for (let i = 0; i < keys.length - MAX_CACHE_SIZE + 1; i++) {
        cache.delete(keys[i])
      }
    }
  }

  cache.set(key, { result, cachedAt: Date.now() })
}

/** Clear the cache. Exported for tests only. */
export function clearQuoteCache(): void {
  cache.clear()
}
```

2. In `src/lib/api.ts`, integrate the cache into `fetchMetaQuote()`:

   At the top of the file, add import:
   ```typescript
   import { buildCacheKey, getCachedQuote, setCachedQuote } from './quote-cache'
   ```

   At the beginning of `fetchMetaQuote()` (after the global rate limit check on line 45), add cache lookup:
   ```typescript
   // ── Quote cache: serve fresh (<3s) responses without hitting upstream ──
   const cacheKey = buildCacheKey(src, dst, amount)
   const cached = getCachedQuote(cacheKey)
   if (cached) {
     return cached
   }
   ```

   After the `return` statement at the end of `fetchMetaQuote()` (before each `return` that returns a valid result — lines 180 and 191), cache the result:
   ```typescript
   setCachedQuote(cacheKey, result)
   ```
   Where `result` is the `MetaQuoteResult` being returned. There are two return paths (inside the outlier-detection block at ~line 180, and the fallback at ~line 191). Cache in both.

3. **Important**: The cache lookup must happen AFTER the global rate limiter check (`globalLimiter.allow()`). A cache hit still counts as a "request" for global rate limiting purposes — this prevents a scenario where the cache masks the rate at which the system is being called and then a burst of cache misses hits all upstream APIs simultaneously.

   **Wait — actually NO.** On second thought, the cache check should happen BEFORE the rate limiter. The whole point is to avoid burning rate limit tokens on cached responses. A cache hit means zero upstream calls, so it shouldn't consume rate limit budget. Move the cache lookup to BEFORE line 45:

   ```typescript
   export async function fetchMetaQuote(...): Promise<MetaQuoteResult> {
     // ── Quote cache: serve fresh (<3s) responses without hitting upstream ──
     const cacheKey = buildCacheKey(src, dst, amount)
     const cached = getCachedQuote(cacheKey)
     if (cached) {
       return cached
     }

     // Rate limit: max 120 global requests/min
     if (!globalLimiter.allow('meta_quote')) {
       throw new Error('Rate limited — too many requests. Please wait a moment.')
     }
     // ... rest of function
   ```

4. Run `npm run typecheck && npm run build && npm test` — verify no regressions.

### Do NOT

- Use Redis/KV for this cache (in-memory is correct at this TTL scale).
- Cache error responses or empty results.
- Change the `excludeSources` parameter handling — cache key does NOT include excluded sources. If sources are excluded, the quote should NOT be served from cache (different result set). Add `excludeSources` to the cache key if present:
  ```typescript
  const excludeSuffix = excludeSources?.length ? `:ex=${excludeSources.sort().join(',')}` : ''
  const cacheKey = buildCacheKey(src, dst, amount) + excludeSuffix
  ```
- Change `kv-rate-limiter.ts`.
- Change the frontend `useQuote` hook or any client-side code.

### Files affected

| File | Action |
|------|--------|
| `src/lib/quote-cache.ts` | **CREATE** — new module |
| `src/lib/api.ts` | **EDIT** — add import + cache check at top of `fetchMetaQuote()` + cache set before returns |

### Expected output

- 1 commit: `perf: add 3s server-side quote cache to reduce upstream API calls [P188]`

---

## P189 — Tests for rate limit changes and quote cache

### Context

P187 changed the outbound rate limiter constants and P188 added a new quote cache module. Both need test coverage.

### Objective

Add tests for the updated rate limiter values and the new quote cache.

### Requirements

1. Create `__tests__/lib/quote-cache.test.ts`:

   a. **Cache miss returns null** — `getCachedQuote` on a key that hasn't been set returns `null`.
   
   b. **Cache hit returns result** — `setCachedQuote` followed by `getCachedQuote` with the same key returns the cached result.
   
   c. **TTL expiry** — `setCachedQuote`, advance time by 3001ms (use `jest.useFakeTimers` + `jest.advanceTimersByTime`), `getCachedQuote` returns `null`.
   
   d. **TTL within window** — set, advance by 2999ms, get returns the cached result.
   
   e. **Cache key format** — `buildCacheKey('0xABC', '0xDEF', '1000')` returns `'0xabc:0xdef:1000'` (lowercase).
   
   f. **Different keys are independent** — set key A, get key B returns null.
   
   g. **clearQuoteCache empties all entries** — set multiple entries, call `clearQuoteCache`, all return null.
   
   h. **Max size eviction** — set 201 entries (exceeding MAX_CACHE_SIZE=200), verify the cache doesn't grow unbounded (oldest entries evicted). Verify a recently set entry is still retrievable.

2. Update `__tests__/lib/rate-limiter.test.ts` (if it exists) or create it:

   a. **quoteLimiter allows 6 requests in 10s** — call `quoteLimiter.allow('test')` 6 times, all return `true`. 7th returns `false`.
   
   b. **globalLimiter allows 120 requests in 60s** — call `globalLimiter.allow('test')` 120 times, all return `true`. 121st returns `false`.
   
   c. **Window reset** — exhaust the limiter, advance time past the window, verify requests are allowed again.
   
   d. **Per-key isolation** — exhaust limiter for key 'a', verify key 'b' still has full quota.
   
   e. **remaining() accuracy** — call `allow()` 3 times on quoteLimiter, verify `remaining()` returns 3 (6 - 3).
   
   f. **reset() clears all counters** — exhaust limiter, call `reset()`, verify requests are allowed.

3. Run `npm run typecheck && npm test` — verify all tests pass including the new ones.

### Do NOT

- Modify any existing test files.
- Mock `Date.now` globally — use `jest.useFakeTimers()` with `{ doNotFake: ['setImmediate'] }` if needed.
- Test the integration between cache and `fetchMetaQuote()` (that's covered by existing `/api/quote` tests).

### Files affected

| File | Action |
|------|--------|
| `__tests__/lib/quote-cache.test.ts` | **CREATE** — new test file |
| `__tests__/lib/rate-limiter.test.ts` | **CREATE** or **EDIT** — rate limiter tests |

### Expected output

- 1 commit: `test: add quote cache and rate limiter tests [P189]`

### Quality criteria

1. All new tests pass.
2. Quote cache tests cover: hit, miss, TTL expiry, TTL within window, key format, independence, clear, max size eviction.
3. Rate limiter tests verify the new constants (6/10s per-adapter, 120/60s global).
4. Tests run in < 3s (all in-memory, no async I/O).

---

## P190 — Index ADR-006 and ADR-007 in ARCHITECT-INDEX

### Context

The ARCHITECT-INDEX.md ADR table jumps from ADR-005 to ADR-008 (added in Sprint 35). ADR-006 and ADR-007 were created in earlier sprints but never indexed. Audit finding 35-I-03.

### Requirements

1. In `ARCHITECT-INDEX.md`, in the ADR table (section 1), add two rows BETWEEN the ADR-005 row and the ADR-008 row:

   ```
   | [ADR-006](docs/ADR/ADR-006-positive-slippage-sharing.md) | Positive Slippage Sharing | Proposed | Share positive slippage on non-CoW routes with users |
   | [ADR-007](docs/ADR/ADR-007-morpho-vault-curator.md) | Morpho Vault Curator | Proposed | TeraSwap as Morpho vault curator, Phase 4 |
   ```

2. Also make the ADR-008 row a proper link (it was added without a link in Sprint 35):
   - **From:** `| ADR-008 | Wagmi v3 Migration | Proposed | Defer until RainbowKit v3 compat |`
   - **To:** `| [ADR-008](docs/ADR/ADR-008-wagmi-v3-migration.md) | Wagmi v3 Migration | Proposed | Defer until RainbowKit v3 compat |`

3. Run `npm test` — verify all tests pass.

### Do NOT

- Modify any ADR files (Architect-owned).
- Change any other section of ARCHITECT-INDEX.md.

### Files affected

| File | Action |
|------|--------|
| `ARCHITECT-INDEX.md` | **EDIT** — ADR table rows |

### Expected output

- 1 commit: `docs: index ADR-006 and ADR-007, fix ADR-008 link [P190]`

---

## Sprint Summary

| Prompt | Scope | Risk | Files |
|--------|-------|------|-------|
| P187 | Raise outbound rate limits (3→6/10s, 30→120/60s) | Low | 1 |
| P188 | Server-side quote cache (3s TTL, in-memory) | Low | 1 new + 1 edit |
| P189 | Tests for cache + rate limiter | None | 1–2 new |
| P190 | Index ADR-006/007, fix ADR-008 link | None | 1 |

**Branch:** `perf/sprint-36-quote-ratelimit-relief`

**Expected total tests after sprint:** 1108 + ~14 new ≈ 1122 (using vitest count; see 35-I-02)

**What this sprint does:**
- Raises outbound global limit from 30/min → 120/min (supports ~10 full quotes/min vs ~2.7)
- Raises per-adapter limit from 3/10s → 6/10s (matches authenticated API key headroom)
- Adds server-side quote cache with 3s TTL to deduplicate rapid-fire identical requests
- Does NOT touch incoming IP rate limits (kv-rate-limiter.ts) — those remain at 30/min per IP

**What this sprint does NOT do:**
- Does NOT implement smart source selection (medium-term, Sprint 37-38)
- Does NOT change frontend debounce timing (500ms is appropriate)
- Does NOT add on-fork simulation (long-term roadmap)

**User-visible improvement:**
- Before: user sees "Rate limited" error after 2–3 quotes within a minute
- After: user can type amounts freely and manually refresh without hitting rate limits

**Acceptance criteria:**
- `quoteLimiter` = 6 req/10s, `globalLimiter` = 120 req/60s
- Quote cache serves identical pair+amount requests within 3s without upstream calls
- Cache respects `excludeSources` in the key
- All 1146+ tests pass, build clean, typecheck clean
