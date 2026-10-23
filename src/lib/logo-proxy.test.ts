// @vitest-environment node
/**
 * [fix/functional-chain-ui C8] The shared logo fetch: what it may touch (host allow-list, manual
 * redirects re-checked per hop) and what it may serve (raster only, ≤512 KB, never throws).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchLogo, isAllowedLogoUrl, MAX_LOGO_BYTES } from './logo-proxy'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const png = () => new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { Location: to } })

afterEach(() => vi.unstubAllGlobals())

describe('isAllowedLogoUrl', () => {
  it.each([
    'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA/logo.png',
    'https://assets.coingecko.com/coins/images/1/large/a.png?1',
    'https://coin-images.coingecko.com/coins/images/1/large/a.png',
    'https://token-icons.llamao.fi/icons/tokens/1/0xabc?h=48&w=48',
    'HTTPS://Assets.CoinGecko.com/x.png',
  ])('allows %s', (url) => expect(isAllowedLogoUrl(url)).toBe(true))

  it.each([
    'http://assets.coingecko.com/x.png',
    'https://coingecko.com/x.png',
    'https://evil.assets.coingecko.com/x.png',
    'https://assets.coingecko.com.evil.example/x.png',
    'https://evil.example/assets.coingecko.com/x.png',
    'https://assets.coingecko.com@evil.example/x.png',
    'https://user@assets.coingecko.com/x.png',
    'https://assets.coingecko.com:444/x.png',
    'https://127.0.0.1/x.png',
    'file:///etc/passwd',
    '//assets.coingecko.com/x.png',
    '',
  ])('refuses %j', (url) => expect(isAllowedLogoUrl(url)).toBe(false))
})

describe('fetchLogo', () => {
  it('fetches an allow-listed URL with redirects handled by hand', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => png())
    vi.stubGlobal('fetch', fetchMock)
    const logo = await fetchLogo('https://assets.coingecko.com/x.png')
    expect(logo).toEqual({ body: PNG, contentType: 'image/png' })
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual')
  })

  it('never fetches a URL that is not allow-listed', async () => {
    const fetchMock = vi.fn(async () => png())
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchLogo('https://evil.example/x.png')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('follows a redirect to another allow-listed host, resolving a relative Location', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://coin-images.coingecko.com/y.png', 301))
      .mockResolvedValueOnce(png())
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchLogo('https://assets.coingecko.com/x.png')).not.toBeNull()
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://assets.coingecko.com/x.png',
      'https://coin-images.coingecko.com/y.png',
    ])
  })

  it.each([
    ['an off-list host', 'https://evil.example/y.png'],
    ['an internal address', 'http://169.254.169.254/'],
    ['plain http on an allowed host', 'http://assets.coingecko.com/y.png'],
  ])('refuses a redirect to %s without fetching it', async (_label, to) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect(to)).mockResolvedValue(png())
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchLogo('https://assets.coingecko.com/x.png')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after two redirects and on a redirect with no Location', async () => {
    const loop = vi.fn(async () => redirect('https://assets.coingecko.com/next.png'))
    vi.stubGlobal('fetch', loop)
    expect(await fetchLogo('https://assets.coingecko.com/x.png')).toBeNull()
    expect(loop).toHaveBeenCalledTimes(3)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302 })))
    expect(await fetchLogo('https://assets.coingecko.com/x.png')).toBeNull()
  })

  it.each([
    ['image/svg+xml', '<svg/>'],
    ['text/html', '<html/>'],
    ['application/octet-stream', 'bytes'],
  ])('refuses %s', async (contentType, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'Content-Type': contentType } })))
    expect(await fetchLogo('https://assets.coingecko.com/x.png')).toBeNull()
  })

  it('accepts the raster types and ignores a charset suffix', async () => {
    for (const ct of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'IMAGE/PNG; charset=binary']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { status: 200, headers: { 'Content-Type': ct } })))
      expect((await fetchLogo('https://assets.coingecko.com/x.png'))?.contentType).toBe(ct.split(';')[0].toLowerCase())
    }
  })

  it('stops reading an oversized body (declared or not) and returns null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(MAX_LOGO_BYTES + 1), { status: 200, headers: { 'Content-Type': 'image/png' } })))
    expect(await fetchLogo('https://assets.coingecko.com/x.png')).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(MAX_LOGO_BYTES + 1) } })))
    expect(await fetchLogo('https://assets.coingecko.com/x.png')).toBeNull()
  })

  it('accepts a body of exactly the cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(MAX_LOGO_BYTES), { status: 200, headers: { 'Content-Type': 'image/png' } })))
    expect((await fetchLogo('https://assets.coingecko.com/x.png'))?.body.byteLength).toBe(MAX_LOGO_BYTES)
  })

  it('returns null for non-2xx and network failures — never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })))
    expect(await fetchLogo('https://assets.coingecko.com/x.png')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    expect(await fetchLogo('https://assets.coingecko.com/x.png')).toBeNull()
  })
})
