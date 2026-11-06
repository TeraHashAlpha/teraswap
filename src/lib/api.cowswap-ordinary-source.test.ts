// @vitest-environment node
/**
 * [feat/retire-force-mev, owner decision 2026-11-06] CoW stays an ORDINARY source after the Force MEV toggle is retired:
 * fetchMetaQuote still calls the cowswap adapter and ranks its answer by the same rule as every other source — it wins when it
 * has the best output and is a plain runner-up when it does not. Fake-ADAPTER_REGISTRY convention from
 * api.zerox-breaker-fanout.test.ts (live getter + vi.resetModules() per test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DEXAdapter } from '@/lib/adapters'

let fakeRegistry: DEXAdapter[] = []

vi.mock('@/lib/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters')>()
  return { ...actual, get ADAPTER_REGISTRY() { return fakeRegistry } }
})
// Same reason as api.zerox-breaker-fanout.test.ts: no real Redis round trip on the breaker's cold-start KV pre-seed.
vi.mock('@/lib/source-state-machine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/source-state-machine')>()
  return { ...actual, getAllStatuses: async () => [] }
})

function adapter(name: DEXAdapter['name'], toAmount: string, spy = vi.fn()): DEXAdapter {
  return {
    name,
    fetchQuote: async (...args: unknown[]) => {
      spy(...args)
      return { source: name, toAmount, estimatedGas: name === 'cowswap' ? 0 : 100_000, gasUsd: name === 'cowswap' ? 0 : 1, routes: [] }
    },
    fetchSwapData: async () => { throw new Error('not exercised by this test') },
  }
}

async function loadApi() {
  vi.resetModules()
  return import('@/lib/api')
}

describe('fetchMetaQuote — CoW is still queried and ranked like any source [retire-force-mev]', () => {
  beforeEach(() => { fakeRegistry = [] })
  afterEach(() => { vi.restoreAllMocks() })

  it('CoW with the best output is best', async () => {
    const cowSpy = vi.fn()
    fakeRegistry = [adapter('1inch', '2000000'), adapter('cowswap', '2100000', cowSpy)]
    const { fetchMetaQuote } = await loadApi()
    const result = await fetchMetaQuote('0xsrc', '0xdst', '1000000000000000000', 18, 18, undefined, 1)
    expect(cowSpy).toHaveBeenCalledTimes(1)
    expect(result.best.source).toBe('cowswap')
    expect(result.all.map((q) => q.source)).toEqual(['cowswap', '1inch'])
  })

  it('CoW with a lower output is queried, listed, and a plain runner-up (no forced preference)', async () => {
    const cowSpy = vi.fn()
    fakeRegistry = [adapter('1inch', '2100000'), adapter('cowswap', '2000000', cowSpy)]
    const { fetchMetaQuote } = await loadApi()
    const result = await fetchMetaQuote('0xsrc', '0xdst', '1000000000000000000', 18, 18, undefined, 1)
    expect(cowSpy).toHaveBeenCalledTimes(1)
    expect(result.best.source).toBe('1inch')
    expect(result.all.map((q) => q.source)).toContain('cowswap')
  })
})

describe('the real registry still integrates CoW', () => {
  it('cowswap is registered and not disabled', async () => {
    const actual = await vi.importActual<typeof import('@/lib/adapters')>('@/lib/adapters')
    const { DISABLED_SOURCES } = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants')
    expect(actual.ADAPTER_REGISTRY.map((a) => a.name)).toContain('cowswap')
    expect(DISABLED_SOURCES).not.toHaveProperty('cowswap')
  })
})
