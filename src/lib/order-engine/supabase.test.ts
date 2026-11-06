// @vitest-environment jsdom
/**
 * [CHORE-DCA-UX-FIXES] Bug 3b — the active-order poll must catch TERMINAL transitions: when the keeper marks an order
 * 'failed' (or 'executed'/'cancelled'/'expired'), the poll must see it, or the order stays "active" in the UI forever.
 *
 * [fix/user-ip-privacy A76 S-6] The poll now asks for the orders the browser TRACKS, by order hash, with no status
 * filter — so every transition (terminal ones included) comes back for exactly those orders. It used to ask for the
 * wallet's 50 newest rows in seven statuses: an order older than those 50 was never updated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchActiveOrders } from './supabase'
import { ReadAuthRequiredError, ORDER_POLL_MAX_HASHES } from './read-auth'

const fetchMock = vi.fn()
const WALLET = '0xABCdef0000000000000000000000000000000001'
const hash = (i: number) => `0x${i.toString(16).padStart(64, '0')}`

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('fetchActiveOrders — poll query by order hash [A76 S-6]', () => {
  it('asks for exactly the tracked hashes, with no status filter (so terminal transitions come back too — Bug 3b)', async () => {
    await fetchActiveOrders(WALLET, [hash(1), hash(2)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost')
    expect(url.pathname).toBe('/api/orders')
    expect(url.searchParams.get('wallet')).toBe(WALLET)
    expect(url.searchParams.get('hashes')).toBe(`${hash(1)},${hash(2)}`)
    expect(url.searchParams.get('status')).toBeNull()
  })

  it('returns the rows the server answers for those hashes', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ orders: [{ order_hash: hash(1), status: 'failed' }] }), { status: 200 }))
    await expect(fetchActiveOrders(WALLET, [hash(1)])).resolves.toEqual([{ order_hash: hash(1), status: 'failed' }])
  })

  it('nothing tracked → no request at all', async () => {
    await expect(fetchActiveOrders(WALLET, [])).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('de-duplicates and drops anything that is not an order hash', async () => {
    await fetchActiveOrders(WALLET, [hash(1), hash(1), 'nope', '0x12', hash(2)])
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost')
    expect(url.searchParams.get('hashes')).toBe(`${hash(1)},${hash(2)}`)
  })

  it(`splits more than ${ORDER_POLL_MAX_HASHES} hashes into several requests, and merges their rows`, async () => {
    fetchMock.mockImplementation(async (u: string) => {
      const asked = new URL(u, 'http://localhost').searchParams.get('hashes')!.split(',')
      return new Response(JSON.stringify({ orders: asked.map((h) => ({ order_hash: h })) }), { status: 200 })
    })
    const all = Array.from({ length: 120 }, (_, i) => hash(i + 1))
    const rows = await fetchActiveOrders(WALLET, all)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [u] of fetchMock.mock.calls) {
      expect(new URL(String(u), 'http://localhost').searchParams.get('hashes')!.split(',').length).toBeLessThanOrEqual(ORDER_POLL_MAX_HASHES)
    }
    expect(rows.map((r) => r.order_hash)).toEqual(all)
  })

  it('a 401 still asks the caller to sign (ReadAuthRequiredError), as before', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 401 }))
    await expect(fetchActiveOrders(WALLET, [hash(1)])).rejects.toBeInstanceOf(ReadAuthRequiredError)
  })
})
