/**
 * [P223 / ADR-009] Per-chain swap activation guard.
 *
 * A chain's swaps go live only once its FeeCollector is deployed and its
 * address is set in the ChainConfig. Until then the chain is "coming-soon":
 * the UI lets users browse (tokens, amount) but disables quotes + swaps. This
 * is the single gate TeraHash flips by setting contracts.feeCollector after the
 * Base FeeCollector deployment (see contracts/DEPLOY.md).
 */
import { getChainConfig } from './registry'
import { FEE_INCOMPATIBLE_SOURCES } from '@/lib/constants'

export type ChainStatus = 'active' | 'coming-soon' | 'unsupported'

/** A chain is active for swaps once its FeeCollector address is set. */
export function isChainActive(chainId: number): boolean {
  try {
    return getChainConfig(chainId).contracts.feeCollector !== null
  } catch {
    return false
  }
}

export function getChainStatus(chainId: number): ChainStatus {
  try {
    const config = getChainConfig(chainId)
    return config.contracts.feeCollector === null ? 'coming-soon' : 'active'
  } catch {
    return 'unsupported'
  }
}

/**
 * Sources that cannot route through the FeeCollector on a given chain (so the
 * partner-fee / FeeCollector path is skipped for them). Mainnet references the
 * canonical FEE_INCOMPATIBLE_SOURCES constant verbatim; per-chain overrides go
 * here as chains are activated.
 */
const FEE_INCOMPATIBLE_BY_CHAIN: Record<number, readonly string[]> = {
  1: FEE_INCOMPATIBLE_SOURCES,
  // Base (8453): 0x v2 (Permit2 pull model) + CoW (intent-based) + Bebop (JAM
  // builds its own settlement tx; fee via partner params) are structurally
  // FeeCollector-incompatible, same as mainnet. [ADR-010] keeps 'bebop' here so
  // it is never routed through the Base FeeCollector once that is deployed.
  8453: ['0x', 'cowswap', 'bebop'],
  // [SPRINT-47-ARBITRUM-ACTIVATION-PREP] Arbitrum (42161): identical structural
  // incompatibilities (0x AllowanceHolder pull-model, CoW intent-based, Bebop JAM) — these are
  // protocol properties of the SOURCE, not the chain, so the set is the same as mainnet/Base.
  // Pinned explicitly (was previously falling through to FEE_INCOMPATIBLE_SOURCES via the `??`
  // default below) so Arbitrum's behavior doesn't silently drift if that constant ever changes
  // for an unrelated reason.
  42161: ['0x', 'cowswap', 'bebop'],
}

export function getFeeIncompatibleSources(chainId: number): string[] {
  return [...(FEE_INCOMPATIBLE_BY_CHAIN[chainId] ?? FEE_INCOMPATIBLE_SOURCES)]
}
