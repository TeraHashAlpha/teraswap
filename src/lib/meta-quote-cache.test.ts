// @vitest-environment node
/**
 * [T2 / fix/zerox-quote-hygiene] Direct unit tests for the shared meta-quote
 * cache module. The full dampener edge-case matrix (KV-down coalescing,
 * local-cache TTL bound, eviction) is already pinned end-to-end through
 * api/quote/route.test.ts — these tests cover the module's own contract in
 * isolation, plus the KV-healthy single-flight path that's easiest to prove
 * directly against the module (no route/HTTP plumbing in the way).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fakeKvStore = new Map<string, unknown>()
let kvShouldFail = false
vi.mock('./kv', () => ({
  kv: {
    get: vi.fn((key: string) => kvShouldFail
      ? Promise.reject(new Error('upstash unreachable'))
      : Promise.resolve(fakeKvStore.get(key) ?? null)),
    set: vi.fn((key: string, value: unknown) => {
      if (kvShouldFail) return Promise.reject(new Error('upstash unreachable'))
      fakeKvStore.set(key, value)
      return Promise.resolve('OK')
    }),
  },
}))

async function loadModule() {
  vi.resetModules()
  return import('./meta-quote-cache')
}

const RESULT = { best: { source: 'uniswapv3', toAmount: '123', estimatedGas: 0, gasUsd: 0, routes: [] }, all: [], fetchedAt: 1 } as any

describe('metaQuoteCacheKey', () => {
  it('is stable for the same input and mainnet-omitted vs mainnet-explicit are identical', async () => {
    const { metaQuoteCacheKey } = await loadModule()
    const base = { src: '0xAAA', dst: '0xBBB', amount: '1000', srcDecimals: 18, dstDecimals: 18 }
    expect(metaQuoteCacheKey(base)).toBe(metaQuoteCacheKey({ ...base, chainId: 1 }))
  })

  it('differs by chain, pair, amount, decimals, and excludeSources (order-independent)', async () => {
    const { metaQuoteCacheKey } = await loadModule()
    const base = { src: '0xAAA', dst: '0xBBB', amount: '1000', srcDecimals: 18, dstDecimals: 18 }
    expect(metaQuoteCacheKey(base)).not.toBe(metaQuoteCacheKey({ ...base, chainId: 8453 }))
    expect(metaQuoteCacheKey(base)).not.toBe(metaQuoteCacheKey({ ...base, amount: '2000' }))
    expect(metaQuoteCacheKey({ ...base, excludeSources: ['cowswap', '0x'] }))
      .toBe(metaQuoteCacheKey({ ...base, excludeSources: ['0x', 'cowswap'] })) // order-independent
    expect(metaQuoteCacheKey(base)).not.toBe(metaQuoteCacheKey({ ...base, excludeSources: ['0x'] }))
  })

  it('lowercases token addresses (case-insensitive checksum inputs still share one cache entry)', async () => {
    const { metaQuoteCacheKey } = await loadModule()
    const base = { src: '0xAbCd', dst: '0xEfGh'.toLowerCase(), amount: '1000', srcDecimals: 18, dstDecimals: 18 }
    expect(metaQuoteCacheKey(base)).toBe(metaQuoteCacheKey({ ...base, src: '0xABCD' }))
  })
})

describe('getMetaQuoteCached', () => {
  beforeEach(() => {
    fakeKvStore.clear()
    kvShouldFail = false
  })

  const keyInput = { src: '0xAAA', dst: '0xBBB', amount: '1000', srcDecimals: 18, dstDecimals: 18, chainId: 1 }

  it('a KV miss calls the fetcher, tags the result "miss", and writes through to KV', async () => {
    const { getMetaQuoteCached } = await loadModule()
    const fetcher = vi.fn().mockResolvedValue(RESULT)
    const { result, cacheHeader } = await getMetaQuoteCached(keyInput, fetcher)
    expect(cacheHeader).toBe('miss')
    expect(result).toEqual(RESULT)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fakeKvStore.size).toBe(1)
  })

  it('a KV hit never calls the fetcher and tags the result "hit"', async () => {
    const { getMetaQuoteCached, metaQuoteCacheKey } = await loadModule()
    fakeKvStore.set(metaQuoteCacheKey(keyInput), RESULT)
    const fetcher = vi.fn()
    const { result, cacheHeader } = await getMetaQuoteCached(keyInput, fetcher)
    expect(cacheHeader).toBe('hit')
    expect(result).toEqual(RESULT)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('N concurrent identical requests during a KV outage produce exactly 1 fetcher call (single-flight)', async () => {
    kvShouldFail = true
    const { getMetaQuoteCached } = await loadModule()
    let resolveFetch: (v: typeof RESULT) => void
    const fetcher = vi.fn(() => new Promise<typeof RESULT>((resolve) => { resolveFetch = resolve }))

    const calls = Array.from({ length: 5 }, () => getMetaQuoteCached(keyInput, fetcher))
    await new Promise((r) => setTimeout(r, 0)) // let all 5 reach the in-flight check
    resolveFetch!(RESULT)
    const results = await Promise.all(calls)

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(results.every((r) => r.result === RESULT)).toBe(true)
    // Exactly one leader is "fresh"/'miss'; the rest coalesced.
    expect(results.filter((r) => r.cacheHeader === 'miss')).toHaveLength(1)
    expect(results.filter((r) => r.cacheHeader === 'miss-dampened-coalesced')).toHaveLength(4)
  })
})
