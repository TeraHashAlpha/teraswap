// @vitest-environment node
/**
 * [fix/quote-limiter-music-toggle A76b S-8] /api/quote's per-IP limit with Redis HUNG.
 *
 * Before: both handlers did `withTimeout(checkRateLimit(...), 3s).catch(onKvTimeout({ allowed: true }))` — a Redis
 * that never answers lifted the limit entirely. Now both call checkRateLimitWithin (as /api/rpc and the CoW proxy
 * do): a bounded wait, then the in-memory limiter at half rate (QUOTE 30/min -> 15/min per IP, per instance).
 *
 * The REAL kv-rate-limiter runs here; only its Redis client is replaced by one whose pipeline never answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

let kvHung = true
const pipelineExec = vi.fn(() => (kvHung ? new Promise(() => {}) : Promise.resolve([0, 0, 1, 1])))
vi.mock('@/lib/kv', () => ({
  kv: {
    pipeline: () => {
      const p = {
        zremrangebyscore: () => p,
        zcard: () => p,
        zadd: () => p,
        expire: () => p,
        exec: () => pipelineExec(),
      }
      return p
    },
    zrem: vi.fn().mockResolvedValue(0),
    zrange: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('@/lib/circuit-breaker', () => ({ isSystemHalted: vi.fn().mockResolvedValue(false) }))
// Isolate the limiter: no quote cache, straight to the (mock) fetch.
vi.mock('@/lib/meta-quote-cache', () => ({
  getMetaQuoteCached: async (_k: unknown, fetcher: () => Promise<unknown>) => ({ result: await fetcher(), cacheHeader: 'miss' }),
}))
const META_RESULT = {
  best: { source: 'uniswapv3', toAmount: '123', estimatedGas: 0, gasUsd: 0, routes: [] },
  all: [{ source: 'uniswapv3', toAmount: '123', estimatedGas: 0, gasUsd: 0, routes: [] }],
  fetchedAt: 42,
}
vi.mock('@/lib/api', () => ({
  fetchMetaQuote: vi.fn().mockResolvedValue(META_RESULT),
  diagnoseQuoteSources: vi.fn(),
}))

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A6e5c4F27eAD9083C756Cc2'
const QS = `src=${WETH}&dst=${USDC}&amount=1000000000000000000&srcDecimals=18&dstDecimals=6`

const getFrom = (ip: string) =>
  new NextRequest(`http://localhost/api/quote?${QS}`, { headers: { 'x-real-ip': ip } })
const postFrom = (ip: string) =>
  new NextRequest('http://localhost/api/quote', {
    method: 'POST',
    headers: { 'x-real-ip': ip, 'content-type': 'application/json' },
    body: JSON.stringify({ src: WETH, dst: USDC, amount: '1000000000000000000', srcDecimals: 18, dstDecimals: 6 }),
  })

/** One request while the clock is fake: start it, let the limiter's 1 s gate elapse, collect the response. */
async function call(handler: (r: NextRequest) => Promise<Response>, req: NextRequest, gateMs = 1_000) {
  const pending = handler(req)
  await vi.advanceTimersByTimeAsync(gateMs)
  return pending
}

describe('/api/quote limiter with a hung Redis [S-8]', () => {
  beforeEach(async () => {
    kvHung = true
    pipelineExec.mockClear()
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { _internal } = await import('@/lib/kv-rate-limiter')
    _internal.reset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  for (const [name, pick] of [
    ['GET', async () => (await import('./route')).GET],
    ['POST', async () => (await import('./route')).POST],
  ] as const) {
    const mk = name === 'GET' ? getFrom : postFrom

    it(`${name}: calls 1-15 from one IP pass, the 16th gets 429 with the unchanged headers`, async () => {
      const handler = await pick()
      for (let i = 1; i <= 15; i++) {
        const res = await call(handler, mk('203.0.113.7'))
        expect(res.status, `call ${i}`).toBe(200)
      }
      const blocked = await call(handler, mk('203.0.113.7'))
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0')
      expect(Number(blocked.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(0)
      expect(await blocked.json()).toEqual({
        error: name === 'GET' ? 'Rate limit exceeded. Try again in a minute.' : 'Rate limit exceeded.',
      })
    })

    it(`${name}: a second IP is unaffected while the first is blocked`, async () => {
      const handler = await pick()
      for (let i = 0; i < 16; i++) await call(handler, mk('203.0.113.7'))
      expect((await call(handler, mk('203.0.113.7'))).status).toBe(429)
      expect((await call(handler, mk('198.51.100.9'))).status).toBe(200)
    })
  }

  it('healthy Redis: unchanged — Redis decides every request (pipeline called each time) and the in-memory fallback is never touched', async () => {
    kvHung = false
    const { GET } = await import('./route')
    const { _internal } = await import('@/lib/kv-rate-limiter')
    for (let i = 0; i < 20; i++) {
      const res = await GET(getFrom('203.0.113.7')) // answers at once: no timer needs to advance
      expect(res.status).toBe(200)
    }
    expect(pipelineExec).toHaveBeenCalledTimes(20)
    expect(_internal.getFallbackMap().size).toBe(0)
  })
})
