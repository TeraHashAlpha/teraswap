// @vitest-environment node
/**
 * [T4 / fix/zerox-quote-hygiene] Acceptance: an OPEN 0x breaker (tripped by a
 * 429) removes 0x from fetchMetaQuote's fan-out, and the meta-quote still
 * resolves cleanly from the other sources — the fan-out already filters on
 * `!cb.isOpen()` (api.ts), this pins that the 429-immediate-open path (T4)
 * feeds that filter correctly, end to end.
 *
 * Follows the fake-ADAPTER_REGISTRY convention from api.diagnose.test.ts —
 * a live getter so each test controls its own source set, with
 * vi.resetModules() + a dynamic import of '@/lib/api' so the module graph
 * (including the circuit-breaker registry) is fresh per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DEXAdapter } from '@/lib/adapters'

let fakeRegistry: DEXAdapter[] = []

vi.mock('@/lib/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters')>()
  return { ...actual, get ADAPTER_REGISTRY() { return fakeRegistry } }
})

function zeroxThrowing(message: string): DEXAdapter {
  return {
    name: '0x' as const,
    fetchQuote: async () => { throw new Error(message) },
    fetchSwapData: async () => { throw new Error('not exercised by this test') },
  }
}

function okAdapter(name: DEXAdapter['name'], toAmount: string): DEXAdapter {
  return {
    name,
    fetchQuote: async () => ({ source: name, toAmount, estimatedGas: 100_000, gasUsd: 1, routes: [] }),
    fetchSwapData: async () => { throw new Error('not exercised by this test') },
  }
}

async function loadApi() {
  vi.resetModules()
  return import('@/lib/api')
}

describe('fetchMetaQuote — 0x breaker OPEN via 429 still resolves from other sources [T4 acceptance]', () => {
  beforeEach(() => {
    fakeRegistry = []
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a 429 on the FIRST call opens the 0x breaker immediately; the meta-quote still resolves via 1inch', async () => {
    fakeRegistry = [zeroxThrowing('0x 429 retryAfterMs=300000'), okAdapter('1inch', '2000000')]
    const { fetchMetaQuote } = await loadApi()

    const result = await fetchMetaQuote('0xsrc', '0xdst', '1000000000000000000', 18, 18, undefined, 1)

    expect(result.best.source).toBe('1inch')
    expect(result.all.map((q) => q.source)).toEqual(['1inch'])
  })

  it('a SECOND, later call never re-invokes the failing 0x adapter (breaker stays OPEN) and still resolves', async () => {
    const zeroxSpy = vi.fn(async () => { throw new Error('0x 429 retryAfterMs=300000') })
    fakeRegistry = [
      { name: '0x' as const, fetchQuote: zeroxSpy, fetchSwapData: async () => { throw new Error('n/a') } },
      okAdapter('1inch', '2000000'),
    ]
    const { fetchMetaQuote } = await loadApi()

    await fetchMetaQuote('0xsrc', '0xdst', '1000000000000000000', 18, 18, undefined, 1)
    expect(zeroxSpy).toHaveBeenCalledTimes(1)

    // Different amount → different quote-cache key, so this is a genuinely fresh fan-out,
    // not a cache hit papering over whether 0x would have been called again.
    const result = await fetchMetaQuote('0xsrc', '0xdst', '2000000000000000000', 18, 18, undefined, 1)

    expect(zeroxSpy).toHaveBeenCalledTimes(1) // OPEN breaker skipped it — no second call
    expect(result.best.source).toBe('1inch')
    expect(result.all.every((q) => q.source !== '0x')).toBe(true)
  })
})
