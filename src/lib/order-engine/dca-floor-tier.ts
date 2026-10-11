/**
 * [FEAT-DCA-FLOOR-TIERS] How strong a minimum-output guarantee does a DCA pair get?
 *
 * Owner decision 2026-10-11: DCA works for ANY token on the chain. The 2026-09-09 hard block on
 * "no on-chain feed" (executor-feed-registry.ts) becomes informed consent, and the SERVER is the
 * authority on which consent is required (api/orders/route.ts calls this, never trusts the client).
 *
 *   onchain-feed    both legs are registered in the chain's OrderExecutorV3 `tokenUsdFeeds`, so the
 *                   contract enforces max(oracleFloor, scaledMin) on every fill. No consent needed.
 *   offchain-price  not both registered, but both legs have a price the keeper can reach QUORUM on
 *                   (DefiLlama + CoinGecko agreeing; the chain's WETH via Chainlink — dca-price-quorum.ts).
 *                   The contract cannot enforce a minimum; the keeper's off-chain check is the only protection.
 *   unpriced        otherwise: one source, disagreeing sources or none — exactly the keeper's single / skip.
 *                   The keeper fills-and-flags up to DCA_NO_PRICE_FILL_CAP_MAX_USD, else delays.
 *
 * FAIL CLOSED TO THE STRONGEST WARNING: any lookup failure (unsupported chain, no executor, RPC
 * down, unrecognised registry answer, price source down) yields `unpriced`, never a weaker tier.
 * It can only ever ASK FOR MORE consent, never less.
 *
 * Address fidelity (see executor-feed-registry.ts): the registry is asked about the addresses as
 * they are SIGNED, i.e. native ETH resolved to the chain's wrapped native and nothing else.
 */

import { getOrderExecutorV3 } from './config'
import { readExecutorFeedCoverage, type ExecutorFeedReader } from './executor-feed-registry'
import { quorumPriceUsd } from './dca-price-quorum'
import { getChainConfig } from '@/lib/chains/registry'
import { getPublicClientForChain } from '@/lib/chains/clients'
import { NATIVE_ETH } from '@/lib/constants'

export type DcaFloorTier = 'onchain-feed' | 'offchain-price' | 'unpriced'

/**
 * HARD CEILING on the per-fill USD cap the keeper applies to a fill with no price reference.
 * Equals the keeper's DEFAULT `DCA_FAIL_OPEN_MAX_USD` (contracts/order-engine/executor/order-floor.js:188),
 * pinned by dca-floor-tier.test.ts. The keeper can override its cap via env, so this is a MAXIMUM,
 * not a claim about the live value: the effective cap is min(keeper_runtime_config row, this).
 * Owner decision 2026-10-11 (follow-up: keeper clamping env above this + writing the row is deferred
 * to the keeper price-quorum goal). Mirrored literal: the keeper is plain JS outside the Next bundle.
 */
export const DCA_NO_PRICE_FILL_CAP_MAX_USD = 250

export interface ClassifyDcaFloorParams {
  chainId: number
  tokenIn: string
  tokenOut: string
}

/** Test seam. Production callers pass nothing. */
export interface ClassifyDcaFloorDeps {
  reader?: ExecutorFeedReader
  executor?: string | null
  /** USD price of a token on the chain's DefiLlama slug, or null when unavailable. */
  priceUsd?: (address: string, slug: string) => Promise<number | null>
}

/** [feat/dca-tier-server-side] "Priced" = the keeper can reach a price QUORUM for it (dca-price-quorum.ts). */
const defaultPriceUsd = quorumPriceUsd

/** What the classifier learned about ONE leg. null = not determined (lookup failed or never needed). */
export interface DcaFloorLeg {
  /** In the chain's OrderExecutorV3 `tokenUsdFeeds`. */
  registered: boolean | null
  /** Has a price the keeper can use (registered feed, the chain's WETH, or an off-chain price). */
  priced: boolean | null
}

export interface DcaFloorLegs {
  in: DcaFloorLeg
  out: DcaFloorLeg
}

const UNKNOWN_LEGS = (): DcaFloorLegs => ({
  in: { registered: null, priced: null },
  out: { registered: null, priced: null },
})

export interface DcaFloorClassification {
  tier: DcaFloorTier
  /** Per-leg facts behind the tier (display + GET /api/dca-floor-cap). Unknown legs are null, never guessed. */
  legs: DcaFloorLegs
  /**
   * The legs (addresses as SIGNED) that put the pair below `onchain-feed` (offchain-price) or that
   * could not be priced (unpriced; BOTH legs when the lookup itself failed). Empty for onchain-feed.
   * Display only — the tier is the decision.
   */
  affected: string[]
}

export async function classifyDcaFloorDetailed(
  params: ClassifyDcaFloorParams,
  deps: ClassifyDcaFloorDeps = {},
): Promise<DcaFloorClassification> {
  let bothLegs: string[] = [params.tokenIn, params.tokenOut]
  try {
    const cfg = getChainConfig(params.chainId) // throws on an unsupported chain → unpriced
    const wrapped = cfg.nativeCurrency.wrappedAddress
    const sign = (a: string) => (a.toLowerCase() === NATIVE_ETH.toLowerCase() ? wrapped : a)
    const legs = [
      { role: 'spend' as const, symbol: 'tokenIn', address: sign(params.tokenIn) },
      { role: 'buy' as const, symbol: 'tokenOut', address: sign(params.tokenOut) },
    ]
    bothLegs = legs.map(l => l.address)

    const coverage = await readExecutorFeedCoverage({
      reader: deps.reader ?? getPublicClientForChain(params.chainId),
      executor: deps.executor !== undefined ? deps.executor : getOrderExecutorV3(params.chainId),
      chainName: cfg.name,
      legs,
    })
    if (coverage.ok) {
      const both = { registered: true, priced: true }
      return { tier: 'onchain-feed', affected: [], legs: { in: { ...both }, out: { ...both } } }
    }
    // Registry could not be READ (RPC down, no executor): we do not know the contract's coverage,
    // so claim nothing about the off-chain tier either.
    if (coverage.unreadable) return { tier: 'unpriced', affected: bothLegs, legs: UNKNOWN_LEGS() }

    // WETH is priced by the keeper through Chainlink on every supported chain.
    const priceUsd = deps.priceUsd ?? defaultPriceUsd
    const unpriced: string[] = []
    const priced = new Map<string, boolean>()
    await Promise.all(legs.map(async l => { // legs asked in parallel: 2 sources x 2 legs must not stack their timeouts
      const ok = l.address.toLowerCase() === wrapped.toLowerCase()
        || (await priceUsd(l.address, cfg.slug).catch(() => null)) !== null
      priced.set(l.role, ok)
    }))
    for (const l of legs) if (priced.get(l.role) === false) unpriced.push(l.address)
    const isUnreg = (a: string) => coverage.unregistered.some(u => u.address.toLowerCase() === a.toLowerCase())
    const detail: DcaFloorLegs = {
      in: { registered: !isUnreg(legs[0].address), priced: priced.get('spend') ?? null },
      out: { registered: !isUnreg(legs[1].address), priced: priced.get('buy') ?? null },
    }
    if (unpriced.length > 0) return { tier: 'unpriced', affected: unpriced, legs: detail }
    return { tier: 'offchain-price', affected: coverage.unregistered.map(l => l.address), legs: detail }
  } catch {
    return { tier: 'unpriced', affected: bothLegs, legs: UNKNOWN_LEGS() }
  }
}

/** How strong a warning each tier carries. A stronger acknowledgement covers a weaker requirement. */
const TIER_STRENGTH: Record<DcaFloorTier, number> = { 'onchain-feed': 0, 'offchain-price': 1, unpriced: 2 }

/**
 * [fix/dca-consent-copy-and-tier-check] Owner decision 2026-10-11: an acknowledgement of a tier EQUAL
 * TO OR STRONGER than the server's classification satisfies it (a user who accepted `unpriced` has
 * accepted everything `offchain-price` asks); a weaker or unknown tier never does. The browser and the
 * server can disagree when a price source answers one and not the other; the caller still records the
 * SERVER's tier.
 */
export function floorAckCovers(ackTier: unknown, required: DcaFloorTier): boolean {
  if (typeof ackTier !== 'string' || !Object.prototype.hasOwnProperty.call(TIER_STRENGTH, ackTier)) return false
  return TIER_STRENGTH[ackTier as DcaFloorTier] >= TIER_STRENGTH[required]
}

export async function classifyDcaFloor(
  params: ClassifyDcaFloorParams,
  deps: ClassifyDcaFloorDeps = {},
): Promise<DcaFloorTier> {
  return (await classifyDcaFloorDetailed(params, deps)).tier
}

/**
 * [fix/dca-consent-copy-and-tier-check] How many of `tokens` the chain's OrderExecutorV3 has a feed
 * registered for in `tokenUsdFeeds` — asked through the SAME registry helper the classifier uses, with
 * the same signing rule (native ETH counts as the chain's wrapped native; duplicates count once).
 * null when the registry cannot be read (no executor, RPC down, unrecognised answer, unsupported
 * chain): the consent copy then shows no number at all rather than a guessed one.
 */
export async function countRegisteredFeeds(
  params: { chainId: number; tokens: readonly string[] },
  deps: Pick<ClassifyDcaFloorDeps, 'reader' | 'executor'> = {},
): Promise<number | null> {
  try {
    const cfg = getChainConfig(params.chainId)
    const wrapped = cfg.nativeCurrency.wrappedAddress
    const byKey = new Map<string, string>()
    for (const t of params.tokens) {
      const signed = t.toLowerCase() === NATIVE_ETH.toLowerCase() ? wrapped : t
      if (!byKey.has(signed.toLowerCase())) byKey.set(signed.toLowerCase(), signed)
    }
    const legs = [...byKey.values()].map(address => ({ role: 'buy' as const, symbol: address, address }))
    const coverage = await readExecutorFeedCoverage({
      reader: deps.reader ?? getPublicClientForChain(params.chainId),
      executor: deps.executor !== undefined ? deps.executor : getOrderExecutorV3(params.chainId),
      chainName: cfg.name,
      legs,
    })
    if (coverage.unreadable) return null
    return legs.length - coverage.unregistered.length
  } catch {
    return null
  }
}

/**
 * Effective no-price fill cap: min(keeper_runtime_config.no_price_fill_cap_usd, MAX); MAX when there
 * is no row or the value is not a finite positive number. Never exceeds the ceiling.
 */
export function effectiveNoPriceCapUsd(rowCap: unknown): number {
  const n = typeof rowCap === 'string' ? Number(rowCap) : rowCap
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return DCA_NO_PRICE_FILL_CAP_MAX_USD
  return Math.min(n, DCA_NO_PRICE_FILL_CAP_MAX_USD)
}
