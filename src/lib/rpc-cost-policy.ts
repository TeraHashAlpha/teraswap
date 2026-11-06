/**
 * [CHORE-API-HARDENING-2 / P3c CONFIRMED] Cost policy for the /api/rpc proxy.
 *
 * The proxy's method policy was a pure blacklist of signing methods — any other
 * JSON-RPC read method was forwarded verbatim to the (paid, metered) upstream
 * RPC. `debug_*`/`trace_*` are archive-grade queries with no legitimate use in
 * this dApp's wagmi/viem call surface; these pure helpers cap batch size and
 * deny the archive methods — the per-IP rate limit (rpc:<ip>) remains the
 * backstop, but no longer has to absorb an unbounded per-request cost multiplier.
 *
 * [fix/user-ip-privacy A76 S-3] eth_getLogs is no longer relayed at all (rpc-method-policy.ts), so the
 * eth_getLogs range clamp that lived here is gone: a numeric range could be clamped, a tag range
 * ("earliest".."latest") could not, and that is the 12 MB answer the audit pulled through the proxy. What
 * bounds an answer now is the upstream deadline and the byte cap below, for every method.
 */

/** Max JSON-RPC requests forwarded per batch. Viem's public-client batching
 *  groups a handful of calls together; 25 is generous headroom over normal
 *  multicall-style usage while bounding a scripted amplification attempt. */
export const MAX_RPC_BATCH_SIZE = 25

/** [fix/user-ip-privacy A76 S-3] Upstream deadline, connection to last byte (AbortSignal.timeout on the fetch). */
export const RPC_UPSTREAM_TIMEOUT_MS = 10_000

/** [fix/user-ip-privacy A76 S-3] Largest upstream answer the proxy relays (read incrementally — read-body-capped.ts);
 *  larger is a 502. A 25-call batch of this app's reads is a few hundred KB at most; Vercel's own response limit is 4.5 MB. */
export const RPC_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

const EXPENSIVE_METHOD_PREFIXES = ['debug_', 'trace_']

/** True for debug_* / trace_* archive-grade methods — no legitimate use in the
 *  app's wagmi/viem call surface; deny at the proxy. Never throws. */
export function isExpensiveMethod(method: unknown): boolean {
  if (typeof method !== 'string' || method.length === 0) return false
  return EXPENSIVE_METHOD_PREFIXES.some((p) => method.startsWith(p))
}

/**
 * [FEAT-SERVER-RPC-ENV-SPLIT] Rate-limit units one /api/rpc HTTP request costs: one per JSON-RPC
 * call, so a 25-call batch counts 25 (it used to count 1 and let a client multiply its budget by
 * the batch size). A single call, an empty/over-cap batch (rejected before any forwarding) or a
 * non-JSON-RPC body costs 1 — exactly what those requests cost before.
 */
export function rpcRateLimitUnits(body: unknown, max: number = MAX_RPC_BATCH_SIZE): number {
  if (!Array.isArray(body) || body.length === 0 || body.length > max) return 1
  return body.length
}

/** True when a batch of `count` requests exceeds the cap. */
export function exceedsBatchLimit(count: number, max: number = MAX_RPC_BATCH_SIZE): boolean {
  return count > max
}
