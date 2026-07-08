/**
 * [CHORE-API-HARDENING-2 / P3c CONFIRMED] /api/rpc cost policy at the route
 * level: batch-size cap, debug_* / trace_* denial, eth_getLogs range clamping.
 * The blocked-signing-method behaviour is pre-existing and re-asserted here so
 * a future change can't silently regress it alongside the new checks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 299, resetAt: 1_000 }),
  RPC_RATE_LIMIT: { limit: 300, windowMs: 60_000 },
}))

vi.mock('@/lib/rpc-proxy-chain', () => ({
  resolveProxyChainId: () => ({ chainId: 1 }),
}))

vi.mock('@/lib/adapters/shared', () => ({
  getRpcUrlForChain: () => 'http://upstream.test/rpc',
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { POST } from './route'

function rpcReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }),
  })
})

describe('POST /api/rpc — pre-existing signing-method blacklist (unchanged)', () => {
  it('still rejects eth_sendRawTransaction with 403', async () => {
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x...'] }))
    expect(res.status).toBe(403)
  })

  it('still forwards an ordinary read method (eth_getBlockByNumber)', async () => {
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }))
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('POST /api/rpc — batch size cap (P3c)', () => {
  it('accepts a batch at the cap', async () => {
    const batch = Array.from({ length: 25 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getBlockByNumber', params: ['latest', false] }))
    const res = await POST(rpcReq(batch))
    expect(res.status).toBe(200)
  })

  it('rejects a batch over the cap WITHOUT calling upstream', async () => {
    const batch = Array.from({ length: 26 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getBlockByNumber', params: ['latest', false] }))
    const res = await POST(rpcReq(batch))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/rpc — debug_* / trace_* archive queries denied (P3c)', () => {
  it('refuses debug_traceBlockByNumber with 403, no upstream call', async () => {
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'debug_traceBlockByNumber', params: ['latest'] }))
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses trace_filter with 403, no upstream call', async () => {
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'trace_filter', params: [{}] }))
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/rpc — eth_getLogs range clamped, not rejected (P3c)', () => {
  it('forwards a WIDE numeric eth_getLogs range with fromBlock clamped', async () => {
    const res = await POST(
      rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: '0x186a0' /* 100_000 */ }] }),
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    const forwardedBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(forwardedBody.params[0].toBlock).toBe('0x186a0') // untouched
    expect(forwardedBody.params[0].fromBlock).not.toBe('0x0') // rewritten, narrower
    const from = Number.parseInt(forwardedBody.params[0].fromBlock, 16)
    expect(0x186a0 - from).toBe(2_000)
  })

  it('forwards a narrow eth_getLogs range unchanged', async () => {
    const res = await POST(
      rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] }),
    )
    expect(res.status).toBe(200)
    const forwardedBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(forwardedBody.params[0]).toEqual({ fromBlock: '0x1', toBlock: '0x2' })
  })
})
