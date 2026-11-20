// @vitest-environment jsdom
/**
 * [A100 R2-1] The two list fetchers (fetchUserOrders: the Orders tab's load; fetchActiveOrders: its 10 s poll) send a cached
 * read signature only after it was verified to be the wallet's OWN. A foreign entry (another account's signature cached
 * under this wallet, which a build without the recover check wrote in an account-switch race) is dropped and never sent:
 * the request goes out without the two headers and the server's 401 takes the usual sign-once path.
 *
 * Real signatures (viem local accounts); the server is a mock that records what each request carried. Assertions compare
 * WORDS ('none' / 'own' / 'foreign'), so a failing one prints no signature.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { fetchActiveOrders, fetchUserOrders } from './supabase'
import {
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
  ORDER_POLL_MAX_HASHES,
  ReadAuthRequiredError,
  _readAuthInternal,
  buildOrdersReadTypedData,
  getCachedOrdersReadAuth,
  storeOrdersReadAuth,
} from './read-auth'

// Published Anvil/Hardhat default account #0 (value-allowlisted in .gitleaks.toml): NOT a secret. B is generated per run.
const A = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const B = privateKeyToAccount(generatePrivateKey())
const WALLET = A.address
const hash = (i: number) => `0x${i.toString(16).padStart(64, '0')}`
const nowSec = () => Math.floor(Date.now() / 1000)

type Init = { headers?: Record<string, string> } | undefined
type Entry = { issuedAt: number; signature: string }
const fetchMock = vi.fn<(url: string, init?: Init) => Promise<Response>>()

/** What each request carried: 'none', or which entry its two read headers are exactly ('own' / 'foreign'), else 'other'. */
function sent(entries: { own?: Entry; foreign?: Entry | null } = {}): string[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const h = init?.headers
    if (!h) return 'none'
    const is = (e?: Entry | null) =>
      !!e && Object.keys(h).length === 2 && h[ORDERS_READ_HEADER_SIGNATURE] === e.signature && h[ORDERS_READ_HEADER_ISSUED] === String(e.issuedAt)
    return is(entries.own) ? 'own' : is(entries.foreign) ? 'foreign' : 'other'
  })
}
/** What is cached under the wallet now, as a word. */
function cached(entries: { own?: Entry; foreign?: Entry | null } = {}): string {
  const c = getCachedOrdersReadAuth(WALLET)
  if (!c) return 'nothing'
  return c.signature === entries.own?.signature ? 'own' : c.signature === entries.foreign?.signature ? 'foreign' : 'other'
}

async function plant(signer: typeof A): Promise<Entry> {
  const issuedAt = nowSec()
  const entry = { issuedAt, signature: await signer.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt)) }
  storeOrdersReadAuth(WALLET, entry)
  return entry
}

beforeEach(() => {
  sessionStorage.clear()
  _readAuthInternal.reset()
  _readAuthInternal.clearSigner()
  vi.stubGlobal('fetch', fetchMock)
  // The server: 401 without read headers, the rows with them.
  fetchMock.mockImplementation(async (_url, init) =>
    init?.headers ? new Response(JSON.stringify({ orders: [{ order_hash: hash(1) }] }), { status: 200 }) : new Response('{}', { status: 401 }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('[A100 R2-1] the list fetchers never send a cached entry that is not the wallet\'s own', () => {
  it('fetchUserOrders, foreign entry (B\'s signature under A), owner not connected: the request carries no read headers, the entry is removed, the 401 asks to sign', async () => {
    const foreign = await plant(B)
    expect(cached({ foreign })).toBe('foreign') // it IS there before the read
    await expect(fetchUserOrders(WALLET)).rejects.toBeInstanceOf(ReadAuthRequiredError)
    expect(sent({ foreign })).toEqual(['none'])
    expect(cached({ foreign })).toBe('nothing')
  })

  it('fetchActiveOrders (the poll), foreign entry: no request carries it, the entry is removed, the 401 asks to sign', async () => {
    const foreign = await plant(B)
    await expect(fetchActiveOrders(WALLET, [hash(1), hash(2)])).rejects.toBeInstanceOf(ReadAuthRequiredError)
    expect(sent({ foreign })).toEqual(['none'])
    expect(cached({ foreign })).toBe('nothing')
  })

  it('fetchActiveOrders split in several requests: a foreign entry planted BETWEEN two of them is not sent on the later one', async () => {
    const own = await plant(A)
    const all = Array.from({ length: ORDER_POLL_MAX_HASHES + 5 }, (_, i) => hash(i + 1))
    let foreign: Entry | null = null
    fetchMock.mockImplementation(async (_url, init) => {
      if (!foreign) foreign = await plant(B) // swapped in while the first request is in flight
      return init?.headers ? new Response(JSON.stringify({ orders: [] }), { status: 200 }) : new Response('{}', { status: 401 })
    })
    await expect(fetchActiveOrders(WALLET, all)).rejects.toBeInstanceOf(ReadAuthRequiredError)
    expect(foreign === null).toBe(false)
    expect(sent({ own, foreign })).toEqual(['own', 'none']) // each request verifies what it is about to send
    expect(cached({ own, foreign })).toBe('nothing')
  })

  it('the wallet\'s OWN entry is sent, on both (the check does not drop what it should keep)', async () => {
    const own = await plant(A)
    await expect(fetchUserOrders(WALLET)).resolves.toEqual([{ order_hash: hash(1) }])
    await expect(fetchActiveOrders(WALLET, [hash(1)])).resolves.toEqual([{ order_hash: hash(1) }])
    expect(sent({ own })).toEqual(['own', 'own'])
    expect(cached({ own })).toBe('own')
  })

  it('nothing cached: the request carries no read headers (as before)', async () => {
    await expect(fetchUserOrders(WALLET)).rejects.toBeInstanceOf(ReadAuthRequiredError)
    expect(sent()).toEqual(['none'])
  })
})
