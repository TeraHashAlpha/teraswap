/**
 * [P226 / ADR-009] Per-chain viem PublicClient factory (for simulation reads).
 *
 * Mainnet (chainId 1) returns the existing `getPrivateClient()` — which routes
 * the browser through /api/rpc to hide the user's IP — so mainnet simulation
 * behaviour is byte-identical. Other chains get a cached client built from the
 * chain's configured RPC (falling back to viem's default public RPC).
 *
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] `guardedHttp` (rpc-guarded-transport.ts), never bare `http(url)`.
 * This is the THIRD upstream resolver the incident exposed — after `/api/rpc` and
 * `wagmiConfig.ts` — and it feeds quote simulation, portfolio reads, and the on-chain monitor,
 * so an endpoint answering for the wrong chain here is the same silent-lie failure mode with a
 * different blast radius. Mainnet is untouched: `getPrivateClient()` already routes through the
 * guarded `/api/rpc` proxy.
 */
import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem'
import { mainnet, base, arbitrum } from 'viem/chains'
import { getPrivateClient } from '@/lib/rpc'
import { guardedHttp } from '@/lib/rpc-guarded-transport'
import { getChainConfig, DEFAULT_CHAIN_ID } from './registry'

// [SPRINT-47-ARBITRUM-ACTIVATION-PREP] Arbitrum was registered in chains/registry.ts (Sprint 46)
// but had NO entry here — createPublicClient({chain: undefined, ...}) would have built a client
// with no chain object, silently dropping chain-typed metadata (e.g. the `chain.id` the sequencer
// gate / simulation callers read). Ported alongside the env-driven feeCollector so the simulation
// path is genuinely ready the moment Arbitrum activates, not just reachable.
const VIEM_CHAINS: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
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

  // [CHORE-POLISH-3 P3] Use the registry's fallback RPCs. Previously only
  // http(primary) was built, so a degraded Base primary failed ALL Base reads
  // (quote simulation / portfolio / monitor). Mirrors wagmiConfig's transport
  // pattern: a single URL stays a plain http transport; several become a viem
  // fallback() chain tried in order. The mainnet path above (getPrivateClient
  // → /api/rpc privacy proxy) is intentionally untouched.
  const configuredUrls = [config.rpc.primary, ...(config.rpc.fallbacks ?? [])].filter(Boolean)
  // [FIX-RPC-CHAIN-IDENTITY-GUARD] No configured RPC at all (registry primary + fallbacks both
  // empty — currently unreachable for Base/Arbitrum, whose registry entries always carry a
  // hardcoded fallback, but real for any future chain registered without one). Bare `http()`
  // would resolve to viem's OWN default public RPC for the chain — an endpoint we never chose
  // but is nonetheless a specific, known URL (`chain.rpcUrls.default.http`). "Implicitly the
  // right chain" is exactly the assumption this whole module exists to stop trusting, so we
  // resolve that default explicitly and guard it identically to a configured URL, rather than
  // carving out the one path this branch would otherwise leave unverified. Only if viem's own
  // chain metadata carries no default URL either (not true for any chain in VIEM_CHAINS today)
  // does this fall through to bare `http()`.
  const urls = configuredUrls.length > 0 ? configuredUrls : (chain?.rpcUrls.default.http ?? [])
  const transport =
    urls.length === 0
      ? http() // no explicit or default URL exists anywhere — nothing to guard against
      : urls.length === 1
        ? guardedHttp(urls[0], chainId)
        : fallback(urls.map((url) => guardedHttp(url, chainId)))

  const client = createPublicClient({ chain, transport }) as PublicClient
  clientCache.set(chainId, client)
  return client
}

/** Test-only: reset the per-chain client cache between cases. */
export function _clearClientCache(): void {
  clientCache.clear()
}
