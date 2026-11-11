/**
 * [fix/user-ip-privacy] A 1.5 s per-instance cache for the two reads every open tab repeats:
 * `eth_chainId` and `eth_blockNumber`.
 *
 * Why: Base and Arbitrum reads now go through /api/rpc like mainnet, so the proxy carries the chain-id
 * check and the block poll for every visitor on every chain. Both answers are the same for everyone on
 * a chain, so one upstream call can serve all of them for a moment. 1.5 s is inside the owner's 1–2 s
 * window: against a 60 s footer poll and 12 s / 2 s / 0.25 s block times it can make a block number at
 * most 1.5 s old, which nothing in the app decides on (a swap never reads it).
 *
 * Scope, deliberately small:
 *  - only those two methods, only with no params, only a SINGLE (non-batch) request — a batch is
 *    forwarded untouched, so its responses never have to be re-assembled by id;
 *  - only a successful hex result is stored — never an error, never a non-string;
 *  - keyed by the proxy's VALIDATED numeric chain id, in a Map, so at most 2 entries per chain exist
 *    and no caller-supplied string can become a key.
 *
 * It sits BEHIND the chain-identity guard in route.ts: a chain whose upstream answers for another
 * chain is refused before this is consulted, so the cache can never serve an answer for a lying
 * upstream. It never skips the rate limit either — a cached answer is charged like any other call.
 */

export const RPC_SHORT_CACHE_TTL_MS = 1_500

const CACHEABLE_METHODS: ReadonlySet<string> = new Set(['eth_chainId', 'eth_blockNumber'])
const HEX_RESULT = /^0x[0-9a-fA-F]+$/

const cache = new Map<string, { result: string; expiresAt: number }>()

const keyOf = (chainId: number, method: string) => `${chainId}:${method}`

/** True for a param-less `eth_chainId` / `eth_blockNumber` request. */
export function isShortCacheable(rpcReq: { method?: unknown; params?: unknown }): rpcReq is { method: string } {
  if (typeof rpcReq?.method !== 'string' || !CACHEABLE_METHODS.has(rpcReq.method)) return false
  return rpcReq.params === undefined || rpcReq.params === null || (Array.isArray(rpcReq.params) && rpcReq.params.length === 0)
}

/** The cached result for (chain, method) if it is still fresh, else undefined. */
export function readShortCache(chainId: number, method: string, now: number = Date.now()): string | undefined {
  const hit = cache.get(keyOf(chainId, method))
  if (!hit) return undefined
  if (hit.expiresAt <= now) {
    cache.delete(keyOf(chainId, method))
    return undefined
  }
  return hit.result
}

/** Store a successful hex result. Anything else (error envelope, null, object) is ignored. */
export function writeShortCache(chainId: number, method: string, result: unknown, now: number = Date.now()): void {
  if (!CACHEABLE_METHODS.has(method)) return
  if (typeof result !== 'string' || !HEX_RESULT.test(result)) return
  cache.set(keyOf(chainId, method), { result, expiresAt: now + RPC_SHORT_CACHE_TTL_MS })
}

/** Test-only: forget every cached answer. */
export function __resetRpcShortCache(): void {
  cache.clear()
}
