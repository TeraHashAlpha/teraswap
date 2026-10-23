// @vitest-environment node
/**
 * Unit tests for GET /api/token-logo — the server-side, chainId-aware token logo
 * resolver. `fetch` is stubbed so NO real network is hit; the stub answers the CoinGecko
 * per-chain list (JSON) and every image request (PNG bytes) by URL.
 *
 * [fix/functional-chain-ui C8] The route used to 302 the browser to CoinGecko / DefiLlama
 * (leaking the visitor's IP). It now fetches the image itself and streams it back:
 *   • every successful response is a 200 image body — never a 3xx, never a `Location`,
 *   • only allow-listed hosts are ever fetched (the list's logoURI is upstream data),
 *   • a dead / non-image / oversized source falls through to the next one, then to a 404.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, __resetTokenLogoCache } from './route'
import { getSupportedChainIds } from '@/lib/chains/registry'

// A CoinGecko-shaped token in the stubbed per-chain list. Mixed-case address to
// prove the route lower-cases keys before lookup.
const KNOWN_ADDR = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const KNOWN_LOGO = 'https://assets.coingecko.com/x.png'
const UNKNOWN_ADDR = '0xbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const LIST_HOST = 'https://tokens.coingecko.com/'

const dlUrl = (chainId: number | string, addr: string) =>
  `https://token-icons.llamao.fi/icons/tokens/${chainId}/${addr.toLowerCase()}?h=48&w=48`

function req(params: Record<string, string>): NextRequest {
  const qs = new URLSearchParams(params).toString()
  return new NextRequest(`http://localhost/api/token-logo?${qs}`)
}

type Override = (url: string) => Response | Promise<Response> | undefined

/** Answers the CoinGecko list and any image URL; `override` can claim a URL first. */
function stubNetwork(opts: { tokens?: object[]; override?: Override } = {}) {
  const tokens = opts.tokens ?? [{ address: KNOWN_ADDR, symbol: 'X', decimals: 18, logoURI: KNOWN_LOGO }]
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const claimed = await opts.override?.(url)
    if (claimed) return claimed
    if (url.startsWith(LIST_HOST)) return new Response(JSON.stringify({ tokens }), { status: 200 })
    return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const imageFetches = (m: ReturnType<typeof stubNetwork>) =>
  m.mock.calls.map((c) => c[0]).filter((u) => !u.startsWith(LIST_HOST))

/** The C8 invariant: a served logo is an image body on OUR origin, with nothing to follow. */
async function expectStreamedImage(res: Response) {
  expect(res.status).toBe(200)
  expect(res.headers.get('location')).toBeNull()
  expect(res.headers.get('content-type')).toBe('image/png')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
}

describe('GET /api/token-logo', () => {
  beforeEach(() => {
    __resetTokenLogoCache()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    __resetTokenLogoCache()
  })

  it('streams a known address from its CoinGecko logoURI: image body, long cache, no Location', async () => {
    const fetchMock = stubNetwork()

    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR }))

    expect(imageFetches(fetchMock)).toEqual([KNOWN_LOGO])
    await expectStreamedImage(res)
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toContain('public')
    expect(cc).toContain('max-age=86400')
    expect(cc).toContain('s-maxage=86400')
  })

  it('looks up the address case-insensitively (lowercased key)', async () => {
    const fetchMock = stubNetwork()

    // Query with the all-lowercase form of a list entry stored mixed-case.
    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR.toLowerCase() }))

    expect(imageFetches(fetchMock)).toEqual([KNOWN_LOGO])
    await expectStreamedImage(res)
  })

  it('streams an unknown address from the DefiLlama by-address URL, cached for an hour only', async () => {
    const fetchMock = stubNetwork()

    const res = await GET(req({ chainId: '1', address: UNKNOWN_ADDR }))

    expect(imageFetches(fetchMock)).toEqual([dlUrl(1, UNKNOWN_ADDR)])
    await expectStreamedImage(res)
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600')
  })

  it('honours chainId in the DefiLlama fallback (base = 8453)', async () => {
    const fetchMock = stubNetwork()

    const res = await GET(req({ chainId: '8453', address: UNKNOWN_ADDR }))

    expect(imageFetches(fetchMock)).toEqual([dlUrl(8453, UNKNOWN_ADDR)])
    await expectStreamedImage(res)
  })

  it('returns 400 for an unsupported chainId', async () => {
    vi.stubGlobal('fetch', vi.fn())

    // 137 (Polygon) is not in the chain registry — still rejected.
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

  it('is fail-safe: a list fetch rejection still serves the DefiLlama image, never a 500', async () => {
    const fetchMock = stubNetwork({
      override: (url) => {
        if (url.startsWith(LIST_HOST)) throw new Error('network down')
        return undefined
      },
    })

    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR }))

    // Even though this address IS in the (unreachable) list, we must not 500.
    expect(imageFetches(fetchMock)).toEqual([dlUrl(1, KNOWN_ADDR)])
    await expectStreamedImage(res)
  })

  it('is fail-safe: a non-ok list response serves the DefiLlama image', async () => {
    const fetchMock = stubNetwork({
      override: (url) => (url.startsWith(LIST_HOST) ? new Response('nope', { status: 503 }) : undefined),
    })

    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR }))

    expect(imageFetches(fetchMock)).toEqual([dlUrl(1, KNOWN_ADDR)])
    await expectStreamedImage(res)
  })

  it('caches the per-chain list in memory (fetches once across requests)', async () => {
    const fetchMock = stubNetwork()

    await GET(req({ chainId: '1', address: KNOWN_ADDR }))
    await GET(req({ chainId: '1', address: UNKNOWN_ADDR }))

    // Second request reuses the warm in-memory map — only one list fetch.
    expect(fetchMock.mock.calls.filter((c) => c[0].startsWith(LIST_HOST))).toHaveLength(1)
  })

  it('upgrades a CoinGecko /thumb/ logo to the crisp /large/ variant before fetching it', async () => {
    // The per-chain list ships the 25px `thumb`; the selector needs the 250px `large`.
    const addr = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
    const thumb = 'https://assets.coingecko.com/coins/images/33800/thumb/Icon___Dark.png?1702991855'
    const fetchMock = stubNetwork({ tokens: [{ address: addr, symbol: 'FOO', decimals: 18, logoURI: thumb }] })

    const res = await GET(req({ chainId: '1', address: addr }))

    expect(imageFetches(fetchMock)).toEqual([
      'https://assets.coingecko.com/coins/images/33800/large/Icon___Dark.png?1702991855',
    ])
    await expectStreamedImage(res)
  })

  // ── [C8] The list is upstream data: a logoURI is only fetched if its host is allow-listed ──────
  it.each([
    ['an unrelated host', 'https://example.com/assets/thumb/bar.png'],
    ['a look-alike suffix', 'https://assets.coingecko.com.evil.example/x.png'],
    ['plain http', 'http://assets.coingecko.com/x.png'],
    ['embedded credentials', 'https://user:pw@assets.coingecko.com/x.png'],
    ['a custom port', 'https://assets.coingecko.com:8443/x.png'],
    ['an internal address', 'https://169.254.169.254/latest/meta-data/'],
    ['a non-URL', 'javascript:alert(1)'],
  ])('never fetches a list logoURI on %s — falls through to DefiLlama', async (_label, url) => {
    const addr = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'
    const fetchMock = stubNetwork({ tokens: [{ address: addr, symbol: 'BAR', decimals: 18, logoURI: url }] })

    const res = await GET(req({ chainId: '1', address: addr }))

    expect(imageFetches(fetchMock)).toEqual([dlUrl(1, addr)])
    await expectStreamedImage(res)
  })

  it('falls through to DefiLlama when the CoinGecko image itself 404s', async () => {
    const fetchMock = stubNetwork({
      override: (url) => (url === KNOWN_LOGO ? new Response('gone', { status: 404 }) : undefined),
    })

    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR }))

    expect(imageFetches(fetchMock)).toEqual([KNOWN_LOGO, dlUrl(1, KNOWN_ADDR)])
    await expectStreamedImage(res)
  })

  it.each([
    ['an SVG', 'image/svg+xml', '<svg onload="alert(1)"/>'],
    ['HTML', 'text/html', '<html>not a logo</html>'],
    ['a typeless body', '', 'bytes'],
  ])('refuses %s from every source: a cached empty 404, no Location', async (_label, contentType, body) => {
    stubNetwork({
      override: (url) =>
        url.startsWith(LIST_HOST) ? undefined : new Response(body, { status: 200, headers: contentType ? { 'Content-Type': contentType } : {} }),
    })

    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR }))

    expect(res.status).toBe(404)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600')
    expect(await res.text()).toBe('')
  })

  it('refuses an oversized image and answers 404 when no source has a usable one', async () => {
    stubNetwork({
      override: (url) =>
        url.startsWith(LIST_HOST)
          ? undefined
          : new Response(new Uint8Array(512 * 1024 + 1), { status: 200, headers: { 'Content-Type': 'image/png' } }),
    })

    const res = await GET(req({ chainId: '1', address: KNOWN_ADDR }))

    expect(res.status).toBe(404)
  })

  it('never answers with a redirect, whatever the sources do', async () => {
    const scenarios: Override[] = [
      () => undefined,
      (url) => (url.startsWith(LIST_HOST) ? new Response('x', { status: 500 }) : undefined),
      (url) => (url.startsWith(LIST_HOST) ? undefined : new Response('gone', { status: 404 })),
    ]
    for (const override of scenarios) {
      __resetTokenLogoCache()
      stubNetwork({ override })
      const res = await GET(req({ chainId: '1', address: KNOWN_ADDR }))
      expect([200, 404]).toContain(res.status)
      expect(res.headers.get('location')).toBeNull()
    }
  })

  // ── [FIX-RPC-CHAIN-IDENTITY-GUARD] Registry-wide chain support ──────────────────────────
  // The allowlist was a hardcoded pair (1, 8453), so /api/token-logo 400'd for chainId=42161
  // even though Arbitrum has been in the chain registry since SPRINT-46. The registry is the
  // allowlist now; the CoinGecko platform slug is only an optimisation on top of it.

  it('serves Arbitrum (42161) instead of 400ing', async () => {
    const fetchMock = stubNetwork()

    const res = await GET(req({ chainId: '42161', address: UNKNOWN_ADDR }))

    expect(imageFetches(fetchMock)).toEqual([dlUrl(42161, UNKNOWN_ADDR)])
    await expectStreamedImage(res)
  })

  it('resolves an Arbitrum address from the CoinGecko arbitrum-one list', async () => {
    const fetchMock = stubNetwork()

    const res = await GET(req({ chainId: '42161', address: KNOWN_ADDR }))

    await expectStreamedImage(res)
    expect(imageFetches(fetchMock)).toEqual([KNOWN_LOGO])
    // CoinGecko's asset-platform slug for Arbitrum One is `arbitrum-one`, not the registry slug.
    expect(fetchMock.mock.calls[0][0]).toBe('https://tokens.coingecko.com/arbitrum-one/all.json')
  })

  it('serves EVERY chain in the registry — the allowlist is the registry, not a hardcoded pair', async () => {
    for (const chainId of getSupportedChainIds()) {
      __resetTokenLogoCache()
      const fetchMock = stubNetwork()

      const res = await GET(req({ chainId: String(chainId), address: UNKNOWN_ADDR }))

      expect(res.status, `chainId ${chainId} must be served`).toBe(200)
      expect(imageFetches(fetchMock)[0]).toContain(`/tokens/${chainId}/`)
    }
  })

  it('keeps caching per chain (an Arbitrum list fetch does not satisfy a mainnet request)', async () => {
    const fetchMock = stubNetwork()

    await GET(req({ chainId: '42161', address: KNOWN_ADDR }))
    await GET(req({ chainId: '1', address: KNOWN_ADDR }))
    await GET(req({ chainId: '42161', address: UNKNOWN_ADDR }))

    expect(fetchMock.mock.calls.map((c) => c[0]).filter((u) => u.startsWith(LIST_HOST))).toEqual([
      'https://tokens.coingecko.com/arbitrum-one/all.json',
      'https://tokens.coingecko.com/ethereum/all.json',
    ])
  })

  it('still rejects a numeric chainId that is not in the registry', async () => {
    vi.stubGlobal('fetch', vi.fn())

    for (const unsupported of ['137', '10', '56', '0', '99999999999999999999']) {
      const res = await GET(req({ chainId: unsupported, address: KNOWN_ADDR }))
      expect(res.status, `chainId ${unsupported} must be rejected`).toBe(400)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})
