/**
 * [feat/dca-tier-server-side / Auditor 29a item 7] Is a token priced the way the KEEPER needs?
 *
 * The keeper's DCA floor is a PRICE QUORUM (ADR-024; contracts/order-engine/executor/price-sources.js +
 * order-floor.js `resolveFloorPrice`): >= 2 independent sources agreeing within QUORUM_TOLERANCE_BPS
 * gives the normal floor; exactly 1 source is "single" (tighter floor, $-capped, flagged); 0 or
 * disagreeing is "skip". Before this module the classifier called a token `offchain-price` on ONE
 * DefiLlama answer, which promised more than the keeper delivers. Now:
 *
 *   offchain-price  the keeper CAN reach quorum: DefiLlama AND CoinGecko both answer, both fresh, and
 *                   they agree within QUORUM_TOLERANCE_BPS.
 *   unpriced        exactly one answers, or they disagree, or none do — the keeper's single / skip.
 *
 * Same endpoints and semantics as the keeper's price-sources.js: DefiLlama `prices/current/slug:addr`
 * (price + timestamp), CoinGecko `simple/token_price/{platform}` with `include_last_updated_at`; a quote
 * older than MAX_PRICE_AGE_SEC, with no timestamp, or more than FUTURE_SKEW_SEC in the future is ABSENT;
 * 5 s per request. SERVER-SIDE ONLY (the browser never calls a price source; see pair-floor-info.ts).
 *
 * The two numeric constants are mirrored literals — the keeper is plain JS outside the Next bundle —
 * pinned to the keeper's by dca-price-quorum.test.ts (value AND source text). Chainlink is the keeper's
 * third source but it is not asked here: a Chainlink-priced leg is `onchain-feed` or the chain's WETH,
 * both settled before this module is consulted (dca-floor-tier.ts).
 */

/** Keeper `QUORUM_TOLERANCE_BPS` (order-floor.js). Two prices agree when their spread is <= this. */
export const QUORUM_TOLERANCE_BPS = 300
/** Keeper `MAX_PRICE_AGE_SEC` (order-floor.js). An older quote is absent, not stale-but-counted. */
export const MAX_PRICE_AGE_SEC = 600
/** Keeper `FUTURE_SKEW_SEC` (price-sources.js). */
export const FUTURE_SKEW_SEC = 300
/** Keeper `SOURCE_TIMEOUT_MS` (price-sources.js). */
export const SOURCE_TIMEOUT_MS = 5_000
/** Short server cache of a token's two quotes (the keeper caches per cycle). */
export const QUOTE_CACHE_TTL_MS = 30_000

/** CoinGecko asset-platform per DefiLlama chain slug — keeper COINGECKO_PLATFORM / DEFILLAMA_CHAIN_SLUG. */
const COINGECKO_PLATFORM_BY_SLUG: Readonly<Record<string, string>> = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum-one' }

export interface OffchainQuote { price: number; source: 'defillama' | 'coingecko' }

/** Keeper `spreadBps`: (hi - lo) / lo * 10_000; infinite when either price is unusable. */
export function spreadBps(a: number, b: number): number {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (!(lo > 0) || !Number.isFinite(hi)) return Number.POSITIVE_INFINITY
  return ((hi - lo) / lo) * 10_000
}

/** Keeper `toQuote` freshness rule: finite positive price, a timestamp, age in [-FUTURE_SKEW_SEC, MAX_PRICE_AGE_SEC]. */
function freshQuote(price: unknown, ts: unknown, source: OffchainQuote['source'], nowSec: number): OffchainQuote | null {
  const p = Number(price)
  const t = Number(ts)
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(t) || t <= 0) return null
  const age = nowSec - t
  if (age > MAX_PRICE_AGE_SEC || age < -FUTURE_SKEW_SEC) return null
  return { price: p, source }
}

/**
 * Quorum over off-chain quotes: >= 2 DISTINCT sources with a pair agreeing within the tolerance.
 * Returns the agreeing price (the lower one — conservative for the buy leg, and only used as a
 * "this token is priced" witness) or null.
 */
export function offchainQuorumPrice(quotes: readonly (OffchainQuote | null)[]): number | null {
  const seen = new Set<string>()
  const valid: OffchainQuote[] = []
  for (const q of quotes) {
    if (!q || seen.has(q.source)) continue
    seen.add(q.source)
    valid.push(q)
  }
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      if (spreadBps(valid[i].price, valid[j].price) <= QUORUM_TOLERANCE_BPS) return Math.min(valid[i].price, valid[j].price)
    }
  }
  return null
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

async function defiLlamaQuote(address: string, slug: string, nowSec: number): Promise<OffchainQuote | null> {
  const key = `${slug}:${address.toLowerCase()}`
  const json = (await getJson(`https://coins.llama.fi/prices/current/${key}`)) as { coins?: Record<string, { price?: unknown; timestamp?: unknown }> } | null
  const row = json?.coins?.[key]
  return freshQuote(row?.price, row?.timestamp, 'defillama', nowSec)
}

async function coinGeckoQuote(address: string, slug: string, nowSec: number): Promise<OffchainQuote | null> {
  const platform = COINGECKO_PLATFORM_BY_SLUG[slug]
  if (!platform) return null
  const addr = address.toLowerCase()
  const apiKey = process.env.COINGECKO_API_KEY // optional, server-only; keyless works at the public rate limit
  const json = (await getJson(
    `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${addr}&vs_currencies=usd&include_last_updated_at=true`,
    apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
  )) as Record<string, { usd?: unknown; last_updated_at?: unknown }> | null
  if (!json || typeof json !== 'object') return null
  const row = Object.entries(json).find(([k]) => k.toLowerCase() === addr)?.[1]
  return freshQuote(row?.usd, row?.last_updated_at, 'coingecko', nowSec)
}

const cache = new Map<string, { quotes: (OffchainQuote | null)[]; expiresAt: number }>()
const CACHE_MAX = 1000

/** Test seam: forget cached quotes. */
export function resetQuorumQuoteCache(): void {
  cache.clear()
}

/**
 * USD price of `address` on `slug` IFF the keeper could reach quorum for it (DefiLlama + CoinGecko
 * agreeing within tolerance, both fresh); null otherwise (single source, disagreement, none, errors).
 * Never throws.
 */
export async function quorumPriceUsd(address: string, slug: string): Promise<number | null> {
  try {
    const key = `${slug}:${address.toLowerCase()}`
    const now = Date.now()
    let hit = cache.get(key)
    if (!hit || now >= hit.expiresAt) {
      const nowSec = Math.floor(now / 1000)
      const quotes = await Promise.all([
        defiLlamaQuote(address, slug, nowSec).catch(() => null),
        coinGeckoQuote(address, slug, nowSec).catch(() => null),
      ])
      if (cache.size >= CACHE_MAX) cache.clear()
      hit = { quotes, expiresAt: now + QUOTE_CACHE_TTL_MS }
      cache.set(key, hit)
    }
    return offchainQuorumPrice(hit.quotes)
  } catch {
    return null
  }
}
