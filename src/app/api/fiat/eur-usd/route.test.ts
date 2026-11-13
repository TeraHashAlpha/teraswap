import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockLimit = vi.fn()
vi.mock('@/lib/kv-rate-limiter', () => ({ checkRateLimitWithin: (...a: unknown[]) => mockLimit(...a) }))

const readContract = vi.fn()
vi.mock('@/lib/chains/clients', () => ({ getPublicClientForChain: vi.fn(() => ({ readContract })) }))

import { GET, _resetEurRateCache } from './route'
import config from '@/config/eur-usd-feed.json'

const FEED = (config.chains as Record<string, { feed: string }>)['1'].feed
const now = () => BigInt(Math.floor(Date.now() / 1000))
const req = (q = '') => new NextRequest(`http://localhost/api/fiat/eur-usd${q}`)

function chain(over: { description?: string; decimals?: number; answer?: bigint; updatedAt?: bigint; roundId?: bigint; answeredInRound?: bigint } = {}) {
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'description') return over.description ?? 'EUR / USD'
    if (functionName === 'decimals') return over.decimals ?? 8
    return [over.roundId ?? 10n, over.answer ?? 110_489_000n, 1n, over.updatedAt ?? now() - 600n, over.answeredInRound ?? over.roundId ?? 10n]
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetEurRateCache()
  mockLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: Date.now() + 60_000 })
})

describe('GET /api/fiat/eur-usd', () => {
  it('golden path: the rate, the round time and the ceiling, edge-cached for an hour; the feed is the config row', async () => {
    chain()
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rate).toBeCloseTo(1.10489)
    expect(body.maxStaleness).toBe(90000)
    expect(typeof body.updatedAt).toBe('number')
    expect(res.headers.get('Cache-Control')).toMatch(/s-maxage=3600/)
    expect(readContract.mock.calls.every(([a]) => a.address === FEED)).toBe(true)
    expect(readContract).toHaveBeenCalledTimes(3) // description, decimals, latestRoundData
  })
  it('the cost: a second request inside the hour reads nothing from the chain', async () => {
    chain()
    await GET(req())
    await GET(req('?chainId=8453'))
    await GET(req('?chainId=42161'))
    expect(readContract).toHaveBeenCalledTimes(3)
  })
  it('stale round → 503 "EUR rate unavailable"', async () => {
    chain({ updatedAt: now() - 200_000n })
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'EUR rate unavailable' })
  })
  it('wrong identity, bad decimals, non-positive answer, carried-over round → 503', async () => {
    for (const over of [{ description: 'ETH / USD' }, { decimals: 18 }, { answer: 0n }, { answer: -1n }, { roundId: 5n, answeredInRound: 4n }]) {
      _resetEurRateCache()
      chain(over)
      expect((await GET(req())).status, JSON.stringify(over, (_, v) => (typeof v === 'bigint' ? String(v) : v))).toBe(503)
    }
  })
  it('an RPC failure → 503 with a fixed message (no upstream text)', async () => {
    readContract.mockRejectedValue(new Error('https://provider.example/KEY failed'))
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).not.toContain('provider')
  })
  it('rate limited → 429; bad chainId → 400', async () => {
    mockLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 1 })
    expect((await GET(req())).status).toBe(429)
    mockLimit.mockResolvedValue({ allowed: true, remaining: 1, resetAt: 1 })
    expect((await GET(req('?chainId=abc'))).status).toBe(400)
    expect((await GET(req('?chainId=-1'))).status).toBe(400)
  })
})
