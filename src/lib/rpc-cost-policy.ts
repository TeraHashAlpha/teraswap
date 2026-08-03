/**
 * [CHORE-API-HARDENING-2 / P3c CONFIRMED] Cost policy for the /api/rpc proxy.
 *
 * The proxy's method policy was a pure blacklist of signing methods — any other
 * JSON-RPC read method was forwarded verbatim to the (paid, metered) upstream
 * RPC. `debug_*`/`trace_*` are archive-grade queries with no legitimate use in
 * this dApp's wagmi/viem call surface (unlike eth_getBlockByNumber/
 * eth_getStorageAt/eth_getProof, which ARE used); an `eth_getLogs` call with an
 * unbounded numeric block range is similarly expensive. These pure helpers cap
 * batch size, deny the archive methods, and clamp eth_getLogs ranges — the
 * per-IP rate limit (rpc:<ip>) remains the backstop, but no longer has to
 * absorb an unbounded per-request cost multiplier.
 */

/** Max JSON-RPC requests forwarded per batch. Viem's public-client batching
 *  groups a handful of calls together; 25 is generous headroom over normal
 *  multicall-style usage while bounding a scripted amplification attempt. */
export const MAX_RPC_BATCH_SIZE = 25

/** Max eth_getLogs block span (fromBlock..toBlock) forwarded unclamped. */
export const MAX_GET_LOGS_BLOCK_RANGE = 2_000

const EXPENSIVE_METHOD_PREFIXES = ['debug_', 'trace_']

/** True for debug_* / trace_* archive-grade methods — no legitimate use in the
 *  app's wagmi/viem call surface; deny at the proxy. Never throws. */
export function isExpensiveMethod(method: unknown): boolean {
  if (typeof method !== 'string' || method.length === 0) return false
  return EXPENSIVE_METHOD_PREFIXES.some((p) => method.startsWith(p))
}

/** True when a batch of `count` requests exceeds the cap. */
export function exceedsBatchLimit(count: number, max: number = MAX_RPC_BATCH_SIZE): boolean {
  return count > max
}

/** Parse a JSON-RPC block tag as a block NUMBER; null for tags ("latest",
 *  "earliest", "pending"), absent, or malformed hex — those cannot be bounded
 *  cheaply (no chain-tip lookup here), so the caller leaves them untouched. */
function parseBlockNumber(v: unknown): number | null {
  if (typeof v !== 'string' || !v.startsWith('0x')) return null
  const n = Number.parseInt(v, 16)
  return Number.isFinite(n) ? n : null
}

/**
 * Clamp an eth_getLogs request's block range to MAX_GET_LOGS_BLOCK_RANGE by
 * rewriting `fromBlock` (keeps the call working — just bounds the scanned
 * range — rather than rejecting it outright). A no-op for any other method,
 * for a range at/under the cap, or when either bound is a tag/absent/malformed
 * (nothing to bound without an extra chain-tip lookup). Never throws.
 * @returns {{ clamped: boolean, request: object }} `request` is the (possibly
 *   rewritten) rpc request; pass this through instead of the original.
 */
export function clampGetLogsRange(rpcReq: { method?: unknown; params?: unknown }): {
  clamped: boolean
  request: typeof rpcReq
} {
  if (rpcReq?.method !== 'eth_getLogs' || !Array.isArray(rpcReq.params) || rpcReq.params.length === 0) {
    return { clamped: false, request: rpcReq }
  }
  const param = rpcReq.params[0]
  if (!param || typeof param !== 'object') return { clamped: false, request: rpcReq }

  const from = parseBlockNumber((param as Record<string, unknown>).fromBlock)
  const to = parseBlockNumber((param as Record<string, unknown>).toBlock)
  if (from === null || to === null) return { clamped: false, request: rpcReq } // tag-based — can't bound cheaply

  if (to - from <= MAX_GET_LOGS_BLOCK_RANGE) return { clamped: false, request: rpcReq }

  const clampedFrom = to - MAX_GET_LOGS_BLOCK_RANGE
  const newParam = { ...(param as Record<string, unknown>), fromBlock: `0x${clampedFrom.toString(16)}` }
  const newParams = [newParam, ...rpcReq.params.slice(1)]
  return { clamped: true, request: { ...rpcReq, params: newParams } }
}
