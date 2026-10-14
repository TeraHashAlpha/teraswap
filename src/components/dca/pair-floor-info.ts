import { DCA_NO_PRICE_FILL_CAP_MAX_USD, type DcaFloorTier } from '@/lib/order-engine'

/**
 * [feat/dca-tier-server-side] The browser no longer classifies a DCA pair. It asks
 * GET /api/dca-floor-cap?chainId&tokenIn&tokenOut — the server runs the SAME classifier that decides
 * the 409 on create — and only reads the answer. No price source and no RPC is touched from here.
 *
 * FAIL CLOSED: any failure (network, non-2xx, unrecognised shape) is `unpriced` with unknown legs, the
 * strongest warning. The server accepts a stronger acknowledgement than it requires, so asking for more
 * consent can never be refused; it can only never ask for less.
 */
export interface PairFloorLeg { registered: boolean | null; priced: boolean | null }
export interface PairFloorInfo {
  tier: DcaFloorTier
  legs: { in: PairFloorLeg; out: PairFloorLeg }
  registeredFeedCount: number | null
  effectiveCap: number | null
}

const TIERS: readonly string[] = ['onchain-feed', 'offchain-price', 'unpriced']
const UNKNOWN_LEG: PairFloorLeg = { registered: null, priced: null }

export const UNPRICED_FALLBACK: PairFloorInfo = {
  tier: 'unpriced',
  legs: { in: UNKNOWN_LEG, out: UNKNOWN_LEG },
  registeredFeedCount: null,
  effectiveCap: null,
}

const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const leg = (v: unknown): PairFloorLeg => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { registered: flag(o.registered), priced: flag(o.priced) }
}

export async function fetchPairFloorInfo(p: {
  chainId: number
  tokenIn: string
  tokenOut: string
  signal?: AbortSignal
}): Promise<PairFloorInfo> {
  try {
    const q = new URLSearchParams({ chainId: String(p.chainId), tokenIn: p.tokenIn, tokenOut: p.tokenOut })
    const res = await fetch(`/api/dca-floor-cap?${q}`, { signal: p.signal })
    if (!res.ok) return UNPRICED_FALLBACK
    const j = await res.json()
    if (!j || typeof j.tier !== 'string' || !TIERS.includes(j.tier)) return UNPRICED_FALLBACK
    return {
      tier: j.tier as DcaFloorTier,
      legs: { in: leg(j.legs?.in), out: leg(j.legs?.out) },
      registeredFeedCount: num(j.registeredFeedCount),
      effectiveCap: num(j.effectiveCap),
    }
  } catch {
    return UNPRICED_FALLBACK
  }
}

/**
 * The legs the consent copy names: offchain-price → legs the executor has no feed for; unpriced → legs
 * with no price. When the server could not say which (unknown legs), both — never a guessed one.
 */
export function affectedSymbols(info: PairFloorInfo, inSymbol: string, outSymbol: string): string[] {
  const pick = (f: (l: PairFloorLeg) => boolean) => [
    ...(f(info.legs.in) ? [inSymbol] : []),
    ...(f(info.legs.out) ? [outSymbol] : []),
  ]
  const names = info.tier === 'offchain-price' ? pick(l => l.registered === false) : pick(l => l.priced === false)
  const uniq = (a: string[]) => a.filter((n, i) => a.indexOf(n) === i)
  const out = uniq(names)
  return out.length ? out : uniq([inSymbol, outSymbol])
}

/**
 * [fix/dca-chain-switch / P3] The one-line note under the BUY selector, driven by the SAME server tier
 * the consent dialog uses (so the two can never disagree). `null` = no note (on-chain feed, or the tier
 * has not been answered yet).
 */
export function floorTierHint(info: PairFloorInfo | null): string | null {
  if (!info) return null
  if (info.tier === 'offchain-price') return 'Protected by executor price checks (no Chainlink feed registered yet)'
  if (info.tier === 'unpriced') {
    const c = info.effectiveCap
    const cap = typeof c === 'number' && Number.isFinite(c) && c > 0
      ? Math.min(c, DCA_NO_PRICE_FILL_CAP_MAX_USD) : DCA_NO_PRICE_FILL_CAP_MAX_USD
    return `No market price source right now — buys capped at $${cap} and flagged`
  }
  return null
}
