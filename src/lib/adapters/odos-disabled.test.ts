/**
 * [chore/disable-odos-vendor-shutdown] Odos ceased ALL operations 2026-07-30
 * (vendor shutdown, announced publicly) → permanently disabled.
 *
 * Unlike balancer (dead endpoint, theoretically fixable — see
 * balancer-disabled.test.ts), this is PERMANENT: the vendor no longer exists,
 * so there is no re-enable path. The adapter file is kept (never delete, see
 * CLAUDE.md) with a @deprecated header; these tests pin that it is excluded
 * BEFORE the fan-out, not merely after, and that it never reappears as active.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { DISABLED_SOURCES } from '@/lib/constants'
import { ADAPTER_REGISTRY } from './index'
import odos from './odos'
import { fetchMetaQuote } from '@/lib/api'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('odos source — permanently disabled, vendor shutdown 2026-07-30 [chore/disable-odos-vendor-shutdown]', () => {
  it('is listed in DISABLED_SOURCES with the vendor-shutdown reason', () => {
    expect(DISABLED_SOURCES['odos']).toBeTruthy()
    expect(DISABLED_SOURCES['odos']).toMatch(/2026-07-30/)
    expect(DISABLED_SOURCES['odos']).toMatch(/shutdown|permanent/i)
  })

  it('is still a registered adapter (file kept, never deleted, per CLAUDE.md rule #4)', () => {
    const registered = new Set(ADAPTER_REGISTRY.map((a) => a.name))
    expect(registered.has('odos')).toBe(true)
  })

  it('fetchMetaQuote never calls the odos adapter (excluded before fan-out, not after)', async () => {
    const odosQuote = vi.spyOn(odos, 'fetchQuote')
    const odosSwap = vi.spyOn(odos, 'fetchSwapData')
    // Every other source's network call fails fast — the fan-out still runs,
    // proving exclusion happens at source selection, not via a lucky error.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network error: connection refused') }))
    vi.spyOn(console, 'info').mockImplementation(() => {})

    await expect(
      fetchMetaQuote(WETH, USDC, '1000000000000000000', 18, 6),
    ).rejects.toThrow()

    expect(global.fetch).toHaveBeenCalled()        // other sources were attempted
    expect(odosQuote).not.toHaveBeenCalled()        // odos was not
    expect(odosSwap).not.toHaveBeenCalled()
  })
})
