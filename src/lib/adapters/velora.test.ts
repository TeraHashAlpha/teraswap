/**
 * [SPRINT-9J J2] Velora is the reported HTML-504 culprit (slow
 * /transactions/{chainId}). Its build fetches must thread the AbortSignal that
 * withSwapBuildRetry supplies, so a slow upstream is cancelled — not abandoned —
 * when the per-attempt timeout fires.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/chains', () => ({
  getAdapterApiUrl: () => 'https://velora.test',
  DEFAULT_CHAIN_ID: 1,
}))

import velora from './velora'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubVeloraFetch() {
  const signals: (AbortSignal | undefined)[] = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    signals.push(init.signal ?? undefined)
    if (url.includes('/prices')) {
      return {
        ok: true,
        json: async () => ({
          priceRoute: { destAmount: '2950000000', gasCost: '0', gasCostUSD: '0', bestRoute: [] },
        }),
      } as unknown as Response
    }
    // /transactions/{chainId}
    return {
      ok: true,
      json: async () => ({ to: '0x1111111254EEB25477B68fb85Ed929f73A960582', data: '0x12aa3caf', value: '0', gas: '200000' }),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return signals
}

describe('velora.fetchSwapData — abort signal threading [SPRINT-9J J2]', () => {
  it('threads the build AbortSignal into BOTH /prices and /transactions fetches', async () => {
    const signals = stubVeloraFetch()
    const controller = new AbortController()
    const result = await velora.fetchSwapData({
      src: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      dst: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amount: '1000000000000000000',
      from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      slippage: 0.5,
      signal: controller.signal,
    })
    expect(result?.source).toBe('velora')
    expect(signals).toHaveLength(2)
    expect(signals[0]).toBe(controller.signal)
    expect(signals[1]).toBe(controller.signal)
  })
})
