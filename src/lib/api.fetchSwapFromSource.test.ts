// @vitest-environment node
/**
 * [T1 + T3 / fix/zerox-quote-hygiene] Unit tests for fetchSwapFromSource's
 * two additions:
 *   T1 — every call records a fire-and-forget quote-build attempt via
 *        recordQuoteBuildAttempt (quote-build-monitor.ts), classified into
 *        'built' | 'sim-failed' | 'upstream-error' | '429'.
 *   T3 — when source === '0x' and a callerIdentity is supplied, a per-
 *        identity build cap (checkRateLimit, kv-rate-limiter.ts) is
 *        consulted BEFORE the adapter is ever called; on exceed, 0x is
 *        skipped with ZeroXQuoteCapExceededError and recorded as '429'.
 *
 * Uses deterministic (non-retried) adapter outcomes throughout — the
 * transient/retry behaviour of withSwapBuildRetry is exercised elsewhere
 * (swap-build-retry.test.ts) and isn't what these tests are pinning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DEXAdapter } from '@/lib/adapters'

let fakeRegistry: DEXAdapter[] = []
vi.mock('@/lib/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters')>()
  return { ...actual, get ADAPTER_REGISTRY() { return fakeRegistry } }
})

const mockRecordQuoteBuildAttempt = vi.fn()
vi.mock('./quote-build-monitor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quote-build-monitor')>()
  return { ...actual, recordQuoteBuildAttempt: (...a: unknown[]) => mockRecordQuoteBuildAttempt(...a) }
})

const mockCheckRateLimit = vi.fn()
vi.mock('./kv-rate-limiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kv-rate-limiter')>()
  return { ...actual, checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a) }
})

const ALLOWED = {
  allowed: true,
  remaining: 10,
  resetAt: Date.now() + 60_000,
}
const EXCEEDED = { allowed: false, remaining: 0, resetAt: Date.now() + 60_000 }

async function loadApi() {
  vi.resetModules()
  return import('@/lib/api')
}

const BASE_ARGS = {
  src: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  dst: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amount: '1000000000000000000',
  from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
}

describe('fetchSwapFromSource — T1 telemetry + T3 0x quote-build cap', () => {
  beforeEach(() => {
    fakeRegistry = []
    mockRecordQuoteBuildAttempt.mockClear()
    mockCheckRateLimit.mockReset().mockResolvedValue(ALLOWED)
  })

  it('[T1] a successful build records outcome \'built\' with source/chain/pair/amount/requestId', async () => {
    fakeRegistry = [{
      name: '1inch' as const,
      fetchQuote: async () => null,
      fetchSwapData: async () => ({ source: '1inch' as const, toAmount: '2000000', estimatedGas: 1, gasUsd: 0, routes: [], tx: { to: '0x1', data: '0x', value: '0', gas: 1 } }),
    }]
    const { fetchSwapFromSource } = await loadApi()

    await fetchSwapFromSource('1inch', BASE_ARGS.src, BASE_ARGS.dst, BASE_ARGS.amount, BASE_ARGS.from, 0.5, 18, 18, undefined, 1)

    expect(mockRecordQuoteBuildAttempt).toHaveBeenCalledTimes(1)
    const attempt = mockRecordQuoteBuildAttempt.mock.calls[0][0]
    expect(attempt).toMatchObject({
      source: '1inch', chainId: 1, sellToken: BASE_ARGS.src, buyToken: BASE_ARGS.dst,
      amount: BASE_ARGS.amount, outcome: 'built', wallet: BASE_ARGS.from,
    })
    expect(typeof attempt.requestId).toBe('string')
    expect(attempt.requestId.length).toBeGreaterThan(0)
  })

  it('[T1] a deterministic adapter failure records outcome \'sim-failed\'', async () => {
    fakeRegistry = [{
      name: '1inch' as const,
      fetchQuote: async () => null,
      fetchSwapData: async () => { throw new Error('1inch 400') },
    }]
    const { fetchSwapFromSource } = await loadApi()

    await expect(
      fetchSwapFromSource('1inch', BASE_ARGS.src, BASE_ARGS.dst, BASE_ARGS.amount, BASE_ARGS.from, 0.5, 18, 18, undefined, 1),
    ).rejects.toThrow('1inch 400')

    expect(mockRecordQuoteBuildAttempt).toHaveBeenCalledTimes(1)
    expect(mockRecordQuoteBuildAttempt.mock.calls[0][0]).toMatchObject({ outcome: 'sim-failed' })
  })

  it('[T3] source !== \'0x\' never consults the cap, even with a callerIdentity supplied', async () => {
    fakeRegistry = [{
      name: '1inch' as const,
      fetchQuote: async () => null,
      fetchSwapData: async () => ({ source: '1inch' as const, toAmount: '1', estimatedGas: 0, gasUsd: 0, routes: [], tx: { to: '0x1', data: '0x', value: '0', gas: 0 } }),
    }]
    const { fetchSwapFromSource } = await loadApi()

    await fetchSwapFromSource('1inch', BASE_ARGS.src, BASE_ARGS.dst, BASE_ARGS.amount, BASE_ARGS.from, 0.5, 18, 18, undefined, 1, undefined, '1.2.3.4')

    expect(mockCheckRateLimit).not.toHaveBeenCalled()
  })

  it('[T3] source === \'0x\' WITHOUT a callerIdentity never consults the cap (backward compatible)', async () => {
    fakeRegistry = [{
      name: '0x' as const,
      fetchQuote: async () => null,
      fetchSwapData: async () => ({ source: '0x' as const, toAmount: '1', estimatedGas: 0, gasUsd: 0, routes: [], tx: { to: '0x1', data: '0x', value: '0', gas: 0 } }),
    }]
    const { fetchSwapFromSource } = await loadApi()

    await fetchSwapFromSource('0x', BASE_ARGS.src, BASE_ARGS.dst, BASE_ARGS.amount, BASE_ARGS.from, 0.5, 18, 18, undefined, 1)

    expect(mockCheckRateLimit).not.toHaveBeenCalled()
  })

  it('[T3] source === \'0x\' WITH a callerIdentity under the cap proceeds normally and records \'built\'', async () => {
    const zeroxSpy = vi.fn(async () => ({ source: '0x' as const, toAmount: '5', estimatedGas: 0, gasUsd: 0, routes: [], tx: { to: '0x1' as `0x${string}`, data: '0x' as `0x${string}`, value: '0', gas: 0 } }))
    fakeRegistry = [{ name: '0x' as const, fetchQuote: async () => null, fetchSwapData: zeroxSpy }]
    const { fetchSwapFromSource } = await loadApi()

    const result = await fetchSwapFromSource('0x', BASE_ARGS.src, BASE_ARGS.dst, BASE_ARGS.amount, BASE_ARGS.from, 0.5, 18, 18, undefined, 1, undefined, '1.2.3.4')

    expect(zeroxSpy).toHaveBeenCalledTimes(1)
    expect(result.toAmount).toBe('5')
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2) // minute + hour windows
    expect(mockRecordQuoteBuildAttempt.mock.calls[0][0]).toMatchObject({ outcome: 'built', source: '0x' })
  })

  it('[T3] source === \'0x\' OVER the per-minute cap skips 0x entirely (adapter never called), throws ZeroXQuoteCapExceededError, records \'429\'', async () => {
    const zeroxSpy = vi.fn(async () => ({ source: '0x' as const, toAmount: '5', estimatedGas: 0, gasUsd: 0, routes: [], tx: { to: '0x1' as `0x${string}`, data: '0x' as `0x${string}`, value: '0', gas: 0 } }))
    fakeRegistry = [{ name: '0x' as const, fetchQuote: async () => null, fetchSwapData: zeroxSpy }]
    mockCheckRateLimit.mockResolvedValueOnce(EXCEEDED).mockResolvedValueOnce(ALLOWED) // minute exceeded
    const { fetchSwapFromSource, ZeroXQuoteCapExceededError } = await loadApi()

    await expect(
      fetchSwapFromSource('0x', BASE_ARGS.src, BASE_ARGS.dst, BASE_ARGS.amount, BASE_ARGS.from, 0.5, 18, 18, undefined, 1, undefined, '1.2.3.4'),
    ).rejects.toBeInstanceOf(ZeroXQuoteCapExceededError)

    expect(zeroxSpy).not.toHaveBeenCalled()
    expect(mockRecordQuoteBuildAttempt).toHaveBeenCalledTimes(1)
    expect(mockRecordQuoteBuildAttempt.mock.calls[0][0]).toMatchObject({ outcome: '429', source: '0x' })
  })

  it('[T3] source === \'0x\' OVER the per-hour cap (but under per-minute) also skips 0x', async () => {
    const zeroxSpy = vi.fn()
    fakeRegistry = [{ name: '0x' as const, fetchQuote: async () => null, fetchSwapData: zeroxSpy }]
    mockCheckRateLimit.mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce(EXCEEDED) // hour exceeded
    const { fetchSwapFromSource, ZeroXQuoteCapExceededError } = await loadApi()

    await expect(
      fetchSwapFromSource('0x', BASE_ARGS.src, BASE_ARGS.dst, BASE_ARGS.amount, BASE_ARGS.from, 0.5, 18, 18, undefined, 1, undefined, '1.2.3.4'),
    ).rejects.toBeInstanceOf(ZeroXQuoteCapExceededError)
    expect(zeroxSpy).not.toHaveBeenCalled()
  })
})
