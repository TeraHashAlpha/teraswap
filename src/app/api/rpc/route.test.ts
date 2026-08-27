/**
 * [CHORE-API-HARDENING-2 / P3c CONFIRMED] /api/rpc cost policy at the route
 * level: batch-size cap, debug_* / trace_* denial, eth_getLogs range clamping.
 * The blocked-signing-method behaviour is pre-existing and re-asserted here so
 * a future change can't silently regress it alongside the new checks.
 *
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] Plus the chain-identity guard. `/api/rpc` is one of the two
 * places that resolve an upstream, and for three weeks `?chainId=42161` was answered by a Base
 * endpoint with HTTP 200 and a well-formed envelope. The proxy must now prove the upstream IS the
 * chain the caller asked for before it forwards anything to it — and must keep telling an outage
 * apart from that lie.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  resolveProxyChainId: vi.fn<(p: string | null) => { chainId: number } | { error: string }>(),
  getRpcUrlForChain: vi.fn<(c: number) => string>(),
}))

vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 299, resetAt: 1_000 }),
  RPC_RATE_LIMIT: { limit: 300, windowMs: 60_000 },
}))

vi.mock('@/lib/rpc-proxy-chain', () => ({
  resolveProxyChainId: mocks.resolveProxyChainId,
}))

vi.mock('@/lib/adapters/shared', () => ({
  getRpcUrlForChain: mocks.getRpcUrlForChain,
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { POST } from './route'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'

function rpcReq(body: unknown, headers: Record<string, string> = {}, url = 'http://localhost/api/rpc') {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const methodOf = (init: RequestInit | undefined): string => {
  const parsed = JSON.parse(String(init?.body ?? '{}'))
  return Array.isArray(parsed) ? parsed[0]?.method : parsed.method
}

/** Upstream calls that are NOT the identity probe — i.e. the caller's own traffic. */
const forwardedCalls = () =>
  fetchMock.mock.calls.filter(([, init]) => methodOf(init as RequestInit) !== 'eth_chainId')

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

/** What the upstream answers `eth_chainId` with. Default: mainnet, matching the resolved chain. */
let upstreamChainIdHex = '0x1'

beforeEach(() => {
  __resetChainIdentityCache()
  // Fresh console spies per case: vi.spyOn on an already-spied method returns the SAME spy with
  // its call history intact, so without this a later case sees an earlier case's refusals.
  vi.restoreAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.resolveProxyChainId.mockReset().mockReturnValue({ chainId: 1 })
  mocks.getRpcUrlForChain.mockReset().mockReturnValue('http://upstream.test/rpc')
  upstreamChainIdHex = '0x1'
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
    methodOf(init) === 'eth_chainId'
      ? jsonOk({ jsonrpc: '2.0', id: 1, result: upstreamChainIdHex })
      : jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1' }),
  )
})

describe('POST /api/rpc — pre-existing signing-method blacklist (unchanged)', () => {
  it('still rejects eth_sendRawTransaction with 403', async () => {
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x...'] }))
    expect(res.status).toBe(403)
  })

  it('still forwards an ordinary read method (eth_getBlockByNumber)', async () => {
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }))
    expect(res.status).toBe(200)
    expect(forwardedCalls()).toHaveLength(1)
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
    expect(forwardedCalls()).toHaveLength(1)
    const forwardedBody = JSON.parse(forwardedCalls()[0][1].body)
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
    const forwardedBody = JSON.parse(forwardedCalls()[0][1].body)
    expect(forwardedBody.params[0]).toEqual({ fromBlock: '0x1', toBlock: '0x2' })
  })
})

describe('POST /api/rpc — chain-identity guard: MISMATCH fails closed [FIX-RPC-CHAIN-IDENTITY-GUARD]', () => {
  /** Reproduce the incident: ?chainId=42161 resolved to an upstream that is actually Base. */
  function arbitrumUrlServedByBase() {
    mocks.resolveProxyChainId.mockReturnValue({ chainId: 42161 })
    mocks.getRpcUrlForChain.mockReturnValue('http://arbitrum-upstream.test/rpc')
    upstreamChainIdHex = '0x2105' // Base
  }

  it('refuses with 502 instead of answering 200 from the wrong chain', async () => {
    arbitrumUrlServedByBase()

    const res = await POST(
      rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x0', data: '0x95d89b41' }, 'latest'] },
        {}, 'http://localhost/api/rpc?chainId=42161'),
    )

    expect(res.status).toBe(502)
  })

  it('names BOTH chain ids in the error the caller receives', async () => {
    arbitrumUrlServedByBase()

    const res = await POST(
      rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }, {}, 'http://localhost/api/rpc?chainId=42161'),
    )
    const body = await res.json()

    expect(body.error.message).toContain('42161')
    expect(body.error.message).toContain('8453')
  })

  it('never forwards the caller’s request to the endpoint it caught lying', async () => {
    arbitrumUrlServedByBase()

    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }, {}, 'http://localhost/api/rpc?chainId=42161'))

    expect(forwardedCalls()).toHaveLength(0)
    expect(fetchMock.mock.calls.map(([, init]) => methodOf(init as RequestInit))).toEqual(['eth_chainId'])
  })

  it('does not leak the upstream URL (provider keys live in RPC URL paths)', async () => {
    mocks.resolveProxyChainId.mockReturnValue({ chainId: 42161 })
    mocks.getRpcUrlForChain.mockReturnValue('https://arb-mainnet.example.test/v2/SUPERSECRETKEY')
    upstreamChainIdHex = '0x2105'

    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }, {}, 'http://localhost/api/rpc?chainId=42161'))
    const body = await res.json()

    expect(body.error.message).not.toContain('SUPERSECRETKEY')
    expect(body.error.message).not.toContain('arb-mainnet')
  })

  it('shouts — the incident was silent precisely because nothing logged', async () => {
    arbitrumUrlServedByBase()

    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }, {}, 'http://localhost/api/rpc?chainId=42161'))

    expect(console.error).toHaveBeenCalled()
  })

  it('keeps refusing without re-probing while the verdict is cached', async () => {
    arbitrumUrlServedByBase()

    for (let i = 0; i < 4; i++) {
      const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }, {}, 'http://localhost/api/rpc?chainId=42161'))
      expect(res.status).toBe(502)
    }

    expect(fetchMock).toHaveBeenCalledTimes(1) // one probe, then cache
  })
})

describe('POST /api/rpc — chain-identity guard: UNREACHABLE falls through [FIX-RPC-CHAIN-IDENTITY-GUARD]', () => {
  it('still forwards when the probe cannot get an answer (transport reject)', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (methodOf(init) === 'eth_chainId') throw new Error('ECONNRESET')
      return jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1b4' })
    })

    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))

    expect(res.status).toBe(200)
    expect(forwardedCalls()).toHaveLength(1)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('still forwards when the probe gets a 5xx — that is an outage, not a lie', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId'
        ? { ok: false, status: 503, json: async () => ({}) }
        : jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1b4' }),
    )

    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))

    expect(res.status).toBe(200)
    expect(forwardedCalls()).toHaveLength(1)
  })

  it('still forwards when the upstream answers eth_chainId with garbage', async () => {
    upstreamChainIdHex = '0x'

    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))

    expect(res.status).toBe(200)
    expect(forwardedCalls()).toHaveLength(1)
  })

  it('probes at most once per chain per process, not once per request', async () => {
    for (let i = 0; i < 6; i++) {
      await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
    }

    const probes = fetchMock.mock.calls.filter(([, init]) => methodOf(init as RequestInit) === 'eth_chainId')
    expect(probes).toHaveLength(1)
    expect(forwardedCalls()).toHaveLength(6)
  })

  it('verifies each chain separately — a verified mainnet does not vouch for Arbitrum', async () => {
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))

    mocks.resolveProxyChainId.mockReturnValue({ chainId: 42161 })
    mocks.getRpcUrlForChain.mockReturnValue('http://arbitrum-upstream.test/rpc')
    upstreamChainIdHex = '0x2105'

    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }, {}, 'http://localhost/api/rpc?chainId=42161'))
    expect(res.status).toBe(502)
  })
})
