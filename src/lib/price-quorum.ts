/**
 * [feat/swap-price-tiers] The shared ADR-024 USD price quorum — ONE module for the DCA floor tier
 * (order-engine/dca-floor-tier.ts, through the order-engine/dca-price-quorum.ts re-export shim) AND the
 * swap price tiers (GET /api/swap-price-tier). Extracted from order-engine/dca-price-quorum.ts
 * (feat/dca-tier-server-side, Auditor 29a item 7); the DCA semantics are unchanged and pinned by
 * price-quorum.test.ts:
 *
 *   quorumPriceUsd(address, slug)  DefiLlama + CoinGecko agreeing within QUORUM_TOLERANCE_BPS, both fresh
 *                                  -> the conservative (lower) price; otherwise null (single source,
 *                                  disagreement, none, errors) — exactly the keeper's single / skip.
 *
 * New here (D4, owner 2026-10-26) — the same quotes read as a TIER, with Chainlink as the keeper's first source:
 *
 *   classifyQuotes(quotes)   >= 2 distinct sources agreeing -> `priced` (usd = the lower agreeing price,
 *                            agreementBps = the widest spread inside the agreeing set; the first agreeing
 *                            pair in trust order chainlink > defillama > coingecko seeds the set — ADR-024
 *                            table rows 2/3); exactly 1 -> `single-source` (usd = that price); 0 or
 *                            disagreeing -> `unpriced`.
 *   classifyLegPrice(address, slug, { chainlink })  one leg over the injected Chainlink read (the route
 *                            passes fetchChainlinkPriceRaw; this module stays RPC-free) + the cached
 *                            off-chain pair. Never throws: any failure is `unpriced`.
 *
 * Same endpoints and semantics as the keeper's price-sources.js: DefiLlama `prices/current/slug:addr`
 * (price + timestamp), CoinGecko `simple/token_price/{platform}` with `include_last_updated_at` — ONE
 * contract address per request (the keyless tier rejects batches: HTTP 400, error_code 10012, measured
 * 2026-10-26); a quote older than MAX_PRICE_AGE_SEC, with no timestamp, or more than FUTURE_SKEW_SEC in
 * the future is ABSENT, for every source including Chainlink; 5 s per request. SERVER-SIDE ONLY (the
 * browser never calls a price source: it asks /api/swap-price-tier or /api/dca-floor-cap).
 *
 * The numeric constants are mirrored literals — the keeper is plain JS outside the Next bundle — pinned
 * to the keeper's by price-quorum.test.ts (value AND source text).
 */

import { normalizeAddress } from '@/lib/order-engine/normalize-address'
import { SWAP_PRICE_SOURCE_TRUST_ORDER, type SwapPriceLeg, type SwapPriceSource } from './swap-price-tier'

/** Keeper `QUORUM_TOLERANCE_BPS` (order-floor.js). Two prices agree when their spread is <= this. */
export const QUORUM_TOLERANCE_BPS = 300
/** Keeper `MAX_PRICE_AGE_SEC` (order-floor.js). An older quote is absent, not stale-but-counted. */
export const MAX_PRICE_AGE_SEC = 600
/** Keeper `FUTURE_SKEW_SEC` (price-sources.js). */
export const FUTURE_SKEW_SEC = 300
/** Keeper `SOURCE_TIMEOUT_MS` (price-sources.js). */
export const SOURCE_TIMEOUT_MS = 5_000
/** Short server cache of a token's two off-chain quotes (the keeper caches per cycle). */
export const QUOTE_CACHE_TTL_MS = 30_000

/** CoinGecko asset-platform per DefiLlama chain slug — keeper COINGECKO_PLATFORM / DEFILLAMA_CHAIN_SLUG. */
const COINGECKO_PLATFORM_BY_SLUG: Readonly<Record<string, string>> = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum-one' }

/** Fixed origin of each price source. Every outbound URL is built against one of these and re-checked. */
const DEFILLAMA_BASE = 'https://coins.llama.fi'
const COINGECKO_BASE = 'https://api.coingecko.com'

/**
 * `new URL(path, base)` with the origin asserted unchanged. `path` is built by the callers only from a
 * normalized address, a constant platform and constant segments (each through encodeURIComponent), so
 * this is the backstop: a throw here is "source absent" for the caller.
 */
function buildSourceUrl(path: string, base: string, query?: Record<string, string>): string {
  const url = new URL(path, base)
  if (url.origin !== new URL(base).origin) throw new Error('price-source URL origin mismatch')
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return url.toString()
}

export type PriceSource = SwapPriceSource
export interface SourceQuote { price: number; source: PriceSource }
/** Legacy name (the DCA callers). */
export type OffchainQuote = SourceQuote
export type LegPriceTier = SwapPriceLeg
/** What the route's Chainlink reader returns (fetchChainlinkPriceRaw's price + round timestamp). */
export interface ChainlinkRead { price: number; updatedAt: number }

/** Keeper `spreadBps`: (hi - lo) / lo * 10_000; infinite when either price is unusable. */
export function spreadBps(a: number, b: number): number {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (!(lo > 0) || !Number.isFinite(hi)) return Number.POSITIVE_INFINITY
  return ((hi - lo) / lo) * 10_000
}

/** Keeper `toQuote` freshness rule: finite positive price, a timestamp, age in [-FUTURE_SKEW_SEC, MAX_PRICE_AGE_SEC]. */
export function freshQuote(price: unknown, ts: unknown, source: PriceSource, nowSec: number): SourceQuote | null {
  const p = Number(price)
  const t = Number(ts)
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(t) || t <= 0) return null
  const age = nowSec - t
  if (age > MAX_PRICE_AGE_SEC || age < -FUTURE_SKEW_SEC) return null
  return { price: p, source }
}

const UNPRICED_LEG = (): LegPriceTier => ({ tier: 'unpriced', sources: [] })

/**
 * D4 over one leg's quotes. A source counts once (first quote wins); unusable prices are absent.
 * Sources are read in TRUST order (chainlink > defillama > coingecko), never arrival order, so the
 * first agreeing pair is the most-trusted one (ADR-024 "chain" row); every further source that agrees
 * with EVERY member joins the set (ADR-024 "all agree" row); an outlier is dropped (row 2).
 */
export function classifyQuotes(quotes: readonly (SourceQuote | null)[]): LegPriceTier {
  const bySource = new Map<PriceSource, SourceQuote>()
  for (const q of quotes) {
    if (!q || bySource.has(q.source)) continue
    if (!Number.isFinite(q.price) || q.price <= 0) continue
    bySource.set(q.source, q)
  }
  const valid = SWAP_PRICE_SOURCE_TRUST_ORDER.filter(s => bySource.has(s)).map(s => bySource.get(s) as SourceQuote)
  if (valid.length === 0) return UNPRICED_LEG()
  if (valid.length === 1) return { tier: 'single-source', sources: [valid[0].source], usd: valid[0].price }
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      if (spreadBps(valid[i].price, valid[j].price) > QUORUM_TOLERANCE_BPS) continue
      const set = [valid[i], valid[j]]
      for (let k = 0; k < valid.length; k++) {
        if (k === i || k === j) continue
        if (set.every(m => spreadBps(m.price, valid[k].price) <= QUORUM_TOLERANCE_BPS)) set.push(valid[k])
      }
      let widest = 0
      for (let a = 0; a < set.length; a++) {
        for (let b = a + 1; b < set.length; b++) widest = Math.max(widest, spreadBps(set[a].price, set[b].price))
      }
      return {
        tier: 'priced',
        sources: set.map(m => m.source),
        usd: Math.min(...set.map(m => m.price)),
        agreementBps: widest,
      }
    }
  }
  return { tier: 'unpriced', sources: valid.map(v => v.source) }
}

/**
 * Quorum over off-chain quotes (the DCA witness): >= 2 DISTINCT sources with a pair agreeing within the
 * tolerance -> the agreeing price (the lower one — conservative for the buy leg, and only used as a
 * "this token is priced" witness); otherwise null.
 */
export function offchainQuorumPrice(quotes: readonly (SourceQuote | null)[]): number | null {
  const c = classifyQuotes(quotes)
  return c.tier === 'priced' && c.usd !== undefined ? c.usd : null
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', ...headers } })
    if (!res || !res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function defiLlamaQuote(address: string, slug: string, nowSec: number): Promise<SourceQuote | null> {
  const addr = normalizeAddress(address)
  if (!addr) return null
  const key = `${slug}:${addr}`
  // The ':' separator stays literal (as before); both halves are encoded.
  const url = buildSourceUrl(`/prices/current/${encodeURIComponent(slug)}:${encodeURIComponent(addr)}`, DEFILLAMA_BASE)
  const json = (await getJson(url)) as { coins?: Record<string, { price?: unknown; timestamp?: unknown }> } | null
  const row = json?.coins?.[key]
  return freshQuote(row?.price, row?.timestamp, 'defillama', nowSec)
}

/** ONE contract address per request — the keyless tier rejects more (HTTP 400, error_code 10012). */
async function coinGeckoQuote(address: string, slug: string, nowSec: number): Promise<SourceQuote | null> {
  const platform = COINGECKO_PLATFORM_BY_SLUG[slug]
  if (!platform) return null
  const addr = normalizeAddress(address)
  if (!addr) return null
  const apiKey = process.env.COINGECKO_API_KEY // optional, server-only; keyless works at the public rate limit
  const url = buildSourceUrl(`/api/v3/simple/token_price/${encodeURIComponent(platform)}`, COINGECKO_BASE, {
    contract_addresses: addr,
    vs_currencies: 'usd',
    include_last_updated_at: 'true',
  })
  const json = (await getJson(
    url,
    apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
  )) as Record<string, { usd?: unknown; last_updated_at?: unknown }> | null
  if (!json || typeof json !== 'object') return null
  const row = Object.entries(json).find(([k]) => k.toLowerCase() === addr)?.[1]
  return freshQuote(row?.usd, row?.last_updated_at, 'coingecko', nowSec)
}

const cache = new Map<string, { quotes: (SourceQuote | null)[]; expiresAt: number }>()
const CACHE_MAX = 1000

/** Test seam: forget cached quotes. */
export function resetQuorumQuoteCache(): void {
  cache.clear()
}

/**
 * The two off-chain quotes (DefiLlama, CoinGecko) for `address` on `slug`, each already freshness-gated,
 * cached QUOTE_CACHE_TTL_MS per token. A junk address asks nothing ([]). May throw only on a hostile
 * slug (origin guard) — the public entry points below catch that.
 */
export async function fetchOffchainQuotes(address: string, slug: string): Promise<(SourceQuote | null)[]> {
  const addr = normalizeAddress(address)
  if (!addr) return []
  const key = `${slug}:${addr}`
  const now = Date.now()
  let hit = cache.get(key)
  if (!hit || now >= hit.expiresAt) {
    const nowSec = Math.floor(now / 1000)
    const quotes = await Promise.all([
      defiLlamaQuote(addr, slug, nowSec).catch(() => null),
      coinGeckoQuote(addr, slug, nowSec).catch(() => null),
    ])
    if (cache.size >= CACHE_MAX) cache.clear()
    hit = { quotes, expiresAt: now + QUOTE_CACHE_TTL_MS }
    cache.set(key, hit)
  }
  return hit.quotes
}

/**
 * USD price of `address` on `slug` IFF the keeper could reach quorum for it (DefiLlama + CoinGecko
 * agreeing within tolerance, both fresh); null otherwise (single source, disagreement, none, errors).
 * Never throws. (The DCA floor tier's witness — unchanged.)
 */
export async function quorumPriceUsd(address: string, slug: string): Promise<number | null> {
  try {
    return offchainQuorumPrice(await fetchOffchainQuotes(address, slug))
  } catch {
    return null
  }
}

/**
 * One swap leg's tier (D4): the injected Chainlink read (freshness-gated like every source) plus the
 * cached off-chain pair, classified. Never throws — any failure, junk address or hostile slug reads
 * as `unpriced` (the consent tier, D3), never as a stronger claim.
 */
export async function classifyLegPrice(
  address: string,
  slug: string,
  opts: { chainlink?: () => Promise<ChainlinkRead | null> } = {},
): Promise<LegPriceTier> {
  try {
    const addr = normalizeAddress(address)
    if (!addr) return UNPRICED_LEG()
    const nowSec = Math.floor(Date.now() / 1000)
    const [chainlink, offchain] = await Promise.all([
      opts.chainlink
        ? opts.chainlink().then(r => (r ? freshQuote(r.price, r.updatedAt, 'chainlink', nowSec) : null)).catch(() => null)
        : Promise.resolve<SourceQuote | null>(null),
      fetchOffchainQuotes(addr, slug).catch((): (SourceQuote | null)[] => []),
    ])
    return classifyQuotes([chainlink, ...offchain])
  } catch {
    return UNPRICED_LEG()
  }
}
