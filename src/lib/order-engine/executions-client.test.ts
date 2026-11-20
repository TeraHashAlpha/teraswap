// @vitest-environment jsdom
/**
 * [A87b R2-1] fetchOrderExecutions — the browser's one call of GET /api/orders/:id/executions. It sends the read signature
 * the Orders tab already holds, takes the list's sign-once-and-retry path on a 401 (one prompt however many panels ask, a
 * refusal remembered), retries ONCE, and with nothing cached is the exact single-argument `fetch(url)` it was before.
 *
 * [A97 S-1/S-4/S-8] It signs only for the wallet the URL names when that wallet is the CONNECTED account (the signer
 * registry holds { address, sign }), stores only a signature that recovers to that wallet, drops a cached one that does
 * not, and for a live order makes sure of the signature before the first request.
 *
 * Real signatures (viem local accounts, Anvil #0 and generated keys); the server is a mock. No signature is printed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { fetchOrderExecutions, orderExecutionsUrl } from './executions-client'
import {
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
  _readAuthInternal,
  buildOrdersReadTypedData,
  getCachedOrdersReadAuth,
  setOrdersReadSigner,
  storeOrdersReadAuth,
  type SignTypedDataFn,
} from './read-auth'

// Published Anvil/Hardhat default account #0 (value-allowlisted in .gitleaks.toml): NOT a secret. B is generated per run.
const A = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const B = privateKeyToAccount(generatePrivateKey())
const ID = 'order-123'
const WALLET = A.address // checksummed: the URL keeps the caller's casing
const URL = `/api/orders/${ID}/executions?wallet=${WALLET}`
const ok = () => ({ status: 200, ok: true, json: async () => ({ executions: [], order: null }) })
const unauthorized = () => ({ status: 401, ok: false, json: async () => ({ code: 'READ_AUTH_REQUIRED' }) })
const fetchMock = vi.fn()

/** A wallet that signs whatever it is asked with `account`'s key (a real signer, as wagmi + an extension would). */
const signsAs = (account: typeof A): SignTypedDataFn => async (typed) => account.signTypedData(typed)
const nowSec = () => Math.floor(Date.now() / 1000)
const owner = {} // one mounted Orders surface
const connect = (address: string, sign: SignTypedDataFn) => setOrdersReadSigner(owner, { address, sign })

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
    const issuedAt = nowSec()
    const signature = await A.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt))
    storeOrdersReadAuth(WALLET.toLowerCase(), { issuedAt, signature })
    fetchMock.mockResolvedValue(ok())
    await fetchOrderExecutions(ID, WALLET)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(URL)
    expect(Object.keys(init.headers).sort()).toEqual([ORDERS_READ_HEADER_ISSUED, ORDERS_READ_HEADER_SIGNATURE])
    expect(init.headers[ORDERS_READ_HEADER_SIGNATURE]).toBe(signature)
  })

  it('a 401 with nothing cached: signs once through the connected wallet\'s signer, then retries ONCE with the headers', async () => {
    const signer = vi.fn(signsAs(A))
    connect(WALLET, signer)
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok())
    const res = await fetchOrderExecutions(ID, WALLET)
    expect(res.status).toBe(200)
    expect(signer).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]).toEqual([URL])
    expect(fetchMock.mock.calls[1][1].headers[ORDERS_READ_HEADER_SIGNATURE]).toBe(getCachedOrdersReadAuth(WALLET)!.signature)
  })

  it('what is signed is the read message for THIS wallet (lowercased), never anything that moves funds', async () => {
    const signer = vi.fn(signsAs(A))
    connect(WALLET, signer)
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok())
    await fetchOrderExecutions(ID, WALLET)
    const typed = (signer.mock.calls[0] as unknown[])[0] as { primaryType: string; message: { wallet: string } }
    expect(typed.primaryType).toBe('OrdersReadAccess')
    expect(typed.message.wallet).toBe(WALLET.toLowerCase())
  })

  it('a 401 and still a 401 after signing: no third request (no retry loop), the 401 is handed back', async () => {
    connect(WALLET, signsAs(A))
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
    connect(WALLET, signer)
    fetchMock.mockResolvedValue(unauthorized())
    expect((await fetchOrderExecutions(ID, WALLET)).status).toBe(401)
    expect((await fetchOrderExecutions(ID, WALLET)).status).toBe(401)
    expect(signer).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2) // one plain 401 per call, no retry after a refusal
  })

  it('five panels hit a 401 at once: ONE prompt, then each retries with the headers', async () => {
    let release!: (s: string) => void
    const signer = vi.fn(() => new Promise<string>((r) => (release = r)))
    connect(WALLET, signer)
    fetchMock.mockImplementation(async (_u: string, init?: { headers?: Record<string, string> }) =>
      init?.headers ? ok() : unauthorized(),
    )
    const calls = Promise.all(Array.from({ length: 5 }, (_, i) => fetchOrderExecutions(`order-${i}`, WALLET)))
    await vi.waitFor(() => expect(signer).toHaveBeenCalledTimes(1))
    const typed = (signer.mock.calls[0] as unknown[])[0] as Parameters<typeof A.signTypedData>[0]
    release(await A.signTypedData(typed))
    const results = await calls
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    expect(signer).toHaveBeenCalledTimes(1)
  })

  it('a non-401 answer (200, 403, 500) never prompts', async () => {
    const signer = vi.fn(signsAs(A))
    connect(WALLET, signer)
    for (const status of [200, 403, 500]) {
      fetchMock.mockResolvedValueOnce({ status, ok: status === 200, json: async () => ({}) })
      expect((await fetchOrderExecutions(ID, WALLET)).status).toBe(status)
    }
    expect(signer).not.toHaveBeenCalled()
  })
})

describe('[A97 S-1] only the connected wallet signs, and only for itself', () => {
  it('the order\'s owner A is NOT the connected account (B is): no prompt, nothing cached, no refusal recorded, the 401 handed back', async () => {
    const signerB = vi.fn(signsAs(B))
    connect(B.address, signerB)
    fetchMock.mockResolvedValue(unauthorized())
    for (const live of [false, true]) {
      const res = await fetchOrderExecutions(ID, WALLET, { live })
      expect(res.status).toBe(401)
    }
    expect(signerB).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every((c) => c.length === 1)).toBe(true) // no headers: nothing was cached for A
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
    expect(_readAuthInternal.isDenied(WALLET)).toBe(false)
  })

  it('no wallet connected at all: no prompt, nothing cached, no refusal recorded', async () => {
    fetchMock.mockResolvedValue(unauthorized())
    expect((await fetchOrderExecutions(ID, WALLET, { live: true })).status).toBe(401)
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
    expect(_readAuthInternal.isDenied(WALLET)).toBe(false)
  })

  it('a signature that does not recover to A (another account answered the prompt) is never stored and records no refusal', async () => {
    const wrong = vi.fn(signsAs(B)) // registered for A, but the key behind it is B's
    connect(WALLET, wrong)
    fetchMock.mockResolvedValue(unauthorized())
    const res = await fetchOrderExecutions(ID, WALLET)
    expect(res.status).toBe(401)
    expect(wrong).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry: there is nothing to send
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
    expect(_readAuthInternal.isDenied(WALLET)).toBe(false)
  })

  // [A100 R2-3] The same case, read three times: the wallet is asked ONCE, then remembered.
  it('a signature that does not recover to A: three fills reads (live and not), ONE prompt, each hands back the 401, nothing is sent or stored', async () => {
    const wrong = vi.fn(signsAs(B)) // registered for A, but the key behind it is B's (a smart-contract account, or another account answered)
    connect(WALLET, wrong)
    fetchMock.mockResolvedValue(unauthorized())
    for (const live of [true, false, true]) expect((await fetchOrderExecutions(ID, WALLET, { live })).status).toBe(401)
    expect(wrong).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.every((c) => c.length === 1)).toBe(true) // no headers on any of them
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
    expect(_readAuthInternal.isMismatched(WALLET)).toBe(true)
    expect(_readAuthInternal.isDenied(WALLET)).toBe(false)
  })

  it('a cached entry under A signed by B is dropped on read; A, connected, signs its own and the retry carries it', async () => {
    const issuedAt = nowSec()
    storeOrdersReadAuth(WALLET, { issuedAt, signature: await B.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt)) })
    const signerA = vi.fn(signsAs(A))
    connect(WALLET, signerA)
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok())
    const res = await fetchOrderExecutions(ID, WALLET)
    expect(res.status).toBe(200)
    expect(signerA).toHaveBeenCalledTimes(1)
    const sent = fetchMock.mock.calls[1][1].headers[ORDERS_READ_HEADER_SIGNATURE] as string
    const kept = getCachedOrdersReadAuth(WALLET)!
    expect(sent).toBe(kept.signature)
    const { verifyOrdersReadAccess } = await import('./read-auth')
    expect((await verifyOrdersReadAccess({ wallet: WALLET, issuedAt: kept.issuedAt, signature: kept.signature })).ok).toBe(true)
  })
})

describe('[A100 R2-1] a cached entry that is not the wallet\'s own is never SENT', () => {
  /** What a build without the recover check left behind: B's signature cached under A. */
  async function plantForeign(): Promise<string> {
    const issuedAt = nowSec()
    const signature = await B.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt))
    storeOrdersReadAuth(WALLET, { issuedAt, signature })
    return signature
  }
  /** What each request carried, as a WORD (a failing assertion then prints words, never a signature): 'none', the planted 'foreign' one, the wallet's cached 'own', or 'other'. */
  const sent = (planted: string) =>
    fetchMock.mock.calls.map((c) => {
      const s = (c[1] as { headers?: Record<string, string> } | undefined)?.headers?.[ORDERS_READ_HEADER_SIGNATURE]
      return s === undefined ? 'none' : s === planted ? 'foreign' : s === getCachedOrdersReadAuth(WALLET)?.signature ? 'own' : 'other'
    })

  it.each([
    ['B is the connected account', () => connect(B.address, vi.fn(signsAs(B)))],
    ['nothing is connected', () => {}],
  ])('the owner is NOT connected (%s): 0 requests carry it, live or not, and it is removed', async (_label, setup) => {
    setup()
    fetchMock.mockResolvedValue(unauthorized())
    for (const live of [false, true]) {
      const planted = await plantForeign()
      const res = await fetchOrderExecutions(ID, WALLET, { live })
      expect(res.status).toBe(401)
      expect(sent(planted).every((s) => s === 'none')).toBe(true)
      expect(getCachedOrdersReadAuth(WALLET) === null).toBe(true)
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every((c) => c.length === 1)).toBe(true) // plain fetch(url): no headers at all
    expect(_readAuthInternal.isDenied(WALLET)).toBe(false)
  })

  it('the owner IS connected, live order: the entry is dropped, ONE prompt, ONE request, carrying the owner\'s own signature', async () => {
    const planted = await plantForeign()
    const signerA = vi.fn(signsAs(A))
    connect(WALLET, signerA)
    fetchMock.mockImplementation(async (_u: string, init?: { headers?: Record<string, string> }) => (init?.headers ? ok() : unauthorized()))
    const res = await fetchOrderExecutions(ID, WALLET, { live: true })
    expect(res.status).toBe(200) // the fills show
    expect(signerA).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getCachedOrdersReadAuth(WALLET)!.signature === planted).toBe(false)
    expect(sent(planted)).toEqual(['own'])
  })

  it('the owner IS connected, order not marked live: the first request goes out WITHOUT the entry, then one prompt and the retry carries the owner\'s own', async () => {
    const planted = await plantForeign()
    const signerA = vi.fn(signsAs(A))
    connect(WALLET, signerA)
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok())
    const res = await fetchOrderExecutions(ID, WALLET)
    expect(res.status).toBe(200)
    expect(signerA).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]).toEqual([URL])
    expect(sent(planted)).toEqual(['none', 'own'])
  })
})

describe('[A97 S-8] a live order signs FIRST when nothing valid is cached (no 401 in the console)', () => {
  it('live, owner connected, empty cache: one prompt, then ONE request that already carries the headers', async () => {
    const signer = vi.fn(signsAs(A))
    connect(WALLET, signer)
    fetchMock.mockImplementation(async (_u: string, init?: { headers?: Record<string, string> }) => (init?.headers ? ok() : unauthorized()))
    const res = await fetchOrderExecutions(ID, WALLET, { live: true })
    expect(res.status).toBe(200)
    expect(signer).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(Object.keys(fetchMock.mock.calls[0][1].headers).sort()).toEqual([ORDERS_READ_HEADER_ISSUED, ORDERS_READ_HEADER_SIGNATURE])
  })

  it('live with a valid cached signature: no prompt, one request with it', async () => {
    const issuedAt = nowSec()
    storeOrdersReadAuth(WALLET, { issuedAt, signature: await A.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt)) })
    const signer = vi.fn(signsAs(A))
    connect(WALLET, signer)
    fetchMock.mockResolvedValue(ok())
    await fetchOrderExecutions(ID, WALLET, { live: true })
    expect(signer).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].headers[ORDERS_READ_HEADER_SIGNATURE]).toBeDefined()
  })

  it('a finished order (live false) never signs first: the plain request, as before', async () => {
    const signer = vi.fn(signsAs(A))
    connect(WALLET, signer)
    fetchMock.mockResolvedValue(ok())
    await fetchOrderExecutions(ID, WALLET)
    expect(signer).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]).toEqual([URL])
  })

  it('live but refused: the wallet is asked once, the request goes out without headers and its 401 is handed back', async () => {
    const signer = vi.fn(async () => {
      throw new Error('User rejected the request')
    })
    connect(WALLET, signer)
    fetchMock.mockResolvedValue(unauthorized())
    expect((await fetchOrderExecutions(ID, WALLET, { live: true })).status).toBe(401)
    expect(signer).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
