/**
 * [P182] Unit tests for GET /api/portfolio/tokens.
 *
 * Covers every branch of the Alchemy discovery wrapper:
 *   - Param validation (missing, invalid)
 *   - Missing ALCHEMY_API_KEY → 503 with the specific message the hook
 *     watches for to flip to the multicall fallback
 *   - Rate limit 429 with X-RateLimit-* headers
 *   - Empty balance response → { tokens: [] }
 *   - Mixed DEFAULT_TOKENS + unknown → both surfaced, isDefault flag
 *     correctly toggled, metadata for unknowns comes from the
 *     alchemy_getTokenMetadata call
 *   - Metadata RPC failure → deterministic fallback {symbol:slice(0,6),
 *     name:'Unknown Token', decimals:18, logoURI:null}
 *   - Balance API error → 502
 *   - Cap at 200 tokens (extras are dropped)
 *   - Response shape conforms to DiscoveredToken
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockCheckRateLimit = vi.fn().mockResolvedValue({
  allowed: true,
  remaining: 4,
  resetAt: Date.now() + 60_000,
})
vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

import { GET } from './route'
import { PORTFOLIO_SUPPORTED_CHAINS } from '@/lib/portfolio-chains'

// ── Fixtures ─────────────────────────────────────────────

const WALLET = '0x1234567890abcdef1234567890abcdef12345678'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const UNKNOWN = '0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef'

function makeRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/portfolio/tokens${query}`, {
    method: 'GET',
  })
}

interface AlchemyBalance {
  contractAddress: string
  tokenBalance: string | null
}

interface AlchemyMetadata {
  decimals: number | null
  logo: string | null
  name: string | null
  symbol: string | null
}

interface FetchScenario {
  balances?: AlchemyBalance[]
  balancesError?: boolean
  metadataByAddress?: Map<string, AlchemyMetadata>
  // When the address is missing from metadataByAddress and metadataFails is
  // true, the rejected promise is observed by Promise.allSettled and the
  // route falls back to deterministic metadata.
  metadataFails?: boolean
}

function makeFetchMock(scenario: FetchScenario): typeof fetch {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { method: string; params: unknown[] }
    if (body.method === 'alchemy_getTokenBalances') {
      if (scenario.balancesError) {
        return new Response(JSON.stringify({ error: { message: 'upstream down' } }), { status: 200 })
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { address: WALLET, tokenBalances: scenario.balances ?? [] },
        }),
        { status: 200 },
      )
    }
    if (body.method === 'alchemy_getTokenMetadata') {
      const addr = (body.params[0] as string).toLowerCase()
      const meta = scenario.metadataByAddress?.get(addr)
      if (meta) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: meta }), { status: 200 })
      }
      if (scenario.metadataFails) {
        return new Response(JSON.stringify({ error: { message: 'metadata down' } }), { status: 200 })
      }
      // No metadata configured → fallback shape will be used by the route.
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 })
    }
    return new Response('not implemented', { status: 500 })
  }) as unknown as typeof fetch
}

const ORIGINAL_KEY = process.env.ALCHEMY_API_KEY

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: Date.now() + 60_000,
  })
  process.env.ALCHEMY_API_KEY = 'test-key'
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (ORIGINAL_KEY === undefined) delete process.env.ALCHEMY_API_KEY
  else process.env.ALCHEMY_API_KEY = ORIGINAL_KEY
})

// ── Tests ────────────────────────────────────────────────

describe('GET /api/portfolio/tokens', () => {
  it('400s when the address param is missing', async () => {
    const res = await GET(makeRequest(''))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Missing required param/)
  })

  it('400s when the address format is invalid', async () => {
    const res = await GET(makeRequest('?address=not-an-address'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Invalid address/)
  })

  it('503s with the agreed message when ALCHEMY_API_KEY is unset', async () => {
    delete process.env.ALCHEMY_API_KEY
    const res = await GET(makeRequest(`?address=${WALLET}`))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/Configure ALCHEMY_API_KEY/)
  })

  it('429s when the rate limiter blocks the request', async () => {
    const resetAt = Date.now() + 30_000
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt })
    const res = await GET(makeRequest(`?address=${WALLET}`))
    expect(res.status).toBe(429)
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(res.headers.get('x-ratelimit-reset')).toBe(String(resetAt))
  })

  it('returns an empty tokens array when Alchemy reports no balances', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ balances: [] }))
    const res = await GET(makeRequest(`?address=${WALLET}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tokens: unknown[] }
    expect(body.tokens).toEqual([])
    expect(res.headers.get('cache-control')).toContain('s-maxage=30')
  })

  it('returns a mix of DEFAULT and unknown tokens with isDefault flags', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        balances: [
          { contractAddress: USDC, tokenBalance: '0x' + (1_000n * 10n ** 6n).toString(16) }, // 1000 USDC
          { contractAddress: UNKNOWN, tokenBalance: '0x' + (5n * 10n ** 18n).toString(16) }, // 5 unk
        ],
        metadataByAddress: new Map([
          [
            UNKNOWN.toLowerCase(),
            { decimals: 18, logo: 'https://logo/unk.png', name: 'Unk Token', symbol: 'UNK' },
          ],
        ]),
      }),
    )
    const res = await GET(makeRequest(`?address=${WALLET}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tokens: Array<{ symbol: string; isDefault: boolean; balance: string; address: string }> }
    expect(body.tokens).toHaveLength(2)
    const usdcRow = body.tokens.find((t) => t.address === USDC.toLowerCase())!
    expect(usdcRow.isDefault).toBe(true)
    expect(usdcRow.symbol).toBe('USDC')
    expect(usdcRow.balance).toBe(String(1_000n * 10n ** 6n))
    const unkRow = body.tokens.find((t) => t.address === UNKNOWN.toLowerCase())!
    expect(unkRow.isDefault).toBe(false)
    expect(unkRow.symbol).toBe('UNK')
    expect(unkRow.balance).toBe(String(5n * 10n ** 18n))
  })

  it("falls back to deterministic metadata when alchemy_getTokenMetadata fails", async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        balances: [
          { contractAddress: UNKNOWN, tokenBalance: '0x' + (1n * 10n ** 18n).toString(16) },
        ],
        metadataFails: true,
      }),
    )
    const res = await GET(makeRequest(`?address=${WALLET}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tokens: Array<{ symbol: string; name: string; decimals: number; logoURI: string | null; isDefault: boolean }> }
    expect(body.tokens).toHaveLength(1)
    const fallback = body.tokens[0]
    expect(fallback.isDefault).toBe(false)
    expect(fallback.symbol).toBe(UNKNOWN.slice(0, 6).toLowerCase())
    expect(fallback.name).toBe('Unknown Token')
    expect(fallback.decimals).toBe(18)
    expect(fallback.logoURI).toBeNull()
  })

  it('502s when the Alchemy balances RPC reports an error', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ balancesError: true }))
    const res = await GET(makeRequest(`?address=${WALLET}`))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/temporarily unavailable/)
  })

  it('caps the response at 200 tokens even if Alchemy returns more', async () => {
    const many: AlchemyBalance[] = []
    for (let i = 0; i < 250; i++) {
      const hex = (i + 1).toString(16).padStart(40, '0')
      many.push({ contractAddress: `0x${hex}`, tokenBalance: '0x1' })
    }
    vi.stubGlobal('fetch', makeFetchMock({ balances: many, metadataFails: true }))
    const res = await GET(makeRequest(`?address=${WALLET}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tokens: unknown[] }
    expect(body.tokens).toHaveLength(200)
  })

  it('produces a response that conforms to the DiscoveredToken shape', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        balances: [{ contractAddress: USDC, tokenBalance: '0x10' }],
      }),
    )
    const res = await GET(makeRequest(`?address=${WALLET}`))
    const body = (await res.json()) as { tokens: Array<Record<string, unknown>> }
    expect(body.tokens).toHaveLength(1)
    const row = body.tokens[0]
    expect(typeof row.address).toBe('string')
    expect(typeof row.symbol).toBe('string')
    expect(typeof row.name).toBe('string')
    expect(typeof row.decimals).toBe('number')
    expect(typeof row.balance).toBe('string')
    expect(typeof row.isDefault).toBe('boolean')
    expect(row.logoURI === null || typeof row.logoURI === 'string').toBe(true)
  })

  it('filters out zero balances before metadata resolution', async () => {
    const metadataSpy = vi.fn()
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { method: string }
      if (body.method === 'alchemy_getTokenBalances') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              address: WALLET,
              tokenBalances: [
                { contractAddress: UNKNOWN, tokenBalance: '0x0' },
                { contractAddress: USDC, tokenBalance: '0x10' },
              ],
            },
          }),
          { status: 200 },
        )
      }
      if (body.method === 'alchemy_getTokenMetadata') {
        metadataSpy()
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 })
      }
      return new Response('', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const res = await GET(makeRequest(`?address=${WALLET}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tokens: Array<{ address: string }> }
    expect(body.tokens).toHaveLength(1)
    expect(body.tokens[0].address).toBe(USDC.toLowerCase())
    // USDC is in DEFAULT_TOKENS → metadata RPC should never have fired.
    expect(metadataSpy).not.toHaveBeenCalled()
  })
})

// ── [E-3] per-chain Alchemy discovery ────────────────────────────────────────

describe('GET /api/portfolio/tokens — chain-aware discovery [E-3]', () => {
  function captureUrlMock(scenario: FetchScenario): { mock: typeof fetch; urls: string[] } {
    const urls: string[] = []
    const inner = makeFetchMock(scenario)
    const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url))
      return (inner as unknown as (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch
    return { mock, urls }
  }

  it('defaults to the mainnet Alchemy endpoint when chainId is absent (byte-identical pin)', async () => {
    const { mock, urls } = captureUrlMock({ balances: [] })
    vi.stubGlobal('fetch', mock)
    const res = await GET(makeRequest(`?address=${WALLET}`))
    expect(res.status).toBe(200)
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(u).toContain('https://eth-mainnet.g.alchemy.com/v2')
  })

  it('uses the Base Alchemy endpoint for chainId=8453', async () => {
    const { mock, urls } = captureUrlMock({ balances: [] })
    vi.stubGlobal('fetch', mock)
    const res = await GET(makeRequest(`?address=${WALLET}&chainId=8453`))
    expect(res.status).toBe(200)
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(u).toContain('https://base-mainnet.g.alchemy.com/v2')
  })


  it('[CHORE-POLISH-3 P2] accepts exactly the shared PORTFOLIO_SUPPORTED_CHAINS set', async () => {
    // Parameterized over the SHARED allowlist module — the same constant the
    // prices route pins against, so the two routes can never drift apart.
    vi.stubGlobal('fetch', makeFetchMock({ balances: [] }))
    for (const chainId of PORTFOLIO_SUPPORTED_CHAINS) {
      const res = await GET(makeRequest(`?address=${WALLET}&chainId=${chainId}`))
      expect(res.status).toBe(200)
    }
    // A real chain outside the set (Arbitrum) is rejected before any upstream call.
    const res = await GET(makeRequest(`?address=${WALLET}&chainId=42161`))
    expect(res.status).toBe(400)
  })

  it('rejects an unsupported chainId with 400 JSON', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ balances: [] }))
    const res = await GET(makeRequest(`?address=${WALLET}&chainId=999999`))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/chain/i)
  })

  it('curates isDefault from the BASE token list on chainId=8453 (not the mainnet list)', async () => {
    // Base USDC (native Circle deployment) — in the Base curated catalog, NOT in
    // mainnet DEFAULT_TOKENS. Discovery on 8453 must flag it isDefault: true.
    const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    vi.stubGlobal('fetch', makeFetchMock({
      balances: [{ contractAddress: BASE_USDC, tokenBalance: '0x0de0b6b3a7640000' }],
    }))
    const res = await GET(makeRequest(`?address=${WALLET}&chainId=8453`))
    expect(res.status).toBe(200)
    const body = await res.json() as { tokens: Array<{ address: string; isDefault: boolean; symbol: string }> }
    const usdc = body.tokens.find(t => t.address.toLowerCase() === BASE_USDC.toLowerCase())
    expect(usdc).toBeTruthy()
    expect(usdc!.isDefault).toBe(true)
    expect(usdc!.symbol).toBe('USDC')
  })
})
