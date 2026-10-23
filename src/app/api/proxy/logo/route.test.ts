/**
 * [fix/functional-chain-ui C8] /api/proxy/logo — Trust Wallet logos fetched server-side. Network
 * mocked: the route must reject anything that is not a registry chain + 0x address BEFORE fetching,
 * only ever fetch the fixed Trust Wallet template, and only pass raster image bytes through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// Stateful stand-in for the sliding-window limiter: counts per key and honours the (limit, window) the
// route passes, so the test proves the route's wiring (key + QUOTE_RATE_LIMIT), not a canned answer.
const hits = new Map<string, number>()
const mockCheckRateLimit = vi.fn(async (key: string, limit: number, _windowMs: number) => {
  const n = (hits.get(key) ?? 0) + 1
  hits.set(key, n)
  return n > limit
    ? { allowed: false, remaining: 0, resetAt: 1_700_000_060_000 }
    : { allowed: true, remaining: limit - n, resetAt: 0 }
})
vi.mock('@/lib/kv-rate-limiter', () => ({
  QUOTE_RATE_LIMIT: { limit: 30, windowMs: 60_000 },
  checkRateLimit: (key: string, limit: number, windowMs: number) => mockCheckRateLimit(key, limit, windowMs),
}))

import { GET } from './route'

const USDC_LC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDC_CS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function req(params: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/proxy/logo?${new URLSearchParams(params)}`, { headers })
}

function upstream(body: BodyInit | null, init: ResponseInit) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  hits.clear()
  mockCheckRateLimit.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/api/proxy/logo — input validation', () => {
  it.each([
    ['not hex', 'usdc'],
    ['too short', '0x1234'],
    ['41 hex chars', `${USDC_LC}0`],
    ['path traversal', '../../../etc/passwd'],
    ['url', 'https://evil.example/logo.png'],
    ['empty', ''],
  ])('rejects a non-address (%s) with 400 and never fetches', async (_label, address) => {
    const fetchMock = upstream(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
    const res = await GET(req({ chainId: '1', address }))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['10', '0', '__proto__', '1e3', '-1', ''])('rejects chainId %j with 400 and never fetches', async (chainId) => {
    const fetchMock = upstream(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
    const res = await GET(req({ chainId, address: USDC_LC }))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('/api/proxy/logo — upstream', () => {
  it.each([
    ['1', 'ethereum'],
    ['8453', 'base'],
    ['42161', 'arbitrum'],
  ])('chainId %s fetches ONLY the fixed Trust Wallet path (folder %s, checksummed address)', async (chainId, folder) => {
    const fetchMock = upstream(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
    const res = await GET(req({ chainId, address: USDC_LC }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/assets/${USDC_CS}/logo.png`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('max-age=86400')
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  it.each([
    ['text/html', '<html>not a logo</html>'],
    ['image/svg+xml', '<svg onload="alert(1)"/>'],
    ['application/octet-stream', 'bytes'],
    ['', 'bytes'],
  ])('refuses a non-raster content-type (%j) with 404', async (contentType, body) => {
    upstream(body, { status: 200, headers: contentType ? { 'Content-Type': contentType } : {} })
    const res = await GET(req({ chainId: '1', address: USDC_LC }))
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
  })

  it('maps an upstream 404 to a cached 404', async () => {
    upstream('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    const res = await GET(req({ chainId: '8453', address: USDC_LC }))
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600')
  })

  it('refuses an oversized body with 404', async () => {
    upstream(new Uint8Array(512 * 1024 + 1), { status: 200, headers: { 'Content-Type': 'image/png' } })
    const res = await GET(req({ chainId: '1', address: USDC_LC }))
    expect(res.status).toBe(404)
  })

  it('maps a network failure to 404, never a 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const res = await GET(req({ chainId: '1', address: USDC_LC }))
    expect(res.status).toBe(404)
  })
})

describe('/api/proxy/logo — per-IP rate limit (same limiter + limit as GET /api/quote)', () => {
  const ip = (addr: string) => ({ 'x-vercel-forwarded-for': addr })

  it('lets 30 requests per IP through, answers the 31st with 429 and does not fetch for it', async () => {
    const fetchMock = upstream(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
    for (let i = 0; i < 30; i++) {
      const ok = await GET(req({ chainId: '1', address: USDC_LC }, ip('198.51.100.9')))
      expect(ok.status).toBe(200)
    }
    expect(fetchMock).toHaveBeenCalledTimes(30)

    const limited = await GET(req({ chainId: '1', address: USDC_LC }, ip('198.51.100.9')))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(limited.headers.get('x-ratelimit-reset')).toBe('1700000060000')
    expect(await limited.json()).toEqual({ error: 'Rate limit exceeded. Try again in a minute.' })
    expect(fetchMock).toHaveBeenCalledTimes(30)
    expect(mockCheckRateLimit).toHaveBeenLastCalledWith('logo:198.51.100.9', 30, 60_000)
  })

  it('never lets a throttled response be cached in place of the logo', async () => {
    upstream(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
    hits.set('logo:198.51.100.9', 30)
    const limited = await GET(req({ chainId: '1', address: USDC_LC }, ip('198.51.100.9')))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('cache-control')).toBe('no-store')
  })

  it('buckets per IP: one caller hitting the limit does not throttle another', async () => {
    upstream(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
    hits.set('logo:198.51.100.9', 30)
    expect((await GET(req({ chainId: '1', address: USDC_LC }, ip('198.51.100.9')))).status).toBe(429)
    expect((await GET(req({ chainId: '1', address: USDC_LC }, ip('203.0.113.5')))).status).toBe(200)
  })

  it('keys on the trusted IP, not a client-written x-forwarded-for token', async () => {
    upstream(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
    await GET(req({ chainId: '1', address: USDC_LC }, { ...ip('198.51.100.9'), 'x-forwarded-for': '6.6.6.6, 198.51.100.9' }))
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('logo:198.51.100.9')
  })

  it('leaves the allowed path untouched: same 200 body and the 24 h public cache headers', async () => {
    upstream(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
    const res = await GET(req({ chainId: '1', address: USDC_LC }, ip('198.51.100.9')))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800')
    expect(res.headers.get('x-ratelimit-remaining')).toBeNull()
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  it('still answers 400 for bad input without spending a fetch (limit check is first, validation second)', async () => {
    const fetchMock = upstream(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
    const res = await GET(req({ chainId: '10', address: USDC_LC }, ip('198.51.100.9')))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
