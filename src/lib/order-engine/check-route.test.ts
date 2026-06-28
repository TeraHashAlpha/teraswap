/**
 * [CHORE-DCA-UX-FIXES] checkRoute — order-create routability pre-check via /api/quote.
 *
 * Bug 3a: an unroutable pair (e.g. ETHFI → ETH on Base, a thin/imported token with no aggregator
 * route) used to be signable, then the keeper reverted executeOrder and the order failed. checkRoute
 * asks the meta-quote pipeline whether a route exists BEFORE the user approves/signs, so doomed
 * orders are blocked up front. It fails OPEN on transient/ambiguous errors (rate-limit, sequencer
 * down, network) so a quote outage never blocks a legitimate order — only a definitive "no route".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkRoute } from './check-route'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const PARAMS = {
  src: '0x6c240ca4a1a3d8c4c2c7e6b8d6f6e8a4b4c2a2a2',
  dst: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  amount: '1000000000000000000',
  srcDecimals: 18,
  dstDecimals: 18,
  chainId: 8453,
}

describe('checkRoute — routable', () => {
  it('returns routable when /api/quote yields at least one quote', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { best: { toAmount: '990000' }, all: [{ source: 'velora', toAmount: '990000' }] }))
    const res = await checkRoute(PARAMS)
    expect(res.routable).toBe(true)
  })

  it('sends src/dst/amount/decimals/chainId to /api/quote', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { best: { toAmount: '1' }, all: [{ source: 'x', toAmount: '1' }] }))
    await checkRoute(PARAMS)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/api/quote')
    expect(url).toContain(`src=${PARAMS.src}`)
    expect(url).toContain(`dst=${PARAMS.dst}`)
    expect(url).toContain('amount=1000000000000000000')
    expect(url).toContain('srcDecimals=18')
    expect(url).toContain('dstDecimals=18')
    expect(url).toContain('chainId=8453')
  })
})

describe('checkRoute — no route (BLOCK)', () => {
  it('blocks on a 502 "No valid quotes" (every aggregator source failed)', async () => {
    fetchMock.mockResolvedValue(jsonRes(502, { error: 'No valid quotes. all sources failed' }))
    const res = await checkRoute(PARAMS)
    expect(res.routable).toBe(false)
    expect(res.reason).toBeTruthy()
  })

  it('blocks on a 200 with an empty quote set', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { best: null, all: [] }))
    const res = await checkRoute(PARAMS)
    expect(res.routable).toBe(false)
  })
})

describe('checkRoute — fail OPEN on transient/ambiguous errors', () => {
  it('does not block on a network error (fetch throws)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const res = await checkRoute(PARAMS)
    expect(res.routable).toBe(true)
  })

  it('does not block on a rate limit (429)', async () => {
    fetchMock.mockResolvedValue(jsonRes(429, { error: 'Rate limit exceeded.' }))
    const res = await checkRoute(PARAMS)
    expect(res.routable).toBe(true)
  })

  it('does not block when the L2 sequencer is down (503)', async () => {
    fetchMock.mockResolvedValue(jsonRes(503, { error: 'Sequencer down', sequencerDown: true }))
    const res = await checkRoute(PARAMS)
    expect(res.routable).toBe(true)
  })
})
