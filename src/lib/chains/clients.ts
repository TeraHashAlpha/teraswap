/**
 * [P226 / ADR-009] Per-chain viem PublicClient factory (for simulation reads).
 *
 * Mainnet (chainId 1) returns the existing `getPrivateClient()` — which routes
 * the browser through /api/rpc to hide the user's IP — so mainnet simulation
 * behaviour is byte-identical. Other chains get a cached client built from the
 * chain's configured RPC (falling back to viem's default public RPC).
 */
import { createPublicClient, http, type Chain, type PublicClient } from 'viem'
import { mainnet, base } from 'viem/chains'
import { getPrivateClient } from '@/lib/rpc'
import { getChainConfig, DEFAULT_CHAIN_ID } from './registry'

const VIEM_CHAINS: Record<number, Chain> = {
  1: mainnet,
  8453: base,
}

// Cache one client per non-mainnet chain (mainnet uses getPrivateClient, which
// is already cheap + privacy-preserving and intentionally per-call).
const clientCache = new Map<number, PublicClient>()

export function getPublicClientForChain(chainId: number = DEFAULT_CHAIN_ID): PublicClient {
  if (chainId === DEFAULT_CHAIN_ID) {
    return getPrivateClient()
  }
  const cached = clientCache.get(chainId)
  if (cached) return cached

  const chain = VIEM_CHAINS[chainId]
  const config = getChainConfig(chainId) // throws on an unsupported chain
  const client = createPublicClient({
    chain,
    transport: http(config.rpc.primary || undefined), // undefined → viem default public RPC
  }) as PublicClient
  clientCache.set(chainId, client)
  return client
}

/** Test-only: reset the per-chain client cache between cases. */
export function _clearClientCache(): void {
  clientCache.clear()
}
