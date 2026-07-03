/**
 * [CHORE-QUOTE-SOURCE-FIXES C2] Balancer is dead → disabled.
 *
 * The Balancer adapter targets the v2 SOR order endpoint
 * (`api-v3.balancer.fi/order/{chainId}`), which now returns 404
 * ('Only "/", "/graphql", and "/log" is allowed') — verified live
 * 2026-07-02 (T-SAF W7-L-02 coverage check). The adapter has produced
 * 0 production quotes ever; it only contributes errors to the fan-out.
 * Until it is migrated to the Balancer v3 GraphQL SOR
 * (`sorGetSwapPaths`), it must be DISABLED: not called at all, so it
 * neither burns fan-out time nor counts as a quote/quorum candidate.
 *
 * (Winner selection was already null-safe — fetchMetaQuote drops
 * rejected/null/zero results before ranking — these tests pin that the
 * disabled source is excluded BEFORE the fan-out, not merely after.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { DISABLED_SOURCES } from '@/lib/constants'
import { ADAPTER_REGISTRY } from './index'
import balancer from './balancer'
import { fetchMetaQuote } from '@/lib/api'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('balancer source — disabled while the SOR order endpoint is dead [CHORE-QUOTE-SOURCE-FIXES C2]', () => {
  it('is listed in DISABLED_SOURCES with the dead-endpoint reason', () => {
    expect(DISABLED_SOURCES['balancer']).toBeTruthy()
    // Reason must point maintainers at the cause and the re-enable path.
    expect(DISABLED_SOURCES['balancer']).toMatch(/404/)
    expect(DISABLED_SOURCES['balancer']).toMatch(/graphql|sor/i)
  })

  it('every DISABLED_SOURCES key names a registered adapter (typo would silently disable nothing)', () => {
    const registered = new Set(ADAPTER_REGISTRY.map((a) => a.name))
    for (const key of Object.keys(DISABLED_SOURCES)) {
      expect(registered.has(key as (typeof ADAPTER_REGISTRY)[number]['name'])).toBe(true)
    }
  })

  it('fetchMetaQuote never calls the balancer adapter (excluded before fan-out, not after)', async () => {
    const balancerQuote = vi.spyOn(balancer, 'fetchQuote')
    const balancerSwap = vi.spyOn(balancer, 'fetchSwapData')
    // Every other source's network call fails fast — the fan-out still runs,
    // proving exclusion happens at source selection, not via a lucky error.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network error: connection refused') }))
    vi.spyOn(console, 'info').mockImplementation(() => {})

    await expect(
      fetchMetaQuote(WETH, USDC, '1000000000000000000', 18, 6),
    ).rejects.toThrow()

    expect(global.fetch).toHaveBeenCalled()           // other sources were attempted
    expect(balancerQuote).not.toHaveBeenCalled()      // balancer was not
    expect(balancerSwap).not.toHaveBeenCalled()
  })
})
