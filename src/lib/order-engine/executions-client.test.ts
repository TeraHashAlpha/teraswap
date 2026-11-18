// @vitest-environment jsdom
/**
 * [A87b R2-1] fetchOrderExecutions — the browser's one call of GET /api/orders/:id/executions. It sends the read signature
 * the Orders tab already holds, takes the list's sign-once-and-retry path on a 401 (one prompt however many panels ask, a
 * refusal remembered), retries ONCE, and with nothing cached is the exact single-argument `fetch(url)` it was before.
 * The signatures here are fixed dummies; the server is a mock, nothing is verified cryptographically (route tests do that).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchOrderExecutions, orderExecutionsUrl } from './executions-client'
import {
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
  _readAuthInternal,
  setOrdersReadSigner,
  storeOrdersReadAuth,
} from './read-auth'

const ID = 'order-123'
const WALLET = '0xAbCdEf0000000000000000000000000000000001'
const URL = `/api/orders/${ID}/executions?wallet=${WALLET}`
const DUMMY_SIG = `0x${'ab'.repeat(65)}`
const ok = () => ({ status: 200, ok: true, json: async () => ({ executions: [], order: null }) })
const unauthorized = () => ({ status: 401, ok: false, json: async () => ({ code: 'READ_AUTH_REQUIRED' }) })
const fetchMock = vi.fn()

beforeEach(() => {
  sessionStorage.clear()
  _readAuthInternal.reset()
  _readAuthInternal.clearSigner()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  fetchMock.mockReset()
})

describe('fetchOrderExecutions', () => {
  it('the URL is the one every caller used before', () => {
    expect(orderExecutionsUrl(ID, WALLET)).toBe(URL)
  })

  it('nothing cached: one single-argument fetch(url), exactly as before', async () => {
    fetchMock.mockResolvedValue(ok())
    await fetchOrderExecutions(ID, WALLET)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]).toEqual([URL])
  })

  it('a cached read signature is sent in the two read headers, whatever the wallet\'s casing', async () => {
    storeOrdersReadAuth(WALLET.toLowerCase(), { issuedAt: Math.floor(Date.now() / 1000), signature: DUMMY_SIG })
    fetchMock.mockResolvedValue(ok())
    await fetchOrderExecutions(ID, WALLET)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(URL)
    expect(Object.keys(init.headers).sort()).toEqual([ORDERS_READ_HEADER_ISSUED, ORDERS_READ_HEADER_SIGNATURE])
    expect(init.headers[ORDERS_READ_HEADER_SIGNATURE]).toBe(DUMMY_SIG)
  })

  it('a 401 with nothing cached: signs once through the registered signer, then retries ONCE with the headers', async () => {
    const signer = vi.fn(async () => DUMMY_SIG)
    setOrdersReadSigner(signer)
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok())
    const res = await fetchOrderExecutions(ID, WALLET)
    expect(res.status).toBe(200)
    expect(signer).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]).toEqual([URL])
    expect(fetchMock.mock.calls[1][1].headers[ORDERS_READ_HEADER_SIGNATURE]).toBe(DUMMY_SIG)
  })

  it('what is signed is the read message for THIS wallet (lowercased), never anything that moves funds', async () => {
    const signer = vi.fn(async () => DUMMY_SIG)
    setOrdersReadSigner(signer)
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok())
    await fetchOrderExecutions(ID, WALLET)
    const typed = (signer.mock.calls[0] as unknown[])[0] as { primaryType: string; message: { wallet: string } }
    expect(typed.primaryType).toBe('OrdersReadAccess')
    expect(typed.message.wallet).toBe(WALLET.toLowerCase())
  })

  it('a 401 and still a 401 after signing: no third request (no retry loop), the 401 is handed back', async () => {
    setOrdersReadSigner(async () => DUMMY_SIG)
    fetchMock.mockResolvedValue(unauthorized())
    const res = await fetchOrderExecutions(ID, WALLET)
    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a 401 with no signer registered (no Orders surface mounted): no prompt, no retry, the 401 handed back', async () => {
    fetchMock.mockResolvedValue(unauthorized())
    const res = await fetchOrderExecutions(ID, WALLET)
    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a refused prompt is remembered: the next call is a plain 401, the wallet is not asked again', async () => {
    const signer = vi.fn(async () => {
      throw new Error('User rejected the request')
    })
    setOrdersReadSigner(signer)
    fetchMock.mockResolvedValue(unauthorized())
    expect((await fetchOrderExecutions(ID, WALLET)).status).toBe(401)
    expect((await fetchOrderExecutions(ID, WALLET)).status).toBe(401)
    expect(signer).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2) // one plain 401 per call, no retry after a refusal
  })

  it('five panels hit a 401 at once: ONE prompt, then each retries with the headers', async () => {
    let release!: (s: string) => void
    const signer = vi.fn(() => new Promise<string>((r) => (release = r)))
    setOrdersReadSigner(signer)
    fetchMock.mockImplementation(async (_u: string, init?: { headers?: Record<string, string> }) =>
      init?.headers ? ok() : unauthorized(),
    )
    const calls = Promise.all(Array.from({ length: 5 }, (_, i) => fetchOrderExecutions(`order-${i}`, WALLET)))
    await vi.waitFor(() => expect(signer).toHaveBeenCalledTimes(1))
    release(DUMMY_SIG)
    const results = await calls
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    expect(signer).toHaveBeenCalledTimes(1)
  })

  it('a non-401 answer (200, 403, 500) never prompts', async () => {
    const signer = vi.fn(async () => DUMMY_SIG)
    setOrdersReadSigner(signer)
    for (const status of [200, 403, 500]) {
      fetchMock.mockResolvedValueOnce({ status, ok: status === 200, json: async () => ({}) })
      expect((await fetchOrderExecutions(ID, WALLET)).status).toBe(status)
    }
    expect(signer).not.toHaveBeenCalled()
  })
})
