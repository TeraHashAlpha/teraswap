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

import velora, { veloraHopLabel, veloraRouteLabels } from './velora'
import { VELORA_PRICES_MAINNET_WETH_USDC } from '@/lib/__fixtures__/velora-prices-mainnet'

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

// ── [chore/copy-leftovers] route labels ──────────────────────────────────────
describe('velora route labels — recorded /prices response', () => {
  const stubPrices = () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => VELORA_PRICES_MAINNET_WETH_USDC }) as unknown as Response))
  }

  it('the recording really carries internal ids (so this test is not vacuous)', () => {
    const ids = VELORA_PRICES_MAINNET_WETH_USDC.priceRoute.bestRoute.flatMap((r) => r.swaps.flatMap((s) => s.swapExchanges.map((e) => e.exchange)))
    expect(ids).toContain('metric-v1')
  })

  it('fetchQuote: never surfaces "metric-v1"; unnamed venues read "Velora", named ones keep their DEX name, no repeats', async () => {
    stubPrices()
    const q = await velora.fetchQuote({ src: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', dst: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', amount: '10000000000000000000' })
    expect(q?.routes).toEqual(['Velora', 'Uniswap V4'])
    expect(q?.routes.join(' ')).not.toMatch(/metric/i)
  })

  it('fetchSwapData: same labels as fetchQuote for the same route', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/prices')
      ? { ok: true, json: async () => VELORA_PRICES_MAINNET_WETH_USDC }
      : { ok: true, json: async () => ({ to: '0x6a000f20005980200259b80c5102003040001068', data: '0x', value: '0', gas: '200000' }) }) as unknown as Response))
    const q = await velora.fetchSwapData({
      src: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', dst: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amount: '10000000000000000000', from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', slippage: 0.5,
    })
    expect(q?.routes).toEqual(['Velora', 'Uniswap V4'])
  })

  it('hop label: case/separator-insensitive known venues; anything else, or a non-string, is "Velora"', () => {
    expect(veloraHopLabel('uniswapv3')).toBe('Uniswap V3')
    expect(veloraHopLabel('UniswapV3')).toBe('Uniswap V3')
    expect(veloraHopLabel('uniswap-v3')).toBe('Uniswap V3')
    expect(veloraHopLabel('metric-v1')).toBe('Velora')
    expect(veloraHopLabel('0x3c6c4fc94f1493b9d76c5e4c4cdedb444d3cc0a2')).toBe('Velora')
    expect(veloraHopLabel(undefined)).toBe('Velora')
    expect(veloraHopLabel(42)).toBe('Velora')
  })

  it('route labels tolerate a missing / malformed route (no undefined entries)', () => {
    expect(veloraRouteLabels(undefined)).toEqual([])
    expect(veloraRouteLabels({ bestRoute: [{ swaps: undefined }, { swaps: [{}] }, { swaps: [{ swapExchanges: [{ exchange: 'curve' }] }] }] })).toEqual(['Curve'])
  })
})
