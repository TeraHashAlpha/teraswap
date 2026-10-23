/**
 * [fix/functional-chain-ui C8] /api/proxy/logo — Trust Wallet logos fetched server-side. Network
 * mocked: the route must reject anything that is not a registry chain + 0x address BEFORE fetching,
 * only ever fetch the fixed Trust Wallet template, and only pass raster image bytes through.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

const USDC_LC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDC_CS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function req(params: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost/api/proxy/logo?${new URLSearchParams(params)}`)
}

function upstream(body: BodyInit | null, init: ResponseInit) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

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
