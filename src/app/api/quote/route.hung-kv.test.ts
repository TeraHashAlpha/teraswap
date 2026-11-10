// @vitest-environment node
/**
 * [fix/quote-limiter-music-toggle A76b] /api/quote must ANSWER when Redis hangs (never answers at all).
 *
 * Everything between the request and the response that touches KV is the REAL code here — halt check
 * (circuit-breaker), limiter (checkRateLimitWithin), quote cache (meta-quote-cache) — over a Redis client whose
 * every call hangs. Only the source fan-out (fetchMetaQuote) is a mock that answers at once.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { kv } from '@/lib/kv'
import { _internal as cacheInternal } from '@/lib/meta-quote-cache'

const hang = vi.hoisted(() => () => new Promise<never>(() => {}))
vi.mock('@/lib/kv', () => {
  const p: Record<string, unknown> = {}
  for (const m of ['zremrangebyscore', 'zcard', 'zadd', 'expire']) p[m] = () => p
  p.exec = hang
  return { kv: { get: vi.fn(hang), set: vi.fn(hang), zrem: vi.fn(hang), zrange: vi.fn(hang), pipeline: () => p } }
})
vi.mock('@/lib/source-monitor', () => ({ recordSourcePing: vi.fn() }))
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

describe('/api/quote with a hung Redis answers a normal quote in < 5 s', () => {
  it('the cache bound is never above the KV bound of the route', () => {
    expect(cacheInternal.CACHE_KV_TIMEOUT_MS).toBeLessThanOrEqual(cacheInternal.KV_GATE_TIMEOUT_MS)
  })

  it('GET', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { GET } = await import('./route')
    const t0 = Date.now()
    const res = await GET(
      new NextRequest(`http://localhost/api/quote?src=${WETH}&dst=${USDC}&amount=1000000000000000000&srcDecimals=18&dstDecimals=6`, {
        headers: { 'x-real-ip': '203.0.113.7' },
      }),
    )
    const ms = Date.now() - t0
    console.info(`[hung-kv] GET answered in ${ms} ms`)
    expect(res.status).toBe(200)
    expect((await res.json()).best.source).toBe('uniswapv3')
    expect(res.headers.get('X-Quote-Cache')).toBe('miss')
    expect(ms).toBeLessThan(5_000)
    expect(kv.set).not.toHaveBeenCalled() // the read timed out -> no second bound spent on a write
  }, 20_000)

  it('POST', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { POST } = await import('./route')
    const t0 = Date.now()
    const res = await POST(
      new NextRequest('http://localhost/api/quote', {
        method: 'POST',
        headers: { 'x-real-ip': '198.51.100.9', 'content-type': 'application/json' },
        body: JSON.stringify({ src: WETH, dst: USDC, amount: '2000000000000000000', srcDecimals: 18, dstDecimals: 6 }),
      }),
    )
    const ms = Date.now() - t0
    console.info(`[hung-kv] POST answered in ${ms} ms`)
    expect(res.status).toBe(200)
    expect(ms).toBeLessThan(5_000)
  }, 20_000)
})
