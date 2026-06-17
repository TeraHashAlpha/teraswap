// @vitest-environment node
/**
 * Unit tests for GET /api/token-logo — the server-side, chainId-aware token logo
 * resolver. The CoinGecko per-chain list is fetched server-side and cached in
 * memory; here `fetch` is stubbed so NO real network is hit.
 *
 * Coverage:
 *   • known address (in the stubbed CoinGecko list) ⇒ 302 to its logoURI with the
 *     long public/s-maxage Cache-Control,
 *   • unknown address ⇒ 302 to the DefiLlama by-address (token-icons.llamao.fi) URL,
 *   • bad chainId ⇒ 400,
 *   • malformed address ⇒ 400,
 *   • a fetch rejection ⇒ STILL 302 to DefiLlama (fail-safe — never 500 on a logo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, __resetTokenLogoCache } from './route'

// A CoinGecko-shaped token in the stubbed per-chain list. Mixed-case address to
// prove the route lower-cases keys before lookup.
const KNOWN_ADDR = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const KNOWN_LOGO = 'https://assets.coingecko.com/x.png'
const UNKNOWN_ADDR = '0xbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

function req(params: Record<string, string>): NextRequest {
  const qs = new URLSearchParams(params).toString()
  return new NextRequest(`http://localhost/api/token-logo?${qs}`)
}

function okList() {
  return {
    ok: true,
    json: async () => ({
      tokens: [{ address: KNOWN_ADDR, symbol: 'X', decimals: 18, logoURI: KNOWN_LOGO }],
    }),
  } as unknown as Response
}

describe('GET /api/token-logo', () => {
  beforeEach(() => {
    __resetTokenLogoCache()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    __resetTokenLogoCache()
  })

  it('302-redirects a known address to its CoinGecko logoURI with a long cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okList()))

    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR }))

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(KNOWN_LOGO)
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toContain('public')
    expect(cc).toContain('s-maxage=86400')
  })

  it('looks up the address case-insensitively (lowercased key)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okList()))

    // Query with the all-lowercase form of a list entry stored mixed-case.
    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR.toLowerCase() }))

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(KNOWN_LOGO)
  })

  it('302-redirects an unknown address to the DefiLlama by-address URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okList()))

    const res = await GET(req({ chainId: '1', address: UNKNOWN_ADDR }))

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `https://token-icons.llamao.fi/icons/tokens/1/${UNKNOWN_ADDR.toLowerCase()}?h=48&w=48`,
    )
  })

  it('honours chainId in the DefiLlama fallback (base = 8453)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okList()))

    const res = await GET(req({ chainId: '8453', address: UNKNOWN_ADDR }))

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `https://token-icons.llamao.fi/icons/tokens/8453/${UNKNOWN_ADDR.toLowerCase()}?h=48&w=48`,
    )
  })

  it('returns 400 for an unsupported chainId', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const res = await GET(req({ chainId: '137', address: KNOWN_ADDR }))

    expect(res.status).toBe(400)
    // Never touched the network for a rejected request.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns 400 for a malformed address', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const res = await GET(req({ chainId: '1', address: '0xnot-an-address' }))

    expect(res.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a prototype-pollution chainId (`__proto__`) with 400, no fetch', async () => {
    // [CodeQL js/remote-property-injection] chainId is validated via literal
    // comparison (platformFor) + the cache is a Map, so a crafted key like
    // '__proto__' can neither pass validation nor write to a prototype property.
    vi.stubGlobal('fetch', vi.fn())

    for (const evil of ['__proto__', 'constructor', 'prototype']) {
      const res = await GET(req({ chainId: evil, address: KNOWN_ADDR }))
      expect(res.status).toBe(400)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('is fail-safe: a fetch rejection still 302-redirects to DefiLlama', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR }))

    // Even though this address IS in the (unreachable) list, we must not 500.
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `https://token-icons.llamao.fi/icons/tokens/1/${KNOWN_ADDR.toLowerCase()}?h=48&w=48`,
    )
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toContain('public')
  })

  it('is fail-safe: a non-ok list response 302-redirects to DefiLlama', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) } as unknown as Response),
    )

    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR }))

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('token-icons.llamao.fi')
  })

  it('caches the per-chain list in memory (fetches once across requests)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okList())
    vi.stubGlobal('fetch', fetchMock)

    await GET(req({ chainId: '1', address: KNOWN_ADDR }))
    await GET(req({ chainId: '1', address: UNKNOWN_ADDR }))

    // Second request reuses the warm in-memory map — only one list fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
