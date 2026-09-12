/**
 * [fix/zerox-quote-hygiene T2] Shared server-side meta-quote cache, extracted
 * from api/quote/route.ts's GET handler (feat/quote-before-wallet) so every
 * caller of fetchMetaQuote (GET /api/quote, POST /api/quote, GET
 * /api/v1/quote) collapses onto the SAME Upstash-backed cache + single-
 * flight dampener instead of each running its own independent fan-out.
 * GET /api/quote's behaviour (cache headers, TTLs) is byte-identical to
 * before this extraction — see route.ts for the wiring.
 *
 * Two layers, both keyed on the full request signature (chain + pair +
 * amount + decimals + excludes):
 *
 *   1. Upstash KV — shared across EVERY visitor/instance. TTL chosen just
 *      under QUOTE_REFRESH_MS (15s, src/lib/constants.ts) — the client's own
 *      poll cadence — so a cache hit is never staler than what an already-
 *      open tab would show anyway on its own next tick.
 *   2. A process-local dampener (in-flight coalescing + a short local
 *      cache), consulted only on a KV miss or KV error/timeout — see
 *      getOrFetchDampened's own doc for why this layer exists and its
 *      guarantees (none on its own; it only narrows an outage's blast
 *      radius). Deliberately SHARED across all three callers too: a GET
 *      request and a POST request for the identical pair, firing at the
 *      same instant during a KV outage, now coalesce into one upstream call
 *      instead of two.
 *
 * Fails open on any Redis error/timeout — a cache outage degrades to "no
 * caching", never to a broken quote.
 */
import { withTimeout } from './adapters/shared'
import { DEFAULT_CHAIN_ID } from './chains/registry'
import { kv } from './kv'
import type { MetaQuoteResult } from './adapters'

const KV_GATE_TIMEOUT_MS = 3_000
const QUOTE_CACHE_TTL_SECONDS = 12

export interface MetaQuoteCacheKeyInput {
  src: string
  dst: string
  amount: string
  srcDecimals: number
  dstDecimals: number
  excludeSources?: string[]
  chainId?: number
}

export function metaQuoteCacheKey({
  src, dst, amount, srcDecimals, dstDecimals, excludeSources, chainId,
}: MetaQuoteCacheKeyInput): string {
  const chain = chainId ?? DEFAULT_CHAIN_ID
  const exclude = excludeSources && excludeSources.length > 0 ? [...excludeSources].sort().join(',') : ''
  return `quote:cache:v1:${chain}:${src.toLowerCase()}:${dst.toLowerCase()}:${amount}:${srcDecimals}:${dstDecimals}:${exclude}`
}

async function getCachedMetaQuote(key: string): Promise<MetaQuoteResult | null> {
  try {
    return await withTimeout(kv.get<MetaQuoteResult>(key), KV_GATE_TIMEOUT_MS)
  } catch {
    return null
  }
}

async function setCachedMetaQuote(key: string, value: MetaQuoteResult): Promise<void> {
  try {
    await withTimeout(kv.set(key, value, { ex: QUOTE_CACHE_TTL_SECONDS }), KV_GATE_TIMEOUT_MS)
  } catch {
    // Best-effort — a cache-write failure must never fail the request.
  }
}

/**
 * [feat/quote-before-wallet — second-level dampener] COST DAMPENING, not a security cap and NOT a
 * rate limit. Both the KV rate limit (kv-rate-limiter.ts) and this KV quote cache share one
 * dependency (Upstash): a single Redis outage removes both brakes at once, and every visitor's
 * request now goes straight upstream. This is what's left standing when that happens —
 * process-local, in-memory, with NONE of Upstash's guarantees:
 *
 *   - Per-INSTANCE only. Fluid Compute reuses instances, so a warm instance dampens its own
 *     repeat traffic, but there is no coordination across instances the way KV coordinates across
 *     every visitor. N instances still means up to N upstream calls for the same query.
 *   - Resets on cold start / restart. No persistence, no guarantee of any kind.
 *   - It must never be read as "the rate limit" — QUOTE_RATE_LIMIT (kv-rate-limiter.ts, 30/60s per
 *     IP) is the only per-identity abuse control and is completely untouched by this. This dampens
 *     REDUNDANT upstream fan-out for the same query shape, from any IP, only while Upstash is down.
 *
 * Two mechanisms, in order — collapsing concurrent duplicates is worth more than any counter:
 *
 *   1. In-flight coalescing (the primary mechanism): N concurrent requests for the identical
 *      cache key that arrive while one is already fetching share that ONE upstream call instead of
 *      firing N.
 *   2. A short local result cache, for requests that are sequential rather than concurrent.
 *      DAMPENER_TTL_MS (5s) is deliberately LESS than QUOTE_CACHE_TTL_SECONDS (12s) so this can
 *      never be the reason a visitor sees a quote staler than the KV cache would have already
 *      allowed — it only narrows the window, never widens it.
 */
const DAMPENER_TTL_MS = 5_000
const MAX_DAMPENER_CACHE_ENTRIES = 50

const inFlightQuotes = new Map<string, Promise<MetaQuoteResult>>()
const localQuoteDampenerCache = new Map<string, { value: MetaQuoteResult; expiresAt: number }>()

function getLocalDampenerEntry(key: string): MetaQuoteResult | undefined {
  const local = localQuoteDampenerCache.get(key)
  if (!local) return undefined
  if (local.expiresAt > Date.now()) return local.value
  localQuoteDampenerCache.delete(key)
  return undefined
}

function setLocalDampenerEntry(key: string, value: MetaQuoteResult): void {
  localQuoteDampenerCache.delete(key) // re-insert at the end so it isn't evicted as "oldest"
  if (localQuoteDampenerCache.size >= MAX_DAMPENER_CACHE_ENTRIES) {
    const oldestKey = localQuoteDampenerCache.keys().next().value
    if (oldestKey !== undefined) localQuoteDampenerCache.delete(oldestKey)
  }
  localQuoteDampenerCache.set(key, { value, expiresAt: Date.now() + DAMPENER_TTL_MS })
}

async function getOrFetchDampened(
  key: string,
  fetcher: () => Promise<MetaQuoteResult>,
): Promise<{ result: MetaQuoteResult; source: 'local-cache' | 'coalesced' | 'fresh' }> {
  const local = getLocalDampenerEntry(key)
  if (local) {
    return { result: local, source: 'local-cache' }
  }

  const existing = inFlightQuotes.get(key)
  if (existing) {
    return { result: await existing, source: 'coalesced' }
  }

  // Synchronous check-then-set above, no `await` in between — this is the single-threaded JS
  // event loop, so no other call to this function can interleave and race the leader role here.
  const promise = fetcher()
  inFlightQuotes.set(key, promise)
  try {
    const result = await promise
    setLocalDampenerEntry(key, result)
    return { result, source: 'fresh' }
  } finally {
    inFlightQuotes.delete(key)
  }
}

/**
 * Resolve a meta-quote through the shared KV cache + dampener, falling back
 * to `fetcher()` (the live fetchMetaQuote call) on a miss. `cacheHeader`
 * mirrors GET /api/quote's existing X-Quote-Cache values exactly:
 * 'hit' | 'miss' | 'miss-dampened-local-cache' | 'miss-dampened-coalesced'.
 */
export async function getMetaQuoteCached(
  keyInput: MetaQuoteCacheKeyInput,
  fetcher: () => Promise<MetaQuoteResult>,
): Promise<{ result: MetaQuoteResult; cacheHeader: string }> {
  const cacheKey = metaQuoteCacheKey(keyInput)
  const cached = await getCachedMetaQuote(cacheKey)
  if (cached) {
    return { result: cached, cacheHeader: 'hit' }
  }

  const dampened = await getOrFetchDampened(cacheKey, fetcher)
  const cacheHeader = dampened.source === 'fresh' ? 'miss' : `miss-dampened-${dampened.source}`
  // Only the leader of a fresh fetch writes through to KV — a coalesced/local-cache hit
  // already holds a value that either came from (or was just written to) KV moments ago.
  if (dampened.source === 'fresh') await setCachedMetaQuote(cacheKey, dampened.result)
  return { result: dampened.result, cacheHeader }
}

// ── Test-only exports ───────────────────────────────────────
export const _internal = {
  MAX_DAMPENER_CACHE_ENTRIES,
  DAMPENER_TTL_MS,
  QUOTE_CACHE_TTL_SECONDS,
  localQuoteDampenerCache,
  inFlightQuotes,
}
