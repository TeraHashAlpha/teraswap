// @vitest-environment node
/**
 * [FEAT-SERVER-RPC-ENV-SPLIT] /api/rpc charges the per-IP budget per JSON-RPC CALL, not per HTTP
 * request: a 25-call batch is 25 units, a 26-call batch is rejected (cap unchanged, 400, nothing
 * forwarded), a single call is 1 unit, key/limit/window are exactly the old ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ rate: vi.fn() }))

vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: mocks.rate,
  RPC_RATE_LIMIT: { limit: 300, windowMs: 60_000 },
}))
vi.mock('@/lib/rpc-proxy-chain', () => ({ resolveProxyChainId: () => ({ chainId: 1 }) }))
vi.mock('@/lib/adapters/shared', () => ({ getRpcUrlForChain: () => 'http://upstream.test/rpc' }))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { POST } from './route'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'

const call = (i: number) => ({ jsonrpc: '2.0', id: i, method: 'eth_getBlockByNumber', params: ['latest', false] })
const req = (body: unknown, raw?: string) =>
  new NextRequest('http://localhost/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: raw ?? JSON.stringify(body),
  })

beforeEach(() => {
  __resetChainIdentityCache()
  mocks.rate.mockReset().mockResolvedValue({ allowed: true, remaining: 299, resetAt: 1_000 })
  fetchMock.mockReset().mockImplementation(async (_u: string, init?: RequestInit) => {
    const m = JSON.parse(String(init?.body))
    return { ok: true, status: 200, json: async () => (m.method === 'eth_chainId' ? { jsonrpc: '2.0', id: 1, result: '0x1' } : { jsonrpc: '2.0', id: 1, result: '0x1' }) }
  })
})

const units = () => mocks.rate.mock.calls.map((c) => c[3])

describe('POST /api/rpc — rate-limit units', () => {
  it('a single call costs 1 unit (same key, limit, window as before)', async () => {
    expect((await POST(req(call(1)))).status).toBe(200)
    expect(mocks.rate).toHaveBeenCalledTimes(1)
    expect(mocks.rate.mock.calls[0].slice(1)).toEqual([300, 60_000, 1])
    expect(String(mocks.rate.mock.calls[0][0])).toMatch(/^rpc:/)
  })

  it('a 25-call batch costs 25 units, in ONE limiter call, and is forwarded', async () => {
    const res = await POST(req(Array.from({ length: 25 }, (_, i) => call(i))))
    expect(res.status).toBe(200)
    expect(units()).toEqual([25])
    expect(fetchMock.mock.calls.some(([, init]) => Array.isArray(JSON.parse(String((init as RequestInit).body))))).toBe(true)
  })

  it('a 26-call batch is rejected (400), nothing forwarded, charged only the 1 unit it always cost', async () => {
    const res = await POST(req(Array.from({ length: 26 }, (_, i) => call(i))))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe(-32005)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(units()).toEqual([1])
  })

  it('an over-budget batch gets 429 and is not forwarded', async () => {
    mocks.rate.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 5_000 })
    const res = await POST(req(Array.from({ length: 10 }, (_, i) => call(i))))
    expect(res.status).toBe(429)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(units()).toEqual([10])
  })

  it('an empty batch and a non-array body cost 1', async () => {
    await POST(req([]))
    await POST(req(call(1)))
    expect(units()).toEqual([1, 1])
  })

  it('an unparseable body still costs 1 and still ends in the proxy 500', async () => {
    const res = await POST(req(null, '{not json'))
    expect(res.status).toBe(500)
    expect(units()).toEqual([1])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an unparseable body is still rate limited (429 wins over 500)', async () => {
    mocks.rate.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 5_000 })
    expect((await POST(req(null, '{not json'))).status).toBe(429)
  })
})
