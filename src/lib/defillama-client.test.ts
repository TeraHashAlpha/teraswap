/**
 * [fix/functional-chain-ui C8] The browser's DefiLlama lookup only ever calls the same-origin route,
 * and keeps fetchDefiLlamaPrice's contract: a price, or null on any miss or failure (never throws).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchDefiLlamaPriceViaApi } from './defillama-client'

const UNI_BASE = '0xc3De830EA07524a0761646a6a4e4be0e114a3C83'
const PRICE = { price: 7.557, symbol: 'UNI', timestamp: 1, confidence: 0.99 }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchDefiLlamaPriceViaApi', () => {
  it('asks /api/price/defillama with chainId + address and returns the price', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ price: PRICE }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchDefiLlamaPriceViaApi(UNI_BASE, 8453)).toEqual(PRICE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/price/defillama?chainId=8453&address=${UNI_BASE}`)
  })

  it.each([
    ['a null price', () => new Response(JSON.stringify({ price: null }), { status: 200 })],
    ['a 400', () => new Response('{"error":"Invalid chainId or address"}', { status: 400 })],
    ['a 429', () => new Response('{}', { status: 429 })],
    ['a non-JSON body', () => new Response('<html>', { status: 200 })],
  ])('returns null for %s', async (_label, make) => {
    vi.stubGlobal('fetch', vi.fn(async () => make()))
    expect(await fetchDefiLlamaPriceViaApi(UNI_BASE, 8453)).toBeNull()
  })

  it('returns null (never throws) on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(fetchDefiLlamaPriceViaApi(UNI_BASE, 8453)).resolves.toBeNull()
  })
})
