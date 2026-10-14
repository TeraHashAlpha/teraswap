/**
 * [fix/dca-chain-switch] Is this token address a real contract on THIS chain?
 *
 * The DCA create route and /api/dca-floor-cap used to trust whatever token addresses the client sent
 * for the order's chainId. A stale client (Arbitrum WETH/ARB inside a Base request) was classified as
 * "unregistered, unpriced" and could even be signed. The server now refuses a foreign address:
 *
 *   native sentinel                          → on chain (rules unchanged; the callers handle it)
 *   in the chain's known token map           → on chain, no RPC
 *   else `eth_getCode` on the order's chain   → code present = on chain, empty = NOT on chain
 *
 * Chain-aware by construction: the client comes from getPublicClientForChain(chainId), never a
 * default chain. Verdicts (true/false) are cached 10 minutes per (chainId, address); a lookup that
 * FAILS is `null` ("could not verify"), never cached and never a pass — callers fail closed.
 */
import { getPublicClientForChain } from '@/lib/chains/clients'
import { getFullCatalog } from '@/lib/chains/tokens'
import { getChainConfig } from '@/lib/chains/registry'
import { NATIVE_ETH } from '@/lib/constants'

export type TokenOnChain =
  | { onChain: true }
  | { onChain: false; reason: string }
  | { onChain: null; reason: string }

const TTL_MS = 10 * 60_000
const CACHE_MAX = 1000
const cache = new Map<string, { onChain: boolean; expiresAt: number }>()

/** Test seam: drop cached verdicts. */
export function _clearTokenOnChainCache() { cache.clear() }

export interface TokenOnChainDeps {
  /** Returns the contract bytecode at `address` ('0x' / undefined when none). */
  getCode?: (chainId: number, address: string) => Promise<string | undefined>
}

const defaultGetCode = async (chainId: number, address: string) =>
  getPublicClientForChain(chainId).getCode({ address: address as `0x${string}` })

export async function checkTokenOnChain(
  chainId: number,
  address: string,
  deps: TokenOnChainDeps = {},
): Promise<TokenOnChain> {
  const addr = address.toLowerCase()
  if (addr === NATIVE_ETH.toLowerCase()) return { onChain: true }
  try {
    getChainConfig(chainId) // unsupported chain → cannot verify
  } catch {
    return { onChain: null, reason: `chain ${chainId} is not supported` }
  }
  if (getFullCatalog(chainId).some(t => t.address.toLowerCase() === addr)) return { onChain: true }

  const key = `${chainId}:${addr}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now < hit.expiresAt) {
    return hit.onChain ? { onChain: true } : { onChain: false, reason: `no contract at ${address} on chain ${chainId}` }
  }
  let code: string | undefined
  try {
    code = await (deps.getCode ?? defaultGetCode)(chainId, address)
  } catch {
    return { onChain: null, reason: `could not read contract code on chain ${chainId}` }
  }
  const onChain = typeof code === 'string' && code !== '0x' && code.length > 2
  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k)
    if (cache.size >= CACHE_MAX) cache.clear()
  }
  cache.set(key, { onChain, expiresAt: now + TTL_MS })
  return onChain ? { onChain: true } : { onChain: false, reason: `no contract at ${address} on chain ${chainId}` }
}
