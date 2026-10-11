/**
 * [FEAT-DCA-FLOOR-TIERS] How strong a minimum-output guarantee does a DCA pair get?
 *
 * Owner decision 2026-10-11: DCA works for ANY token on the chain. The 2026-09-09 hard block on
 * "no on-chain feed" (executor-feed-registry.ts) becomes informed consent, and the SERVER is the
 * authority on which consent is required (api/orders/route.ts calls this, never trusts the client).
 *
 *   onchain-feed    both legs are registered in the chain's OrderExecutorV3 `tokenUsdFeeds`, so the
 *                   contract enforces max(oracleFloor, scaledMin) on every fill. No consent needed.
 *   offchain-price  not both registered, but both legs have a price the keeper can read
 *                   (DefiLlama; the chain's WETH via Chainlink). The contract cannot enforce a
 *                   minimum; the keeper's off-chain check is the only protection.
 *   unpriced        otherwise. The keeper fills-and-flags up to DCA_NO_PRICE_FILL_CAP_MAX_USD, else delays.
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
import { fetchDefiLlamaPrice } from '@/lib/defillama'
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

async function defaultPriceUsd(address: string, slug: string): Promise<number | null> {
  const p = await fetchDefiLlamaPrice(address, slug)
  return p && Number.isFinite(p.price) && p.price > 0 ? p.price : null
}

export interface DcaFloorClassification {
  tier: DcaFloorTier
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
    if (coverage.ok) return { tier: 'onchain-feed', affected: [] }
    // Registry could not be READ (RPC down, no executor): we do not know the contract's coverage,
    // so claim nothing about the off-chain tier either.
    if (coverage.unreadable) return { tier: 'unpriced', affected: bothLegs }

    // WETH is priced by the keeper through Chainlink on every supported chain.
    const priceUsd = deps.priceUsd ?? defaultPriceUsd
    const unpriced: string[] = []
    for (const l of legs) {
      if (l.address.toLowerCase() === wrapped.toLowerCase()) continue
      if ((await priceUsd(l.address, cfg.slug).catch(() => null)) === null) unpriced.push(l.address)
    }
    if (unpriced.length > 0) return { tier: 'unpriced', affected: unpriced }
    return { tier: 'offchain-price', affected: coverage.unregistered.map(l => l.address) }
  } catch {
    return { tier: 'unpriced', affected: bothLegs }
  }
}

export async function classifyDcaFloor(
  params: ClassifyDcaFloorParams,
  deps: ClassifyDcaFloorDeps = {},
): Promise<DcaFloorTier> {
  return (await classifyDcaFloorDetailed(params, deps)).tier
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
