/**
 * [P188] In-memory meta-quote cache.
 *
 * Aggregator quotes are volatile, but within a 3s window the best
 * route changes rarely enough that re-running 11 upstream calls for
 * every keystroke is wasteful. This cache shields the outbound
 * rate-limiter (quoteLimiter/globalLimiter in rate-limiter.ts) from
 * debounce noise.
 *
 * Process-local — never use Redis/KV here. Function instances on
 * Fluid Compute are reused across concurrent requests, so a tiny
 * in-memory map is a real cache; cross-instance staleness is
 * acceptable because the TTL is short.
 */

import type { MetaQuoteResult } from './adapters'

const TTL_MS = 3_000
const MAX_ENTRIES = 200

interface Entry {
  value: MetaQuoteResult
  expiresAt: number
}

const cache = new Map<string, Entry>()

interface KeyInput {
  src: string
  dst: string
  amount: string
  srcDecimals: number
  dstDecimals: number
  excludeSources?: string[]
  /** [P217] Target chain — keeps Base quotes from colliding with mainnet. */
  chainId?: number
}

// [CHORE-API-HARDENING-2 / P3b] Significant figures kept when bucketing `amount`
// for the cache key. 4 sig figs buckets to ~0.05-0.1% resolution on typical raw
// amounts — a +1 wei increment (or any sub-bucket change) lands in the same
// bucket and hits the cache, while a genuinely different trade size (a
// different leading digit within the same magnitude, or a different magnitude)
// still misses and gets its own quote.
const AMOUNT_CACHE_SIG_FIGS = 4

/**
 * Bucket a raw (unsigned integer string) amount to `AMOUNT_CACHE_SIG_FIGS`
 * significant figures by zeroing the trailing digits (rounds DOWN to the
 * bucket floor). Defeats a "+1 wei per request" cache-bypass amplification: an
 * attacker scripting /api/quote with an incrementing amount now hits the same
 * cache entry instead of forcing an ~11-adapter fan-out on every request.
 *
 * Not a validator — a non-digit-string amount (already rejected elsewhere by
 * the route's own validation) passes through UNCHANGED so this function can
 * never be the reason a request fails; it only narrows the cache key for
 * well-formed amounts.
 */
export function quantizeAmount(amount: string, sigFigs: number = AMOUNT_CACHE_SIG_FIGS): string {
  if (!/^\d+$/.test(amount)) return amount
  if (amount.length <= sigFigs) return amount
  return amount.slice(0, sigFigs) + '0'.repeat(amount.length - sigFigs)
}

export function quoteCacheKey({
  src,
  dst,
  amount,
  srcDecimals,
  dstDecimals,
  excludeSources,
  chainId,
}: KeyInput): string {
  const exclude = excludeSources && excludeSources.length > 0
    ? [...excludeSources].map((s) => s.toLowerCase()).sort().join(',')
    : ''
  // [P217] Append the chain only for non-mainnet chains, so the chainId=1
  // (default) key is byte-identical to the pre-multi-chain key and existing
  // mainnet cache entries/hits are unaffected.
  const chainSuffix = chainId && chainId !== 1 ? `|${chainId}` : ''
  return `${src.toLowerCase()}|${dst.toLowerCase()}|${quantizeAmount(amount)}|${srcDecimals}|${dstDecimals}|${exclude}${chainSuffix}`
}

export function getQuote(key: string): MetaQuoteResult | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

export function setQuote(key: string, value: MetaQuoteResult): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS })
}

export function clearQuoteCache(): void {
  cache.clear()
}

export function quoteCacheSize(): number {
  return cache.size
}

export const QUOTE_CACHE_TTL_MS = TTL_MS
export const QUOTE_CACHE_MAX_ENTRIES = MAX_ENTRIES
