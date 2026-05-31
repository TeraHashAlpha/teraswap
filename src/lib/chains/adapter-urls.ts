/**
 * [P217 / ADR-009] Per-chain adapter API URL resolver.
 *
 * Returns the base/host URL for a given aggregator on a given chain. For
 * chainId === 1 (DEFAULT_CHAIN_ID) every URL is byte-identical to the legacy
 * AGGREGATOR_APIS[source].base value, so mainnet behaviour is unchanged.
 *
 * Three encodings (per ADR-009):
 *   - path-segment chainId: 1inch, OpenOcean, SushiSwap (and Balancer's /order/{id})
 *   - path-segment slug:    KyberSwap, CoW
 *   - query/body param:     0x, Velora (network), Odos (chainId in body)
 *
 * Query/body-param adapters return only the host here and attach the chain
 * parameter themselves; path adapters get the fully chain-qualified base.
 */
import { AGGREGATOR_APIS, getCowApiBase, type AggregatorName } from '@/lib/constants'
import { getChainConfig, DEFAULT_CHAIN_ID } from './registry'

export function getAdapterApiUrl(source: AggregatorName, chainId: number = DEFAULT_CHAIN_ID): string {
  switch (source) {
    // ── chainId in the path ──
    case '1inch':
      return `https://api.1inch.dev/swap/v6.0/${chainId}`
    case 'openocean':
      return `https://open-api.openocean.finance/v4/${chainId}`
    case 'sushiswap':
      return `https://api.sushi.com/swap/v7/${chainId}`
    // ── slug in the path ──
    case 'kyberswap':
      return `https://aggregator-api.kyberswap.com/${getChainConfig(chainId).slug}`
    case 'cowswap':
      return getCowApiBase(chainId)
    // ── host only (chain attached as a query/body/path param by the adapter) ──
    case '0x':
      return 'https://api.0x.org'
    case 'velora':
      return 'https://api.paraswap.io'
    case 'odos':
      return 'https://api.odos.xyz'
    case 'balancer':
      return 'https://api-v3.balancer.fi'
    // [ADR-010] Bebop — host only; the adapter builds /jam/{slug}/v2/quote from
    // getChainConfig(chainId).slug (ethereum/base).
    case 'bebop':
      return 'https://api.bebop.xyz'
    // ── on-chain sources (uniswap/curve/order-engine) have no API base ──
    default:
      return AGGREGATOR_APIS[source]?.base ?? ''
  }
}
