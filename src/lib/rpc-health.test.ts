import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockIncr = vi.fn()
vi.mock('@/lib/kv', () => ({ kv: { incr: (...a: unknown[]) => mockIncr(...a) } }))

const SECRET_URL = 'https://rpc.example.test/v2/SECRET-KEY-123'
vi.mock('./rpc-env', () => ({
  RPC_ENV_CHAIN_IDS: [1, 8453, 42161],
  serverRpcUrl: () => SECRET_URL,
}))

import { probeServerRpc, probeAllServerRpcs, shouldRunRpcProbe, rpcProbeId, RPC_PROBE_TICK_INTERVAL } from './rpc-health'

afterEach(() => vi.unstubAllGlobals())

describe('probeServerRpc', () => {
  it('ok on a hex eth_blockNumber result, posting a read-only call', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x12a05f2' }) })
    vi.stubGlobal('fetch', f)
    expect((await probeServerRpc(1)).ok).toBe(true)
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ method: 'eth_blockNumber' })
  })

  it('HTTP 403 (allowlist/ACL rejection) is a failure with the status only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }))
    expect(await probeServerRpc(1)).toMatchObject({ ok: false, error: 'HTTP 403' })
  })

  it('JSON-RPC error body is a failure carrying the code, not the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ error: { code: -32600, message: `bad ${SECRET_URL}` } }) }))
    const r = await probeServerRpc(1)
    expect(r).toMatchObject({ ok: false, error: 'rpc-error code -32600' })
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })

  it('network failure never leaks the provider URL/key into the error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`fetch failed ${SECRET_URL}`)))
    const r = await probeServerRpc(1)
    expect(r).toMatchObject({ ok: false, error: 'network-error' })
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })

  it('timeout is classified as timeout', async () => {
    const e = new Error('x'); e.name = 'TimeoutError'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(e))
    expect((await probeServerRpc(1)).error).toBe('timeout')
  })
})

describe('probeAllServerRpcs / cadence', () => {
  beforeEach(() => mockIncr.mockReset())

  it('probes every resolver chain under a server-rpc:<chainId> id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: '0x1' }) }))
    const out = await probeAllServerRpcs()
    expect(out.map(o => o.id)).toEqual(['server-rpc:1', 'server-rpc:8453', 'server-rpc:42161'])
    expect(rpcProbeId(8453)).toBe('server-rpc:8453')
  })

  it('runs only every Nth tick', async () => {
    mockIncr.mockResolvedValueOnce(RPC_PROBE_TICK_INTERVAL - 1).mockResolvedValueOnce(RPC_PROBE_TICK_INTERVAL)
    expect(await shouldRunRpcProbe()).toBe(false)
    expect(await shouldRunRpcProbe()).toBe(true)
  })

  it('KV failure skips the probe instead of throwing', async () => {
    mockIncr.mockRejectedValueOnce(new Error('kv down'))
    expect(await shouldRunRpcProbe()).toBe(false)
  })
})
