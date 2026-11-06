/**
 * [CHORE-API-HARDENING-2 / P3c CONFIRMED] /api/rpc cost policy at the route
 * level: batch-size cap, debug_* / trace_* denial (and, since A76 S-3, caller-sized reads refused and the
 * upstream bounded at 10 s / 4 MB — the eth_getLogs range clamp is retired with eth_getLogs).
 * The blocked-signing-method behaviour is pre-existing and re-asserted here so
 * a future change can't silently regress it alongside the new checks.
 *
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] Plus the chain-identity guard. `/api/rpc` is one of the two
 * places that resolve an upstream, and for three weeks `?chainId=42161` was answered by a Base
 * endpoint with HTTP 200 and a well-formed envelope. The proxy must now prove the upstream IS the
 * chain the caller asked for before it forwards anything to it — and must keep telling an outage
 * apart from that lie.
 *
 * [fix/user-ip-privacy] The proxy now carries Base and Arbitrum reads too: its upstream is the server
 * resolver (`serverRpcUrl`), a method must be on the resolved chain's read allow-list, and a lone
 * eth_chainId / eth_blockNumber is answered from a 1.5 s cache (after the identity guard and the rate
 * limit). The cache is reset before every case so the pre-existing assertions still see the upstream.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  resolveProxyChainId: vi.fn<(p: string | null) => { chainId: number } | { error: string }>(),
  // [fix/user-ip-privacy] The route's upstream resolver is rpc-env's `serverRpcUrl` (was
  // adapters/shared `getRpcUrlForChain`). The mock keeps its old name so the cases below read the same.
  getRpcUrlForChain: vi.fn<(c: number) => string>(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: mocks.checkRateLimit,
  // [A76 S-5] the route calls the bounded variant; same arguments, same answer shape.
  checkRateLimitWithin: mocks.checkRateLimit,
  RPC_RATE_LIMIT: { limit: 300, windowMs: 60_000 },
}))

vi.mock('@/lib/rpc-proxy-chain', () => ({
  resolveProxyChainId: mocks.resolveProxyChainId,
}))

vi.mock('@/lib/rpc-env', () => ({
  serverRpcUrl: mocks.getRpcUrlForChain,
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { POST } from './route'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'
import { __resetRpcShortCache, RPC_SHORT_CACHE_TTL_MS } from '@/lib/rpc-short-cache'
import { allowedReadMethods } from '@/lib/rpc-method-policy'

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

// [A76 S-3] Real Responses: the route reads the upstream body as a byte-capped stream, not via `.json()`.
const jsonOk = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** What the upstream answers `eth_chainId` with. Default: mainnet, matching the resolved chain. */
let upstreamChainIdHex = '0x1'

beforeEach(() => {
  __resetChainIdentityCache()
  __resetRpcShortCache()
  // Fresh console spies per case: vi.spyOn on an already-spied method returns the SAME spy with
  // its call history intact, so without this a later case sees an earlier case's refusals.
  vi.restoreAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 299, resetAt: 1_000 })
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

// [fix/user-ip-privacy A76 S-7] JSON-RPC 2.0 §6: an empty batch is one Invalid Request error with id null. It used to be
// forwarded upstream as `[]` (after the identity probe).
describe('POST /api/rpc — empty batch [A76 S-7]', () => {
  it('answers -32600 (id null, 400) and forwards nothing — not even the identity probe', async () => {
    const res = await POST(rpcReq([]))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: empty batch' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is still charged one rate-limit unit, like any other refused body', async () => {
    await POST(rpcReq([]))
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1)
    expect(mocks.checkRateLimit.mock.calls[0][3]).toBe(1)
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

// [fix/user-ip-privacy A76 S-3] Replaces "eth_getLogs range clamped, not rejected (P3c)": eth_getLogs, eth_simulateV1,
// eth_getProof and eth_createAccessList are off every chain's allow-list (no browser path sends them; the audit pulled a
// 12 MB eth_getLogs through a tag range the clamp could not bound). The upstream is bounded in time and in size.
describe('POST /api/rpc — caller-sized reads refused, upstream bounded [A76 S-3]', () => {
  it.each(['eth_getLogs', 'eth_simulateV1', 'eth_getProof', 'eth_createAccessList'])('%s is refused with 403 on every chain and nothing is forwarded', async (method) => {
    for (const chainId of [1, 8453, 42161]) {
      mocks.resolveProxyChainId.mockReturnValue({ chainId })
      upstreamChainIdHex = `0x${chainId.toString(16)}`
      fetchMock.mockClear()
      const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method, params: [{ fromBlock: 'earliest', toBlock: 'latest' }] }, {}, `http://localhost/api/rpc?chainId=${chainId}`))
      expect([chainId, res.status]).toEqual([chainId, 403])
      expect((await res.json()).error.code).toBe(-32601)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('the forward carries AbortSignal.timeout(10_000); a stalled upstream is a 504 with no upstream URL in it', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (methodOf(init) === 'eth_chainId') return jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1' })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      throw Object.assign(new Error('The operation was aborted due to timeout http://upstream.test/rpc'), { name: 'TimeoutError' })
    })
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0x' + '1'.repeat(40), 'latest'] }))
    expect(timeoutSpy).toHaveBeenCalledWith(10_000)
    expect(res.status).toBe(504)
    const text = await res.text()
    expect(text).not.toContain('upstream.test')
    expect(JSON.parse(text).error.message).toBe('Upstream RPC did not answer in time')
  })

  it('a body that stalls mid-read (timeout while streaming) is a 504 too', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (methodOf(init) === 'eth_chainId') return jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1' })
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'))
        },
        pull() {
          throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
        },
      })
      return new Response(stream, { status: 200 })
    })
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest'] }))
    expect(res.status).toBe(504)
  })

  it('an answer over 4 MB (chunked, no content-length) is a 502 and is not read to the end', async () => {
    let pulled = 0
    const chunk = new Uint8Array(256 * 1024).fill(0x20)
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (methodOf(init) === 'eth_chainId') return jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1' })
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += chunk.byteLength
            if (pulled > 48 * 1024 * 1024) controller.close()
            else controller.enqueue(chunk)
          },
        }),
        { status: 200 },
      )
    })
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest'] }))
    expect(res.status).toBe(502)
    expect((await res.json()).error.message).toBe('Upstream RPC response too large')
    expect(pulled).toBeLessThan(4 * 1024 * 1024 + 3 * chunk.byteLength)
  })

  it('a declared content-length over 4 MB is a 502 before any read', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId'
        ? jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1' })
        : new Response('{}', { status: 200, headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
    )
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0x' + '1'.repeat(40), 'latest'] }))
    expect(res.status).toBe(502)
  })

  it('exactly 4 MB still passes', async () => {
    const result = '0x' + 'a'.repeat(4 * 1024 * 1024 - 64)
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result })
    expect(body.length).toBeLessThanOrEqual(4 * 1024 * 1024)
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId' ? jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1' }) : new Response(body, { status: 200 }),
    )
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest'] }))
    expect(res.status).toBe(200)
    expect((await res.json()).result).toHaveLength(result.length)
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
        ? new Response('{}', { status: 503 })
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
    // eth_gasPrice, not eth_blockNumber: the latter is now answered from the 1.5 s cache, and this
    // case is about the PROBE count while every request still reaches the upstream.
    for (let i = 0; i < 6; i++) {
      await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice' }))
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

describe('POST /api/rpc — upstream is the SERVER resolver for every chain [fix/user-ip-privacy]', () => {
  it.each([
    [1, 'http://localhost/api/rpc', '0x1'],
    [8453, 'http://localhost/api/rpc?chainId=8453', '0x2105'],
    [42161, 'http://localhost/api/rpc?chainId=42161', '0xa4b1'],
  ])('chain %i: forwards to serverRpcUrl(%i), never a URL the browser holds', async (chainId, url, chainHex) => {
    mocks.resolveProxyChainId.mockReturnValue({ chainId })
    mocks.getRpcUrlForChain.mockImplementation((c: number) => `http://server-upstream-${c}.test/rpc`)
    upstreamChainIdHex = chainHex

    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 7, method: 'eth_getBalance', params: ['0x0', 'latest'] }, {}, url))

    expect(res.status).toBe(200)
    expect(mocks.getRpcUrlForChain).toHaveBeenCalledWith(chainId)
    expect(forwardedCalls()).toHaveLength(1)
    expect(forwardedCalls()[0][0]).toBe(`http://server-upstream-${chainId}.test/rpc`)
  })

  it('the route source reads no NEXT_PUBLIC_* env and no registry RPC value', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, 'route.ts'), 'utf8')
    expect(src).toMatch(/serverRpcUrl\(chainId\)/)
    expect(src).not.toMatch(/process\.env/)
    expect(src).not.toMatch(/getRpcUrlForChain|rpc\.primary|browserRpc/)
  })
})

describe('POST /api/rpc — per-chain read-only allow-list [fix/user-ip-privacy]', () => {
  const onChain = (chainId: number) => {
    mocks.resolveProxyChainId.mockReturnValue({ chainId })
    upstreamChainIdHex = `0x${chainId.toString(16)}`
    return chainId === 1 ? 'http://localhost/api/rpc' : `http://localhost/api/rpc?chainId=${chainId}`
  }

  it.each([1, 8453, 42161])('chain %i: every listed method is forwarded', async (chainId) => {
    const url = onChain(chainId)
    for (const method of allowedReadMethods(chainId)) {
      __resetRpcShortCache()
      fetchMock.mockClear()
      const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method, params: [] }, {}, url))
      expect([method, res.status]).toEqual([method, 200])
      expect(fetchMock.mock.calls.some(([, init]) => methodOf(init as RequestInit) === method)).toBe(true)
    }
  })

  it.each([
    'eth_newFilter',
    'eth_newBlockFilter',
    'eth_getFilterChanges',
    'eth_getFilterLogs',
    'eth_uninstallFilter',
    'eth_subscribe',
    'eth_accounts',
    'eth_requestAccounts',
    'eth_sendUserOperation',
    'eth_sendRawTransactionConditional',
    'admin_peers',
    'txpool_content',
    'miner_start',
    'engine_newPayloadV3',
    'anvil_setBalance',
    'alchemy_getTokenBalances',
    'made_up_method',
    'ETH_CALL',
    ' eth_call',
  ])('refuses %s on every chain with 403 and forwards nothing', async (method) => {
    for (const chainId of [1, 8453, 42161]) {
      const url = onChain(chainId)
      __resetChainIdentityCache()
      fetchMock.mockClear()
      const res = await POST(rpcReq({ jsonrpc: '2.0', id: 9, method, params: [] }, {}, url))
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe(-32601)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('still refuses every signing / broadcast method (none of them is on any list)', async () => {
    const SIGNING = [
      'eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_signTransaction', 'eth_signTypedData',
      'eth_signTypedData_v3', 'eth_signTypedData_v4', 'personal_sign', 'wallet_addEthereumChain',
      'wallet_switchEthereumChain', 'wallet_requestPermissions', 'wallet_watchAsset', 'wallet_sendCalls',
    ]
    for (const chainId of [1, 8453, 42161]) {
      const url = onChain(chainId)
      for (const method of SIGNING) {
        expect(allowedReadMethods(chainId)).not.toContain(method)
        const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method, params: [] }, {}, url))
        expect([method, res.status]).toEqual([method, 403])
      }
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is PER CHAIN: eth_blobBaseFee is relayed on Ethereum and refused on Base and Arbitrum', async () => {
    expect((await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blobBaseFee' }, {}, onChain(1)))).status).toBe(200)
    expect((await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blobBaseFee' }, {}, onChain(8453)))).status).toBe(403)
    expect((await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blobBaseFee' }, {}, onChain(42161)))).status).toBe(403)
  })

  it('one unlisted method refuses the whole batch — nothing is forwarded', async () => {
    const res = await POST(
      rpcReq([
        { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' },
        { jsonrpc: '2.0', id: 2, method: 'eth_newFilter', params: [{}] },
      ]),
    )
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the refusal names the chain and does not echo the caller-supplied method', async () => {
    const method = `eth_${'x'.repeat(5_000)}`
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method }, {}, onChain(8453)))
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body.error.message).toBe('Method not on the read allow-list for chain 8453')
    expect(JSON.stringify(body)).not.toContain('xxxx')
  })

  it('a null batch entry is a 400, not a crash', async () => {
    const res = await POST(rpcReq([null]))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/rpc — 1.5 s cache for eth_chainId / eth_blockNumber [fix/user-ip-privacy]', () => {
  const blockNumberCalls = () =>
    fetchMock.mock.calls.filter(([, init]) => methodOf(init as RequestInit) === 'eth_blockNumber')

  it('answers a repeated eth_blockNumber from the cache, echoing each caller’s id', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId'
        ? jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1' })
        : jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1675e2e' }),
    )

    const first = await POST(rpcReq({ jsonrpc: '2.0', id: 11, method: 'eth_blockNumber' }))
    const second = await POST(rpcReq({ jsonrpc: '2.0', id: 'abc', method: 'eth_blockNumber', params: [] }))

    expect(await first.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x1675e2e' }) // upstream body, verbatim
    expect(await second.json()).toEqual({ jsonrpc: '2.0', id: 'abc', result: '0x1675e2e' })
    expect(second.headers.get('cache-control')).toBe('no-store')
    expect(blockNumberCalls()).toHaveLength(1)
  })

  it('asks the upstream again once the entry is older than the TTL', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    try {
      expect(RPC_SHORT_CACHE_TTL_MS).toBeGreaterThanOrEqual(1_000)
      expect(RPC_SHORT_CACHE_TTL_MS).toBeLessThanOrEqual(2_000)
      await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
      vi.setSystemTime(1_700_000_000_000 + RPC_SHORT_CACHE_TTL_MS - 1)
      await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
      expect(blockNumberCalls()).toHaveLength(1)
      vi.setSystemTime(1_700_000_000_000 + RPC_SHORT_CACHE_TTL_MS)
      await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
      expect(blockNumberCalls()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a cached answer is still charged against the rate limit, and a limited caller still gets 429', async () => {
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(2)

    mocks.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 2_000 })
    const limited = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
    expect(limited.status).toBe(429)
  })

  it('keeps chains apart: a mainnet block number is never served for Base', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const base = String(url).includes('base')
      if (methodOf(init) === 'eth_chainId') return jsonOk({ jsonrpc: '2.0', id: 1, result: base ? '0x2105' : '0x1' })
      return jsonOk({ jsonrpc: '2.0', id: 1, result: base ? '0xbbb' : '0xaaa' })
    })
    mocks.getRpcUrlForChain.mockImplementation((c: number) => (c === 8453 ? 'http://base-upstream.test/rpc' : 'http://upstream.test/rpc'))

    const main = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
    mocks.resolveProxyChainId.mockReturnValue({ chainId: 8453 })
    const base = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }, {}, 'http://localhost/api/rpc?chainId=8453'))

    expect((await main.json()).result).toBe('0xaaa')
    expect((await base.json()).result).toBe('0xbbb')
  })

  it('serves a repeated eth_chainId from the cache too (the answer is the UPSTREAM’s, not a constant)', async () => {
    const a = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }))
    const b = await POST(rpcReq({ jsonrpc: '2.0', id: 2, method: 'eth_chainId' }))
    expect((await a.json()).result).toBe('0x1')
    expect(await b.json()).toEqual({ jsonrpc: '2.0', id: 2, result: '0x1' })
    // one identity probe + one forwarded eth_chainId; the second request added nothing
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never serves a chain whose upstream lies, even with a warm cache for that chain id', async () => {
    mocks.resolveProxyChainId.mockReturnValue({ chainId: 42161 })
    upstreamChainIdHex = '0xa4b1'
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }, {}, 'http://localhost/api/rpc?chainId=42161'))

    __resetChainIdentityCache() // a new instance verdict: the upstream now answers for Base
    upstreamChainIdHex = '0x2105'
    const res = await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }, {}, 'http://localhost/api/rpc?chainId=42161'))
    expect(res.status).toBe(502)
  })

  it('does not cache an upstream error, a non-hex result, or a call with params', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId'
        ? jsonOk({ jsonrpc: '2.0', id: 1, result: '0x1' })
        : jsonOk({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'upstream busy' } }),
    )
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
    expect(blockNumberCalls()).toHaveLength(2)

    fetchMock.mockClear()
    fetchMock.mockImplementation(async () => jsonOk({ jsonrpc: '2.0', id: 1, result: null }))
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))
    expect(blockNumberCalls()).toHaveLength(2)

    fetchMock.mockClear()
    fetchMock.mockImplementation(async () => jsonOk({ jsonrpc: '2.0', id: 1, result: '0x10' }))
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: ['unexpected'] }))
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: ['unexpected'] }))
    expect(blockNumberCalls()).toHaveLength(2)
  })

  it('forwards a batch untouched, even one made only of cacheable calls', async () => {
    await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' })) // warm
    fetchMock.mockClear()
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' },
      { jsonrpc: '2.0', id: 2, method: 'eth_chainId' },
    ]
    const res = await POST(rpcReq(batch))
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(batch)
  })

  it('does not cache any other read (eth_getBalance is forwarded every time)', async () => {
    for (let i = 0; i < 3; i++) await POST(rpcReq({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0x0', 'latest'] }))
    expect(forwardedCalls()).toHaveLength(3)
  })
})
