/**
 * [feat/swap-price-tiers] Swap price tiers — the pure, import-free vocabulary shared by the server
 * (GET /api/swap-price-tier, POST /api/swap) and the browser (useSwapPriceTier, SwapBox, QuoteBreakdown).
 *
 * Owner decisions 2026-10-26:
 *   D1 the SERVER is the authority on a pair's tier; the client never applies a stricter rule.
 *   D2 >= 1 leg priced -> WARN, never block; the value thresholds apply from the priced value.
 *   D3 neither leg priced -> allowed after informed CONSENT (no USD caps; what still protects: quote
 *      agreement, the on-chain minimum output, SC-04 / R1).
 *   D4 ADR-024 quorum per leg: Chainlink -> DefiLlama -> CoinGecko; >= 2 within 300 bps = `priced`,
 *      exactly 1 = `single-source`, 0 or disagreeing = `unpriced`.
 *
 * The PAIR takes the BEST leg: one priced leg sizes the whole trade (max(in, out) — the rule the
 * server's /api/swap value gate already applies), so priced/unpriced is `priced`. No fetch, no host
 * name, no framework import here — this module is safe for the client bundle.
 */

export type SwapPriceTier = 'priced' | 'single-source' | 'unpriced'
export type SwapPriceSource = 'chainlink' | 'defillama' | 'coingecko'

/** ADR-024 trust order (tie-break only). */
export const SWAP_PRICE_SOURCE_TRUST_ORDER: readonly SwapPriceSource[] = ['chainlink', 'defillama', 'coingecko']

export const SWAP_PRICE_SOURCE_LABEL: Readonly<Record<SwapPriceSource, string>> = {
  chainlink: 'Chainlink',
  defillama: 'DefiLlama',
  coingecko: 'CoinGecko',
}

export interface SwapPriceLeg {
  tier: SwapPriceTier
  /** The sources that answered fresh, in trust order: the agreeing set (priced), the one (single-source),
   *  the disagreeing ones or none (unpriced). */
  sources: SwapPriceSource[]
  /** The leg's USD reference price: the conservative (lower) agreeing price, or the single source's.
   *  Absent when unpriced. */
  usd?: number
  /** priced only: the widest spread inside the agreeing set, in bps. */
  agreementBps?: number
}

export interface SwapPriceTierResponse {
  tier: SwapPriceTier
  legs: { in: SwapPriceLeg; out: SwapPriceLeg }
  /** priced only: the worse (widest) agreementBps among the priced legs. */
  agreementBps?: number
}

const TIER_RANK: Readonly<Record<SwapPriceTier, number>> = { priced: 2, 'single-source': 1, unpriced: 0 }
const TIERS = new Set<string>(Object.keys(TIER_RANK))
const SOURCES = new Set<string>(SWAP_PRICE_SOURCE_TRUST_ORDER)

/** The fail-closed-to-consent server answer: nothing known about either leg. */
export const UNPRICED_PAIR: SwapPriceTierResponse = {
  tier: 'unpriced',
  legs: { in: { tier: 'unpriced', sources: [] }, out: { tier: 'unpriced', sources: [] } },
}

/** The pair tier from its two legs — the BEST leg decides (D2/D3). */
export function combinePairTier(legIn: SwapPriceLeg, legOut: SwapPriceLeg): SwapPriceTierResponse {
  const tier = TIER_RANK[legIn.tier] >= TIER_RANK[legOut.tier] ? legIn.tier : legOut.tier
  const out: SwapPriceTierResponse = { tier, legs: { in: legIn, out: legOut } }
  if (tier === 'priced') {
    const bps = [legIn, legOut]
      .filter(l => l.tier === 'priced' && typeof l.agreementBps === 'number')
      .map(l => l.agreementBps as number)
    if (bps.length > 0) out.agreementBps = Math.max(...bps)
  }
  return out
}

/** "DefiLlama" / "Chainlink / CoinGecko": the vendor(s) behind a single-source pair, trust order, deduped. */
export function singleSourceLabel(pair: SwapPriceTierResponse): string {
  if (pair.tier !== 'single-source') return ''
  const seen = new Set<SwapPriceSource>()
  for (const leg of [pair.legs.in, pair.legs.out]) {
    if (leg.tier === 'single-source') for (const s of leg.sources) seen.add(s)
  }
  return SWAP_PRICE_SOURCE_TRUST_ORDER.filter(s => seen.has(s)).map(s => SWAP_PRICE_SOURCE_LABEL[s]).join(' / ')
}

function parseLeg(v: unknown): SwapPriceLeg | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.tier !== 'string' || !TIERS.has(o.tier)) return null
  if (!Array.isArray(o.sources) || !o.sources.every(s => typeof s === 'string' && SOURCES.has(s))) return null
  const leg: SwapPriceLeg = { tier: o.tier as SwapPriceTier, sources: o.sources as SwapPriceSource[] }
  if (o.usd !== undefined) {
    if (typeof o.usd !== 'number' || !Number.isFinite(o.usd) || o.usd <= 0) return null
    leg.usd = o.usd
  }
  if (o.agreementBps !== undefined) {
    if (typeof o.agreementBps !== 'number' || !Number.isFinite(o.agreementBps) || o.agreementBps < 0) return null
    leg.agreementBps = o.agreementBps
  }
  return leg
}

/**
 * The browser's parser for GET /api/swap-price-tier: a well-formed answer or null. null means
 * "unknown" — the client shows nothing and lets the server's /api/swap decide (D1), never a guess.
 */
export function parseSwapPriceTierResponse(json: unknown): SwapPriceTierResponse | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  if (typeof o.tier !== 'string' || !TIERS.has(o.tier)) return null
  const legs = o.legs
  if (!legs || typeof legs !== 'object') return null
  const legIn = parseLeg((legs as Record<string, unknown>).in)
  const legOut = parseLeg((legs as Record<string, unknown>).out)
  if (!legIn || !legOut) return null
  const out: SwapPriceTierResponse = { tier: o.tier as SwapPriceTier, legs: { in: legIn, out: legOut } }
  if (o.agreementBps !== undefined) {
    if (typeof o.agreementBps !== 'number' || !Number.isFinite(o.agreementBps) || o.agreementBps < 0) return null
    out.agreementBps = o.agreementBps
  }
  return out
}
