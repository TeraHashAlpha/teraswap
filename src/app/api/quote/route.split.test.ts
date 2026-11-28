// @vitest-environment node
/**
 * [fix/quote-rate-limit-normal-use] GET /api/quote?split=1 — the split analysis' sub-amount quotes in ONE request.
 *
 * Same gates and caches as 11 separate requests, and charged for the upstream work it triggers: 1 unit on `quote:` (the
 * request) plus 1 unit per sub-amount on the `quote-split:` bucket (owner decision 2026-11-27). The REAL limiter and the
 * REAL meta-quote cache run here over an in-memory KV; only fetchMetaQuote (the upstream fan-out) is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({ fake: null as null | ReturnType<typeof import('@/test-utils/fake-kv').createFakeKv> }))
vi.mock('@/lib/kv', async () => {
  const { createFakeKv } = await import('@/test-utils/fake-kv')
  h.fake = createFakeKv()
  return { kv: h.fake.kv }
})
vi.mock('@/lib/circuit-breaker', () => ({ isSystemHalted: vi.fn().mockResolvedValue(false) }))

const quoteFor = (amount: string) => ({
  source: 'velora',
  toAmount: (BigInt(amount) * 2n).toString(),
  estimatedGas: 0,
  gasUsd: 0,
  routes: [],
})
const fetchMetaQuote = vi.fn(async (_src: string, _dst: string, amount: string) => ({
  best: quoteFor(amount),
  all: [quoteFor(amount)],
  fetchedAt: Date.now(),
}))
vi.mock('@/lib/api', () => ({
  fetchMetaQuote: (...a: unknown[]) => fetchMetaQuote(...(a as [string, string, string])),
  diagnoseQuoteSources: vi.fn(),
}))

const WETH = '0xC02aaA39b223FE8D0A6e5c4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const TOTAL = '1000000000000000000'
/** Every sub-percentage of SPLIT_CONFIGS_2WAY / 3WAY except 100: the 11 amounts the hook asked for one by one. */
const PERCENTS = [50, 60, 40, 70, 30, 80, 20, 25, 15, 34, 33]
const SUBS = PERCENTS.map((p) => ((BigInt(TOTAL) * BigInt(p)) / 100n).toString())

const req = (amount = TOTAL, extra = '&split=1', ip = '203.0.113.7') =>
  new NextRequest(`http://localhost/api/quote?src=${WETH}&dst=${USDC}&amount=${amount}&srcDecimals=18&dstDecimals=6${extra}`, {
    headers: { 'x-real-ip': ip },
  })

async function GET(r: NextRequest) {
  const res = await (await import('./route')).GET(r)
  return { res, body: await res.json() }
}

describe('GET /api/quote?split=1', () => {
  beforeEach(async () => {
    h.fake?.reset()
    fetchMetaQuote.mockClear()
    const { _internal } = await import('@/lib/kv-rate-limiter')
    _internal.reset()
    const cache = await import('@/lib/meta-quote-cache')
    cache._internal.localQuoteDampenerCache.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers the single quote AND every sub-amount in one request', async () => {
    const { res, body } = await GET(req())
    expect(res.status).toBe(200)
    expect(body.best.toAmount).toBe(quoteFor(TOTAL).toAmount)
    expect(body.amountIn).toBe(TOTAL)
    expect(body.split.status).toBe('ok')
    expect(Object.keys(body.split.quotes).sort()).toEqual([...SUBS].sort())
    for (const sub of SUBS) expect(body.split.quotes[sub]).toEqual([quoteFor(sub)])
    expect(fetchMetaQuote).toHaveBeenCalledTimes(12)
  })

  it('charges 1 unit on quote: for the request and 1 unit per sub-amount on quote-split:', async () => {
    await GET(req())
    expect(h.fake!.units('quote')).toBe(1)
    expect(h.fake!.units('quote-split')).toBe(11)
  })

  it('a sub-quote fans out like a plain sub-amount request did: same chain, no source exclusions', async () => {
    await GET(req(TOTAL, '&split=1&chainId=8453&exclude=velora'))
    const subCalls = fetchMetaQuote.mock.calls.filter((c) => c[2] !== TOTAL) as unknown as unknown[][]
    expect(subCalls).toHaveLength(11)
    for (const c of subCalls) {
      expect(c[0]).toBe(WETH)
      expect(c[1]).toBe(USDC)
      expect(c[3]).toBe(18)
      expect(c[4]).toBe(6)
      expect(c[5]).toBeUndefined()
      expect(c[6]).toBe(8453)
    }
    const main = fetchMetaQuote.mock.calls.find((c) => c[2] === TOTAL) as unknown as unknown[]
    expect(main[5]).toEqual(['velora'])
  })

  it('shares the quote cache with plain requests: a cached sub-amount costs no second fan-out, but is still charged', async () => {
    await GET(req(SUBS[0], ''))
    expect(fetchMetaQuote).toHaveBeenCalledTimes(1)
    await GET(req())
    expect(fetchMetaQuote).toHaveBeenCalledTimes(12) // the main amount + the 10 sub-amounts not cached yet
    expect(h.fake!.units('quote-split')).toBe(11)
  })

  it('6 split calls spend the 66-unit bucket; the 7th still answers the quote, defers the split and runs no sub fan-out', async () => {
    for (let i = 1; i <= 6; i++) expect((await GET(req(`${i}000000000000000000`))).body.split.status).toBe('ok')
    fetchMetaQuote.mockClear()
    const { res, body } = await GET(req('7000000000000000000'))
    expect(res.status).toBe(200)
    expect(body.best.toAmount).toBe(quoteFor('7000000000000000000').toAmount)
    expect(body.split.status).toBe('deferred')
    expect(body.split.retryAfterMs).toBeGreaterThan(0)
    expect(body.split.retryAfterMs).toBeLessThanOrEqual(60_000)
    expect(body.split.quotes).toBeUndefined()
    expect(fetchMetaQuote).toHaveBeenCalledTimes(1)
    expect(h.fake!.units('quote-split')).toBe(66) // a refused charge leaves nothing behind
    expect(h.fake!.units('quote')).toBe(7)
  })

  it('a spent split bucket never limits a plain quote; the quote limit stays 30 and a refused request charges no split units', async () => {
    for (let i = 1; i <= 6; i++) await GET(req(`${i}000000000000000000`))
    for (let i = 7; i <= 30; i++) expect((await GET(req(`${i}000000000000000000`, ''))).res.status).toBe(200)
    const splitBefore = h.fake!.units('quote-split')
    const { res } = await GET(req('31000000000000000000'))
    expect(res.status).toBe(429)
    expect(h.fake!.units('quote-split')).toBe(splitBefore)
    expect(splitBefore).toBe(66)
  })

  it('a sub-amount whose fan-out fails answers an empty list, as its failed request did; the quote still answers', async () => {
    fetchMetaQuote.mockImplementation(async (_s: string, _d: string, amount: string) => {
      if (amount === SUBS[3]) throw new Error('No valid quotes.')
      return { best: quoteFor(amount), all: [quoteFor(amount)], fetchedAt: Date.now() }
    })
    const { res, body } = await GET(req())
    expect(res.status).toBe(200)
    expect(body.split.quotes[SUBS[3]]).toEqual([])
    expect(body.split.quotes[SUBS[4]]).toEqual([quoteFor(SUBS[4])])
    fetchMetaQuote.mockImplementation(async (_s: string, _d: string, amount: string) => ({ best: quoteFor(amount), all: [quoteFor(amount)], fetchedAt: Date.now() }))
  })

  /** Holds the `quote-split:` charge open until released. Fake clock: the limiter's own 1 s deadline never fires. */
  async function heldSplitCharge() {
    await import('./route')
    const { kv } = await import('@/lib/kv')
    const real = kv.pipeline.bind(kv)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const spy = vi.spyOn(kv, 'pipeline').mockImplementation(() => {
      const p = real() as unknown as { zremrangebyscore: (key: string, min: number, max: number) => unknown; exec: () => Promise<unknown[]> }
      const { zremrangebyscore, exec } = p
      let isSplitCharge = false
      p.zremrangebyscore = (key, min, max) => {
        isSplitCharge ||= key.startsWith('ratelimit:quote-split:')
        return zremrangebyscore(key, min, max)
      }
      p.exec = async () => {
        if (isSplitCharge) await gate
        return exec()
      }
      return p as unknown as ReturnType<typeof real>
    })
    vi.useFakeTimers()
    return { release, restore: () => spy.mockRestore() }
  }
  const amountsFannedOut = () => fetchMetaQuote.mock.calls.map((c) => c[2])

  it('starts the main quote lookup before it awaits the split charge; no sub-amount fans out before the charge answers', async () => {
    const charge = await heldSplitCharge()
    try {
      const answer = GET(req())
      await vi.advanceTimersByTimeAsync(10)
      expect(amountsFannedOut()).toEqual([TOTAL])
      charge.release()
      await vi.advanceTimersByTimeAsync(10)
      const { res, body } = await answer
      expect(res.status).toBe(200)
      expect(body.split.status).toBe('ok')
      expect(fetchMetaQuote).toHaveBeenCalledTimes(12)
      expect(h.fake!.units('quote-split')).toBe(11)
    } finally {
      charge.restore()
    }
  })

  it('a main quote that fails while the split charge is pending: the answer still waits for the charge, which is made', async () => {
    fetchMetaQuote.mockImplementation(async (_s: string, _d: string, amount: string) => {
      if (amount === TOTAL) throw new Error('No valid quotes.')
      return { best: quoteFor(amount), all: [quoteFor(amount)], fetchedAt: Date.now() }
    })
    const charge = await heldSplitCharge()
    try {
      let answered = false
      const answer = GET(req()).then((r) => { answered = true; return r })
      await vi.advanceTimersByTimeAsync(10)
      expect(amountsFannedOut()).toEqual([TOTAL]) // the lookup has already run, and failed
      expect(answered).toBe(false)
      charge.release()
      await vi.advanceTimersByTimeAsync(10)
      expect((await answer).res.status).toBe(502)
      expect(h.fake!.units('quote-split')).toBe(11)
    } finally {
      charge.restore()
      fetchMetaQuote.mockImplementation(async (_s: string, _d: string, amount: string) => ({ best: quoteFor(amount), all: [quoteFor(amount)], fetchedAt: Date.now() }))
    }
  })

  it('without split=1 the response has no split field and nothing is charged to quote-split:; with it, only that field is added', async () => {
    const plain = (await GET(req(TOTAL, ''))).body
    expect(plain.split).toBeUndefined()
    expect(h.fake!.units('quote-split')).toBe(0)
    const withSplit = (await GET(req())).body
    expect(Object.keys(withSplit).filter((k) => k !== 'split').sort()).toEqual(Object.keys(plain).sort())
    expect(Object.keys(withSplit)).toContain('split')
  })
})
