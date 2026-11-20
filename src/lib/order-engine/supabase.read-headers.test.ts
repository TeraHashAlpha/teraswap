// @vitest-environment jsdom
/**
 * [A100 R2-1] The two list fetchers (fetchUserOrders: the Orders tab's load; fetchActiveOrders: its 10 s poll) send a cached
 * read signature only after it was verified to be the wallet's OWN. A foreign entry (another account's signature cached
 * under this wallet, which a build without the recover check wrote in an account-switch race) is dropped and never sent:
 * the request goes out without the two headers and the server's 401 takes the usual sign-once path.
 *
 * Real signatures (viem local accounts); the server is a mock that records what each request carried. No signature is printed.
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
const fetchMock = vi.fn<(url: string, init?: Init) => Promise<Response>>()
const sentHeaders = () => fetchMock.mock.calls.map(([, init]) => init?.headers)

async function plant(signer: typeof A): Promise<{ issuedAt: number; signature: string }> {
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
    await plant(B)
    await expect(fetchUserOrders(WALLET)).rejects.toBeInstanceOf(ReadAuthRequiredError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sentHeaders()).toEqual([undefined])
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
  })

  it('fetchActiveOrders (the poll), foreign entry: no request carries it, the entry is removed, the 401 asks to sign', async () => {
    await plant(B)
    await expect(fetchActiveOrders(WALLET, [hash(1), hash(2)])).rejects.toBeInstanceOf(ReadAuthRequiredError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sentHeaders()).toEqual([undefined])
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
  })

  it('fetchActiveOrders split in several requests: a foreign entry planted BETWEEN two of them is not sent on the later one', async () => {
    const own = await plant(A)
    const all = Array.from({ length: ORDER_POLL_MAX_HASHES + 5 }, (_, i) => hash(i + 1))
    let foreign: { issuedAt: number; signature: string } | null = null
    fetchMock.mockImplementation(async (_url, init) => {
      if (!foreign) foreign = await plant(B) // swapped in while the first request is in flight
      return init?.headers ? new Response(JSON.stringify({ orders: [] }), { status: 200 }) : new Response('{}', { status: 401 })
    })
    await expect(fetchActiveOrders(WALLET, all)).rejects.toBeInstanceOf(ReadAuthRequiredError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentHeaders()[0]?.[ORDERS_READ_HEADER_SIGNATURE]).toBe(own.signature)
    expect(sentHeaders()[1]).toBeUndefined() // each request verifies what it is about to send
    expect(foreign).not.toBeNull()
  })

  it('the wallet\'s OWN entry is sent, on both (the check does not drop what it should keep)', async () => {
    const own = await plant(A)
    const expected = { [ORDERS_READ_HEADER_ISSUED]: String(own.issuedAt), [ORDERS_READ_HEADER_SIGNATURE]: own.signature }
    await expect(fetchUserOrders(WALLET)).resolves.toEqual([{ order_hash: hash(1) }])
    await expect(fetchActiveOrders(WALLET, [hash(1)])).resolves.toEqual([{ order_hash: hash(1) }])
    expect(sentHeaders()).toEqual([expected, expected])
    expect(getCachedOrdersReadAuth(WALLET)?.signature).toBe(own.signature)
  })

  it('nothing cached: the request carries no read headers (as before)', async () => {
    await expect(fetchUserOrders(WALLET)).rejects.toBeInstanceOf(ReadAuthRequiredError)
    expect(sentHeaders()).toEqual([undefined])
  })
})
