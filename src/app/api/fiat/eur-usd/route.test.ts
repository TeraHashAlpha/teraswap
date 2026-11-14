import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockLimit = vi.fn()
vi.mock('@/lib/kv-rate-limiter', () => ({ checkRateLimitWithin: (...a: unknown[]) => mockLimit(...a) }))

const readContract = vi.fn()
vi.mock('@/lib/chains/clients', () => ({ getPublicClientForChain: vi.fn(() => ({ readContract })) }))

import { GET, _resetEurRateCache } from './route'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  it('market hours: Saturday with Friday\'s round → 200; Wednesday with a 30 h round → 503', async () => {
    try {
      vi.setSystemTime(new Date('2026-11-14T12:00:00Z'))
      chain({ updatedAt: BigInt(Date.parse('2026-11-13T20:00:00Z') / 1000) })
      expect((await GET(req())).status).toBe(200)
      _resetEurRateCache()
      vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
      chain({ updatedAt: BigInt(Date.parse('2026-11-10T06:00:00Z') / 1000) })
      expect((await GET(req())).status).toBe(503)
    } finally {
      vi.useRealTimers()
    }
  })
  it('stale round → 503 "EUR rate unavailable"', async () => {
    try {
      // A Wednesday: on the real clock this fails every Sunday, when the closed FX market makes the route accept a round this old.
      vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
      chain({ updatedAt: now() - 200_000n })
      const res = await GET(req())
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'EUR rate unavailable' })
    } finally {
      vi.useRealTimers()
    }
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
  it('a hung chain read is cut at the deadline: 503, and the function is not held open', async () => {
    vi.useFakeTimers()
    try {
      readContract.mockImplementation(() => new Promise(() => {}))
      const pending = GET(req())
      await vi.advanceTimersByTimeAsync(6_500)
      const res = await pending
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'EUR rate unavailable' })
    } finally {
      vi.useRealTimers()
    }
  })
  it('the limiter is checkRateLimitWithin (bounded), keyed by the client-ip hash, and nothing else waits on KV', async () => {
    chain()
    await GET(req())
    expect(mockLimit).toHaveBeenCalledTimes(1)
    expect(mockLimit.mock.calls[0][0]).toMatch(/^fiat-eur-usd:/)
    const src = readFileSync(join(__dirname, 'route.ts'), 'utf8')
    expect(src).toMatch(/checkRateLimitWithin/)
    expect(src).not.toMatch(/\bcheckRateLimit\(/)
    expect(src).not.toMatch(/trustedClientIp|x-forwarded-for/i)
  })
  it('an unsupported chain is a 400 with a fixed message, never a silent mainnet answer; a supported L2 reads the mainnet feed', async () => {
    chain()
    const bad = await GET(req('?chainId=999999'))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Invalid chainId' })
    expect(readContract).not.toHaveBeenCalled()
    expect((await GET(req('?chainId=8453'))).status).toBe(200)
  })
  it('the upstream is fixed server-side: the request cannot name a host, and no error carries one', async () => {
    readContract.mockRejectedValue(new Error('connect ECONNREFUSED https://eth-mainnet.g.alchemy.com/v2/SECRETKEY'))
    const res = await GET(req('?chainId=1&rpc=https://evil.example&url=https://evil.example'))
    const text = JSON.stringify(await res.json())
    expect(res.status).toBe(503)
    expect(text).not.toMatch(/alchemy|SECRETKEY|evil|https?:/)
    const src = readFileSync(join(__dirname, 'route.ts'), 'utf8')
    expect(src).not.toMatch(/searchParams\.get\('(rpc|url|host)'/)
  })
  it('rate limited → 429; bad chainId → 400', async () => {
    mockLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 1 })
    expect((await GET(req())).status).toBe(429)
    mockLimit.mockResolvedValue({ allowed: true, remaining: 1, resetAt: 1 })
    expect((await GET(req('?chainId=abc'))).status).toBe(400)
    expect((await GET(req('?chainId=-1'))).status).toBe(400)
  })
})
