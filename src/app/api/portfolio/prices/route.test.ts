/**
 * [P168] Unit tests for GET /api/portfolio/prices.
 *
 * Covers:
 *   - happy path: returns lower-cased addresses → number map
 *   - body validation: missing tokens, empty tokens, too many tokens, bad address
 *   - rate limiter triggers 429 with X-RateLimit-* headers
 *   - DefiLlama failure degrades to { prices: {} } (never 500)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks (hoisted before route import) ─────────────────

const mockCheckRateLimit = vi.fn().mockResolvedValue({
  allowed: true,
  remaining: 9,
  resetAt: Date.now() + 60_000,
})
vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

const mockFetchDefiLlamaPrices = vi.fn()
vi.mock('@/lib/defillama', () => ({
  fetchDefiLlamaPrices: (...args: unknown[]) => mockFetchDefiLlamaPrices(...args),
}))

// ── Import route after mocks ─────────────────────────────

import { GET } from './route'

// ── Fixtures ─────────────────────────────────────────────

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

function makeRequest(query: string, headers: Record<string, string> = {}): NextRequest {
  const url = `http://localhost/api/portfolio/prices${query}`
  return new NextRequest(url, { method: 'GET', headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 60_000,
  })
  mockFetchDefiLlamaPrices.mockResolvedValue(new Map())
})

describe('GET /api/portfolio/prices', () => {
  it('returns lowercase address → number map for valid input', async () => {
    mockFetchDefiLlamaPrices.mockResolvedValueOnce(
      new Map([
        [USDC.toLowerCase(), { price: 1.0, symbol: 'USDC', timestamp: 0, confidence: 1 }],
        [WETH.toLowerCase(), { price: 3450, symbol: 'WETH', timestamp: 0, confidence: 1 }],
      ]),
    )
    const res = await GET(makeRequest(`?tokens=${USDC},${WETH}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { prices: Record<string, number> }
    expect(body.prices[USDC.toLowerCase()]).toBe(1.0)
    expect(body.prices[WETH.toLowerCase()]).toBe(3450)
    expect(res.headers.get('cache-control')).toContain('s-maxage=60')
  })

  it('400s when tokens param is missing', async () => {
    const res = await GET(makeRequest(''))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Missing required param: tokens/)
    expect(mockFetchDefiLlamaPrices).not.toHaveBeenCalled()
  })

  it('400s when tokens param is empty / only commas', async () => {
    const res = await GET(makeRequest('?tokens=,,'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/at least one address/)
    expect(mockFetchDefiLlamaPrices).not.toHaveBeenCalled()
  })

  it('400s when any token is not a valid address', async () => {
    const res = await GET(makeRequest(`?tokens=${USDC},not-an-address`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Invalid token address format/)
    expect(mockFetchDefiLlamaPrices).not.toHaveBeenCalled()
  })

  it('400s when more than 100 addresses are supplied', async () => {
    // 101 distinct addresses
    const tokens = Array.from({ length: 101 }, (_, i) => {
      const hex = (i + 1).toString(16).padStart(40, '0')
      return `0x${hex}`
    }).join(',')
    const res = await GET(makeRequest(`?tokens=${tokens}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Too many tokens/)
    expect(mockFetchDefiLlamaPrices).not.toHaveBeenCalled()
  })

  it('429s when the rate limiter blocks the request', async () => {
    const resetAt = Date.now() + 30_000
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt,
    })
    const res = await GET(makeRequest(`?tokens=${USDC}`))
    expect(res.status).toBe(429)
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(res.headers.get('x-ratelimit-reset')).toBe(String(resetAt))
    expect(mockFetchDefiLlamaPrices).not.toHaveBeenCalled()
  })

  it('degrades to empty prices when DefiLlama throws', async () => {
    mockFetchDefiLlamaPrices.mockRejectedValueOnce(new Error('upstream timeout'))
    const res = await GET(makeRequest(`?tokens=${USDC}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { prices: Record<string, number> }
    expect(body.prices).toEqual({})
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('de-duplicates lower-cased addresses before calling DefiLlama', async () => {
    mockFetchDefiLlamaPrices.mockResolvedValueOnce(new Map())
    await GET(makeRequest(`?tokens=${USDC},${USDC.toLowerCase()},${WETH}`))
    expect(mockFetchDefiLlamaPrices).toHaveBeenCalledTimes(1)
    const [addresses, chain] = mockFetchDefiLlamaPrices.mock.calls[0]
    expect(chain).toBe('ethereum')
    expect((addresses as string[]).length).toBe(2)
    expect(addresses).toEqual(expect.arrayContaining([USDC.toLowerCase(), WETH.toLowerCase()]))
  })
})
