/**
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] The wagmi/viem side of the guard.
 *
 * `wagmiConfig.ts` is the second place that resolves an upstream (the first is `/api/rpc`). Every
 * browser read — the Chainlink feed hook included — goes through a viem transport built there, and
 * during the incident the Arbitrum transport was pointed at a Base endpoint. viem has no opinion
 * about which chain answered: it forwards whatever hex comes back.
 *
 * These tests point one chain's transport at another chain's endpoint and require the guard to
 * fire, and require an UNREACHABLE endpoint NOT to fire it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { guardedHttp } from './rpc-guarded-transport'
import { __resetChainIdentityCache } from './rpc-chain-identity'

const ARBITRUM = 42161
const BASE_CHAIN_ID_HEX = '0x2105' // what the misconfigured endpoint actually answered
const BASE = 8453

const ARBITRUM_URL = 'https://arbitrum-rpc.example.test/v2/key'

/** A JSON-RPC Response viem's http transport will parse (it checks the content type). */
function jsonRpc(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function methodOf(init: RequestInit | undefined): string {
  const parsed = JSON.parse(String(init?.body ?? '{}'))
  return Array.isArray(parsed) ? parsed[0]?.method : parsed.method
}

/** Instantiate the transport the way viem does inside a client. */
function instantiate(url: string, chainId: number) {
  return guardedHttp(url, chainId, { retryCount: 0, timeout: 2_000 })({})
}

beforeEach(() => {
  __resetChainIdentityCache()
  vi.restoreAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  __resetChainIdentityCache()
  vi.unstubAllGlobals()
})

describe('guardedHttp — MISMATCH fails closed', () => {
  it('refuses every read when the Arbitrum-configured URL is served by Base', async () => {
    // The incident, exactly: the URL configured for 42161 answers eth_chainId = 0x2105 (Base),
    // HTTP 200, well-formed envelope — and would happily answer eth_blockNumber too.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId'
        ? jsonRpc({ jsonrpc: '2.0', id: 1, result: BASE_CHAIN_ID_HEX })
        : jsonRpc({ jsonrpc: '2.0', id: 1, result: '0xdeadbeef' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const transport = instantiate(ARBITRUM_URL, ARBITRUM)

    await expect(transport.request({ method: 'eth_blockNumber' })).rejects.toThrow(
      /chain 42161.*chain 8453/s,
    )
  })

  it('names both chain ids on the thrown error object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRpc({ jsonrpc: '2.0', id: 1, result: BASE_CHAIN_ID_HEX })))

    const transport = instantiate(ARBITRUM_URL, ARBITRUM)
    const err = await transport.request({ method: 'eth_blockNumber' }).catch((e: unknown) => e)

    expect((err as { name?: string }).name).toBe('ChainIdentityError')
    expect((err as { expectedChainId?: number }).expectedChainId).toBe(ARBITRUM)
    expect((err as { reportedChainId?: number }).reportedChainId).toBe(BASE)
  })

  it('never passes the lying endpoint’s response through — the read is never sent', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId'
        ? jsonRpc({ jsonrpc: '2.0', id: 1, result: BASE_CHAIN_ID_HEX })
        : jsonRpc({ jsonrpc: '2.0', id: 1, result: '0xdeadbeef' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const transport = instantiate(ARBITRUM_URL, ARBITRUM)
    await transport.request({ method: 'eth_getBalance', params: ['0x0', 'latest'] }).catch(() => {})

    const methodsSent = fetchMock.mock.calls.map(([, init]) => methodOf(init))
    expect(methodsSent).toEqual(['eth_chainId'])
    expect(methodsSent).not.toContain('eth_getBalance')
  })

  it('shouts once, then refuses from cache without re-probing', async () => {
    const fetchMock = vi.fn(async () => jsonRpc({ jsonrpc: '2.0', id: 1, result: BASE_CHAIN_ID_HEX }))
    vi.stubGlobal('fetch', fetchMock)

    const transport = instantiate(ARBITRUM_URL, ARBITRUM)
    for (let i = 0; i < 5; i++) {
      await expect(transport.request({ method: 'eth_blockNumber' })).rejects.toThrow()
    }

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledTimes(1)
  })
})

describe('guardedHttp — UNREACHABLE falls through, it is an outage not a lie', () => {
  it('still serves the read when the identity probe cannot get an answer', async () => {
    // eth_chainId is unanswerable (the classic outage shape) but the node serves reads.
    // Today's behaviour must survive: the guard has proven nothing, so it blocks nothing.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (methodOf(init) === 'eth_chainId') throw new Error('ECONNRESET')
      return jsonRpc({ jsonrpc: '2.0', id: 1, result: '0x1b4' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const transport = instantiate(ARBITRUM_URL, ARBITRUM)

    await expect(transport.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1b4')
  })

  it('does not raise a ChainIdentityError on a 5xx probe', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId'
        ? new Response('upstream down', { status: 503 })
        : jsonRpc({ jsonrpc: '2.0', id: 1, result: '0x1b4' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const transport = instantiate(ARBITRUM_URL, ARBITRUM)

    await expect(transport.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1b4')
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('guardedHttp — a correctly configured endpoint costs one round-trip, once', () => {
  it('probes once and then forwards every read untouched', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId'
        ? jsonRpc({ jsonrpc: '2.0', id: 1, result: '0xa4b1' }) // 42161
        : jsonRpc({ jsonrpc: '2.0', id: 1, result: '0x1b4' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const transport = instantiate(ARBITRUM_URL, ARBITRUM)
    for (let i = 0; i < 4; i++) {
      await expect(transport.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1b4')
    }

    const methodsSent = fetchMock.mock.calls.map(([, init]) => methodOf(init))
    expect(methodsSent.filter((m) => m === 'eth_chainId')).toHaveLength(1)
    expect(methodsSent.filter((m) => m === 'eth_blockNumber')).toHaveLength(4)
    expect(console.error).not.toHaveBeenCalled()
  })
})
