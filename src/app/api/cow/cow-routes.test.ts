/**
 * [fix/user-ip-privacy A76 S-1] /api/cow/{quote,orders,order-status,trades} — the same-origin CoW relay.
 *
 * Pins what the Auditor asked for, at the boundary (global fetch = the upstream):
 *  - only an allow-list of fields reaches CoW (an extra field the browser sends is dropped);
 *  - no header of the visitor's request reaches CoW (Cookie, Origin, Referer, User-Agent, X-Forwarded-For,
 *    CF-Connecting-IP, X-Real-IP): the upstream request carries Accept (+ Content-Type with a body) and nothing else;
 *  - 10 s upstream timeout (AbortSignal on the fetch) → 504; > 1 MB answer → 502; an answer is never an upstream URL
 *    or a fetch error message;
 *  - each route is behind the per-IP limiter, keyed by the HMAC of the client IP, never the address.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockLimit = vi.fn()
vi.mock('@/lib/kv-rate-limiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kv-rate-limiter')>()
  return { ...actual, checkRateLimitWithin: (...a: unknown[]) => mockLimit(...a) }
})

import { POST as quotePOST } from './quote/route'
import { POST as ordersPOST, DELETE as ordersDELETE } from './orders/route'
import { GET as statusGET } from './order-status/route'
import { GET as tradesGET } from './trades/route'
import { COW_PROXY_MAX_RESPONSE_BYTES, COW_PROXY_TIMEOUT_MS } from '@/lib/cow-proxy'

const UID = '0x' + 'ab'.repeat(56)
const SIG = '0x' + '1'.repeat(130)
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const VISITOR = {
  cookie: 'session=secret',
  origin: 'https://teraswap.app',
  referer: 'https://teraswap.app/swap',
  'user-agent': 'Visitor/1.0',
  'x-forwarded-for': '203.0.113.7',
  'cf-connecting-ip': '203.0.113.7',
  'x-real-ip': '203.0.113.7',
  'x-vercel-forwarded-for': '203.0.113.7',
}
const SIGNED_ORDER = {
  sellToken: A,
  buyToken: B,
  sellAmount: '1000000',
  buyAmount: '500000000000000000',
  validTo: 1_900_000_000,
  appData: '{"version":"1.1.0","appCode":"TeraSwap","metadata":{}}',
  appDataHash: '0x' + 'a'.repeat(64),
  feeAmount: '0',
  kind: 'sell',
  partiallyFillable: false,
  receiver: A,
  sellTokenBalance: 'erc20',
  buyTokenBalance: 'erc20',
  signingScheme: 'eip712',
  signature: SIG,
  from: A,
  quoteId: 7,
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  mockLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 9, resetAt: 0 })
  fetchMock = vi.fn(async () => new Response(JSON.stringify(UID), { status: 201 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

function req(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...VISITOR, ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

function upstream(i = 0): { url: string; init: RequestInit; headers: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit]
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((v, k) => (headers[k] = v))
  return { url, init, headers }
}

describe('POST /api/cow/orders — the signed order', () => {
  it.each([
    [1, 'https://api.cow.fi/mainnet/api/v1/orders'],
    [8453, 'https://api.cow.fi/base/api/v1/orders'],
    [42161, 'https://api.cow.fi/arbitrum/api/v1/orders'],
  ])('chain %i → %s, with ONLY the order fields and NO visitor header', async (chainId, url) => {
    const res = await ordersPOST(req(`/api/cow/orders?chainId=${chainId}`, { method: 'POST', body: { ...SIGNED_ORDER, evil: 'x', __proto__: { y: 1 } } }))
    expect(res.status).toBe(201)
    expect(await res.json()).toBe(UID)
    const up = upstream()
    expect(up.url).toBe(url)
    expect(up.init.method).toBe('POST')
    expect(up.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' })
    expect(JSON.parse(String(up.init.body))).toEqual(SIGNED_ORDER)
    expect(up.init.signal).toBeInstanceOf(AbortSignal)
    expect(up.init.redirect).toBe('error')
  })

  it.each([
    ['signature', { signature: '0xsig' }],
    ['signingScheme', { signingScheme: 'presign' }],
    ['sellToken', { sellToken: 'not-an-address' }],
    ['sellAmount', { sellAmount: '1e18' }],
    ['validTo', { validTo: 2 ** 32 }],
    ['from', { from: undefined }],
  ])('a malformed %s is a 400 and nothing is forwarded', async (field, patch) => {
    const res = await ordersPOST(req('/api/cow/orders?chainId=1', { method: 'POST', body: { ...SIGNED_ORDER, ...patch } }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ errorType: 'InvalidRequest', description: `Invalid ${field}` })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['', '10', '137', '__proto__', '1;DROP'])('chainId %j is refused', async (chainId) => {
    const res = await ordersPOST(req(`/api/cow/orders?chainId=${chainId}`, { method: 'POST', body: SIGNED_ORDER }))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a CoW 4xx keeps its status and only CoW's errorType/description, with any URL in them replaced", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errorType: 'InsufficientBalance', description: 'see https://api.cow.fi/docs for details', data: { secret: 1 } }), { status: 400 }),
    )
    const res = await ordersPOST(req('/api/cow/orders?chainId=1', { method: 'POST', body: SIGNED_ORDER }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ errorType: 'InsufficientBalance', description: 'see [url] for details' })
  })

  it('a CoW 5xx is a 502', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>oops</html>', { status: 503 }))
    const res = await ordersPOST(req('/api/cow/orders?chainId=1', { method: 'POST', body: SIGNED_ORDER }))
    expect(res.status).toBe(502)
  })
})

describe('DELETE /api/cow/orders — a signed cancellation', () => {
  it('forwards { signature, signingScheme, orderUids: [uid] } to /orders/<uid> and nothing else', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify('Cancelled'), { status: 200 }))
    const res = await ordersDELETE(req(`/api/cow/orders?chainId=8453&uid=${UID}`, { method: 'DELETE', body: { signature: SIG, signingScheme: 'eip712', orderUids: [UID], extra: 1 } }))
    expect(res.status).toBe(200)
    const up = upstream()
    expect(up.url).toBe(`https://api.cow.fi/base/api/v1/orders/${UID}`)
    expect(up.init.method).toBe('DELETE')
    expect(JSON.parse(String(up.init.body))).toEqual({ signature: SIG, signingScheme: 'eip712', orderUids: [UID] })
    expect(up.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' })
  })

  it('a uid in the body that is not the uid in the URL is refused', async () => {
    const res = await ordersDELETE(req(`/api/cow/orders?chainId=1&uid=${UID}`, { method: 'DELETE', body: { signature: SIG, signingScheme: 'eip712', orderUids: ['0x' + 'cd'.repeat(56)] } }))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/cow/quote — a price read for a pair', () => {
  it('forwards only the pair + amount; the rest of the /quote body is built by the server', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ quote: { buyAmount: '2000' } }), { status: 200 }))
    const res = await quotePOST(req('/api/cow/quote?chainId=42161', { method: 'POST', body: { sellToken: A, buyToken: B, sellAmountBeforeFee: '1000', from: B, appData: 'evil', receiver: B } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ quote: { buyAmount: '2000' } })
    const up = upstream()
    expect(up.url).toBe('https://api.cow.fi/arbitrum/api/v1/quote')
    expect(up.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' })
    const body = JSON.parse(String(up.init.body))
    expect(body).toMatchObject({ sellToken: A, buyToken: B, sellAmountBeforeFee: '1000', kind: 'sell' })
    expect(body.from).toBe('0x0000000000000000000000000000000000000000')
    expect(body.receiver).toBe('0x0000000000000000000000000000000000000000')
    expect(body.appData).toBe(JSON.stringify({ appCode: 'TeraSwap', metadata: {} }))
  })

  it('a zero amount is refused', async () => {
    const res = await quotePOST(req('/api/cow/quote?chainId=1', { method: 'POST', body: { sellToken: A, buyToken: B, sellAmountBeforeFee: '0' } }))
    expect(res.status).toBe(400)
  })
})

describe('GET /api/cow/order-status and /api/cow/trades — the uid only', () => {
  it('order-status → GET <base>/orders/<uid>, no body, Accept only', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'open' }), { status: 200 }))
    const res = await statusGET(req(`/api/cow/order-status?chainId=1&uid=${UID}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'open' })
    const up = upstream()
    expect(up.url).toBe(`https://api.cow.fi/mainnet/api/v1/orders/${UID}`)
    expect(up.init.method).toBe('GET')
    expect(up.init.body).toBeUndefined()
    expect(up.headers).toEqual({ accept: 'application/json' })
  })

  it('trades → GET <base>/trades?orderUid=<uid>', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ txHash: '0x1' }]), { status: 200 }))
    const res = await tradesGET(req(`/api/cow/trades?chainId=8453&orderUid=${UID}`))
    expect(await res.json()).toEqual([{ txHash: '0x1' }])
    expect(upstream().url).toBe(`https://api.cow.fi/base/api/v1/trades?orderUid=${UID}`)
  })

  it.each([['order-status', 'uid'], ['trades', 'orderUid']])('%s: a malformed %s (path injection) is refused', async (route, param) => {
    const handler = route === 'trades' ? tradesGET : statusGET
    for (const bad of ['../../admin', `${UID}/cancel`, '0x1234', `${UID}&x=1`]) {
      const res = await handler(req(`/api/cow/${route}?chainId=1&${param}=${encodeURIComponent(bad)}`))
      expect(res.status).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('bounds and error hygiene', () => {
  it(`the upstream fetch is aborted after ${COW_PROXY_TIMEOUT_MS} ms → 504, fixed sentence, no URL`, async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    fetchMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout https://api.cow.fi/mainnet/api/v1/orders'), { name: 'TimeoutError' })
    })
    const res = await statusGET(req(`/api/cow/order-status?chainId=1&uid=${UID}`))
    expect(timeoutSpy).toHaveBeenCalledWith(COW_PROXY_TIMEOUT_MS)
    expect(res.status).toBe(504)
    const text = await res.text()
    expect(text).not.toMatch(/cow\.fi|https?:/)
    timeoutSpy.mockRestore()
  })

  it('a network error → 502, and the error message (which names the upstream) is never echoed', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed: getaddrinfo ENOTFOUND api.cow.fi https://api.cow.fi/base/api/v1/orders'))
    const res = await ordersPOST(req('/api/cow/orders?chainId=8453', { method: 'POST', body: SIGNED_ORDER }))
    expect(res.status).toBe(502)
    expect(await res.text()).not.toMatch(/cow\.fi|https?:|ENOTFOUND/)
  })

  it('an answer over 1 MB (chunked, no content-length) → 502 without buffering it all', async () => {
    let pulled = 0
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength
        if (pulled > 4 * COW_PROXY_MAX_RESPONSE_BYTES) controller.close()
        else controller.enqueue(chunk)
      },
    })
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }))
    const res = await tradesGET(req(`/api/cow/trades?chainId=1&orderUid=${UID}`))
    expect(res.status).toBe(502)
    expect((await res.json()).errorType).toBe('UpstreamResponseTooLarge')
    expect(pulled).toBeLessThan(COW_PROXY_MAX_RESPONSE_BYTES + 3 * chunk.byteLength)
  })

  it('a declared content-length over 1 MB → 502', async () => {
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'content-length': String(COW_PROXY_MAX_RESPONSE_BYTES + 1) } }))
    const res = await tradesGET(req(`/api/cow/trades?chainId=1&orderUid=${UID}`))
    expect(res.status).toBe(502)
  })

  it('a request body over 16 KB is a 413 before the limiter or CoW', async () => {
    const res = await ordersPOST(req('/api/cow/orders?chainId=1', { method: 'POST', body: SIGNED_ORDER, headers: { 'content-length': '20000' } }))
    expect(res.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('rate limit: per route, keyed by the HMAC of the client IP', () => {
  it.each([
    ['quote', () => quotePOST(req('/api/cow/quote?chainId=1', { method: 'POST', body: { sellToken: A, buyToken: B, sellAmountBeforeFee: '1' } })), 30],
    ['orders', () => ordersPOST(req('/api/cow/orders?chainId=1', { method: 'POST', body: SIGNED_ORDER })), 10],
    ['order-status', () => statusGET(req(`/api/cow/order-status?chainId=1&uid=${UID}`)), 60],
    ['trades', () => tradesGET(req(`/api/cow/trades?chainId=1&orderUid=${UID}`)), 30],
  ] as const)('%s: key cow-%s:<32 hex>, limit %i/min; a refusal is a 429 and nothing is forwarded', async (route, call, limit) => {
    mockLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: 123 })
    const res = await call()
    expect(res.status).toBe(429)
    expect(fetchMock).not.toHaveBeenCalled()
    const [key, lim, windowMs] = mockLimit.mock.calls[0] as [string, number, number]
    expect(key).toMatch(new RegExp(`^cow-${route}:[0-9a-f]{32}$`))
    expect(key).not.toContain('203.0.113.7')
    expect(lim).toBe(limit)
    expect(windowMs).toBe(60_000)
  })

})
