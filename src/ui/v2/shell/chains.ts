/**
 * [ADR-025] Network list for the shell dropdown — straight from the chain registry (never a typed list). The
 * subtitle is one slot constant for every network (owner wording, 26 Oct: "Swap" → "Change"; supersedes the
 * `isDcaLive`-derived "Swap · DCA").
 */
import { getChainConfig, getSupportedChainIds } from '@/lib/chains/registry'

export const NETWORK_SUBTITLE = 'Change'

export interface ShellChain {
  chainId: number
  name: string
  subtitle: typeof NETWORK_SUBTITLE
  /** Same activation gate as v1's ChainSelector: a chain without a FeeCollector cannot be selected. */
  selectable: boolean
}

export function shellChains(): ShellChain[] {
  return getSupportedChainIds().map((chainId) => {
    const config = getChainConfig(chainId)
    return {
      chainId,
      name: config.name,
      subtitle: NETWORK_SUBTITLE,
      selectable: config.contracts.feeCollector !== null,
    }
  })
}
