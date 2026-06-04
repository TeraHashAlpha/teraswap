/**
 * [SPRINT-9P P1] chainId resolution for the /api/rpc privacy proxy.
 *
 * The proxy historically only ever forwarded to the mainnet RPC. To import a
 * Base ERC-20 (eth_call symbol/name/decimals on Base, not mainnet) the proxy
 * must accept an optional `chainId` query param, validated against the chain
 * registry. Absent/blank → mainnet, so every existing caller (`POST /api/rpc`
 * with no chainId) is byte-identical.
 *
 * Pure + zero side-effects so it can be unit-tested without the route harness.
 */
import { DEFAULT_CHAIN_ID, getSupportedChainIds } from '@/lib/chains/registry'

export function resolveProxyChainId(
  param: string | null,
): { chainId: number } | { error: string } {
  if (param == null || param === '') return { chainId: DEFAULT_CHAIN_ID }
  if (!/^\d+$/.test(param)) return { error: `Invalid chainId: ${param}` }
  const chainId = Number(param)
  if (!getSupportedChainIds().includes(chainId)) {
    return { error: `Unsupported chainId: ${chainId}` }
  }
  return { chainId }
}
