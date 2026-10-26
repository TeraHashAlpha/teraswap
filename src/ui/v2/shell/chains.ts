/**
 * [ADR-025] Network list for the shell dropdown — straight from the chain registry (never a typed list), with
 * the capability subtitle derived from the SAME gate v1 uses (`isDcaLive`): Base reads "Swap · DCA" once its
 * executor is live, Arbitrum reads "Swap" until its executor is wired, then flips with no edit here.
 */
import { getChainConfig, getSupportedChainIds } from '@/lib/chains/registry'
import { isDcaLive } from '@/lib/dca-launch'

export interface ShellChain {
  chainId: number
  name: string
  subtitle: 'Swap' | 'Swap · DCA'
  /** Same activation gate as v1's ChainSelector: a chain without a FeeCollector cannot be selected. */
  selectable: boolean
}

export function shellChains(): ShellChain[] {
  return getSupportedChainIds().map((chainId) => {
    const config = getChainConfig(chainId)
    return {
      chainId,
      name: config.name,
      subtitle: isDcaLive(chainId) ? 'Swap · DCA' : 'Swap',
      selectable: config.contracts.feeCollector !== null,
    }
  })
}
