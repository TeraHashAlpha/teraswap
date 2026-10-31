/**
 * Server-RPC liveness probe (H1 extension).
 *
 * Nothing used to probe the server RPC, so the 2026-10-29/30 outage was invisible to the monitor.
 * One read-only `eth_blockNumber` per chain through the SAME resolver the server uses
 * (`serverRpcUrl`, rpc-env.ts — not modified here), fed into the source state machine as
 * `server-rpc:<chainId>` so degraded/disabled transitions page through the normal alert path.
 *
 * The URL carries the provider key, so it is never logged or put into an error string.
 *
 * @internal — server-only module.
 */

import { kv } from '@/lib/kv'
import { RPC_ENV_CHAIN_IDS, serverRpcUrl } from './rpc-env'
import type { HealthCheckResult } from './health-check'

const RPC_PROBE_TIMEOUT_MS = 5_000
const RPC_PROBE_COUNTER_KEY = 'teraswap:monitor:rpcProbeTickCounter'
/** Probe every Nth tick (~5 min at the 60 s tick): 3 chains x 288/day = 864 calls/day. */
export const RPC_PROBE_TICK_INTERVAL = 5

export function rpcProbeId(chainId: number): string {
  return `server-rpc:${chainId}`
}

export async function shouldRunRpcProbe(): Promise<boolean> {
  try {
    const count = await kv.incr(RPC_PROBE_COUNTER_KEY)
    return count % RPC_PROBE_TICK_INTERVAL === 0
  } catch (err) {
    console.warn('[RPC-PROBE] KV tick counter failed, skipping:', err instanceof Error ? err.message : err)
    return false
  }
}

/** One eth_blockNumber against the server-resolved RPC for `chainId`. Failures here ARE source failures. */
export async function probeServerRpc(chainId: number): Promise<HealthCheckResult> {
  const start = Date.now()
  try {
    const res = await fetch(serverRpcUrl(chainId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(RPC_PROBE_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` }
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { code?: unknown } } | null
    if (body && typeof body.result === 'string' && /^0x[0-9a-f]+$/i.test(body.result)) {
      return { ok: true, latencyMs }
    }
    const code = typeof body?.error?.code === 'number' ? ` code ${body.error.code}` : ''
    return { ok: false, latencyMs, error: `rpc-error${code}` }
  } catch (err) {
    // Message is classified, never echoed: undici errors can embed the request URL.
    const name = err instanceof Error ? err.name : 'Error'
    return { ok: false, latencyMs: Date.now() - start, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network-error' }
  }
}

export interface RpcProbeOutcome {
  id: string
  chainId: number
  result: HealthCheckResult
}

/** Probe every chain the resolver knows about, in parallel. */
export async function probeAllServerRpcs(): Promise<RpcProbeOutcome[]> {
  return Promise.all(
    RPC_ENV_CHAIN_IDS.map(async (chainId) => ({
      id: rpcProbeId(chainId),
      chainId,
      result: await probeServerRpc(chainId),
    })),
  )
}
