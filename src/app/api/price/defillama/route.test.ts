/**
 * [fix/functional-chain-ui C8] /api/price/defillama — the browser's DefiLlama lookup, run
 * server-side. DefiLlama and the rate limiter are mocked: the route must reject anything that is not
 * a registry chain + 0x address, pass the registry slug through, and cache the answer for 30 s.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockFetchDefiLlamaPrice = vi.fn()
vi.mock('@/lib/defillama', () => ({
  fetchDefiLlamaPrice: (...args: unknown[]) => mockFetchDefiLlamaPrice(...args),
}))
const mockCheckRateLimit = vi.fn()
vi.mock('@/lib/kv-rate-limiter', () => ({
  QUOTE_RATE_LIMIT: { limit: 30, windowMs: 60_000 },
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

import { GET } from './route'

const UNI_BASE = '0xc3De830EA07524a0761646a6a4e4be0e114a3C83'
const PRICE = { price: 7.557, symbol: 'UNI', timestamp: 1, confidence: 0.99 }

function req(params: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost/api/price/defillama?${new URLSearchParams(params)}`, {
    headers: { 'x-forwarded-for': '203.0.113.7' },
  })
}

beforeEach(() => {
  mockFetchDefiLlamaPrice.mockReset()
  mockFetchDefiLlamaPrice.mockResolvedValue(PRICE)
  mockCheckRateLimit.mockReset()
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: 0 })
})

describe('/api/price/defillama — input validation', () => {
  it.each([
    ['not hex', 'uni'],
    ['too short', '0x1234'],
    ['41 hex chars', `${UNI_BASE}0`],
    ['DefiLlama key injection', `${UNI_BASE},ethereum:0xdead`],
    ['empty', ''],
  ])('rejects a non-address (%s) with 400 and never asks DefiLlama', async (_label, address) => {
    const res = await GET(req({ chainId: '8453', address }))
    expect(res.status).toBe(400)
    expect(mockFetchDefiLlamaPrice).not.toHaveBeenCalled()
  })

  it.each(['10', '0', '__proto__', '1e3', ''])('rejects chainId %j with 400 and never asks DefiLlama', async (chainId) => {
    const res = await GET(req({ chainId, address: UNI_BASE }))
    expect(res.status).toBe(400)
    expect(mockFetchDefiLlamaPrice).not.toHaveBeenCalled()
  })
})

describe('/api/price/defillama — lookup', () => {
  it.each([
    ['1', 'ethereum'],
    ['8453', 'base'],
    ['42161', 'arbitrum'],
  ])('chainId %s looks the address up under the registry slug %s, cached 30 s', async (chainId, slug) => {
    const res = await GET(req({ chainId, address: UNI_BASE }))

    expect(mockFetchDefiLlamaPrice).toHaveBeenCalledWith(UNI_BASE, slug)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ price: PRICE })
    expect(res.headers.get('cache-control')).toContain('s-maxage=30')
    expect(res.headers.get('cache-control')).toContain('max-age=30')
  })

  it('returns { price: null } when DefiLlama has no usable price (unchanged client contract)', async () => {
    mockFetchDefiLlamaPrice.mockResolvedValue(null)
    const res = await GET(req({ chainId: '8453', address: UNI_BASE }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ price: null })
  })

  it('answers 429 past the per-IP limit, keyed by the caller IP, without asking DefiLlama', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 123 })
    const res = await GET(req({ chainId: '8453', address: UNI_BASE }))
    expect(res.status).toBe(429)
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('defillama-price:203.0.113.7')
    expect(mockFetchDefiLlamaPrice).not.toHaveBeenCalled()
  })

  it('429 is no-store with the standard headers; the limit is the shared QUOTE_RATE_LIMIT', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 123 })
    const res = await GET(req({ chainId: '8453', address: UNI_BASE }))
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(res.headers.get('x-ratelimit-reset')).toBe('123')
    expect(mockCheckRateLimit).toHaveBeenCalledWith('defillama-price:203.0.113.7', 30, 60_000)
  })

  it('keys on the trusted IP, not a client-written x-forwarded-for token', async () => {
    const spoofed = new NextRequest(`http://localhost/api/price/defillama?chainId=8453&address=${UNI_BASE}`, {
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7', 'x-vercel-forwarded-for': '198.51.100.9' },
    })
    await GET(spoofed)
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('defillama-price:198.51.100.9')
  })

  it('N+1 requests from one IP: the allowed path keeps its 30 s cache, the (N+1)th is 429', async () => {
    const seen = new Map<string, number>()
    mockCheckRateLimit.mockImplementation(async (key: string, limit: number) => {
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      return { allowed: n <= limit, remaining: Math.max(0, limit - n), resetAt: 123 }
    })
    for (let i = 0; i < 30; i++) {
      const ok = await GET(req({ chainId: '8453', address: UNI_BASE }))
      expect(ok.status).toBe(200)
      expect(ok.headers.get('cache-control')).toContain('s-maxage=30')
    }
    expect((await GET(req({ chainId: '8453', address: UNI_BASE }))).status).toBe(429)
    expect(mockFetchDefiLlamaPrice).toHaveBeenCalledTimes(30)
  })
})
