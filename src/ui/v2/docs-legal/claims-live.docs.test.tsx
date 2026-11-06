// @vitest-environment jsdom
/**
 * [feat/ui-v2-docs-legal] "Docs: text identical to v1, claims stay live from product-claims (29 symbols)" — the
 * content-parity test proves the TEXT matches v1 today; this test proves each of the 29 slots is a LIVE read of
 * `@/config/product-claims`, not a hardcoded literal that happens to match today's value.
 *
 * Each symbol gets its OWN unique fake value (no two symbols share a value) and its own assertion, via
 * `it.each` — so a missing symbol fails by name, not silently behind a shared value another symbol also
 * satisfies. (A first version of this test reused "97" for three different symbols — QUOTE_TIMEOUT_SEC,
 * SLIPPAGE_CLAMP_MAX_PCT and INTEGRATED_DEX_SOURCE_COUNT — which meant a hardcoded QUOTE_TIMEOUT_SEC would have
 * passed anyway, and SLIPPAGE_CLAMP_MIN_PCT was never asserted at all. Fixed here: every value below is unique.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1 }))
class IO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO

vi.mock('@/config/product-claims', async () => {
  const actual = await vi.importActual<typeof import('@/config/product-claims')>('@/config/product-claims')
  return {
    ...actual,
    INTEGRATED_DEX_SOURCE_COUNT: 9001,
    INTEGRATED_DEX_SOURCES_CLAIM: 'ZZ-CLAIM-9002',
    INTEGRATED_DEX_SOURCE_LABELS: ['ZZ-LABEL-9003A', 'ZZ-LABEL-9003B'],
    ADMIN_TIMELOCK_GRACE_DAYS: 9004,
    ADMIN_TIMELOCK_HOURS: 9005,
    ADMIN_TRANSFER_TIMELOCK_DAYS: 9006,
    CHAINLINK_STALENESS_CLAIM: 'ZZ-STALENESS-9007',
    CROSS_QUOTE_WARN_PCT: '9.008%',
    DEFILLAMA_BLOCK_PCT: '9.009%',
    DEFILLAMA_HIGH_VALUE_USD_LABEL: '$90,010',
    OUTLIER_MEDIAN_MULTIPLE: 9011,
    PLATFORM_FEE_BPS: 9012,
    PLATFORM_FEE_LABEL: '9.013%',
    PRIVACY_BADGE: 'ZZ-BADGE-9014',
    PRIVACY_DIRECT_NOTE: 'ZZ-DIRECTNOTE-9015',
    PRIVACY_PROXY_CLAIM: 'ZZ-PROXYCLAIM-9016',
    PRICE_DEVIATION_BLOCK_PCT: '9.017%',
    PRICE_DEVIATION_WARN_PCT: '9.018%',
    QUOTE_TIMEOUT_SEC: 9019,
    SLIPPAGE_CLAMP_MAX_PCT: 9020,
    SLIPPAGE_CLAMP_MIN_PCT: 0.9021,
    SPLIT_MIN_IMPROVEMENT_BPS_SLOT: 9022,
    SPLIT_MIN_IMPROVEMENT_PCT: '9.023%',
    SWAP_CHAIN_LIST_LABEL: 'ZZ-CHAINLABEL-9024',
    UNISWAP_FEE_TIER_COUNT: 9025,
    UNISWAP_FEE_TIER_LABELS: ['9.0261%', '9.0262%'],
    chainNameFor: (_id: number) => 'ZZ-CHAINNAME-9028',
    chainlinkFeedCountFor: (_id: number) => 9029,
    // Distinct per type (not the real env-driven default) so the branch is provably read, not hardcoded.
    isOrderTypeLive: (type: string) => type === 'limit',
  }
})

import { DocsTabV2 } from './DocsTabV2'

/** One row per product-claims symbol DocsPage/DocsTabV2 imports — 26 render a unique literal; 3 are functions
 *  checked separately below (chainNameFor, chainlinkFeedCountFor, isOrderTypeLive). 26 + 3 = 29. */
const SYMBOL_FAKES: readonly [string, string][] = [
  ['INTEGRATED_DEX_SOURCE_COUNT', '9001'],
  ['INTEGRATED_DEX_SOURCES_CLAIM', 'ZZ-CLAIM-9002'],
  ['INTEGRATED_DEX_SOURCE_LABELS[0]', 'ZZ-LABEL-9003A'],
  ['INTEGRATED_DEX_SOURCE_LABELS[1]', 'ZZ-LABEL-9003B'],
  ['ADMIN_TIMELOCK_GRACE_DAYS', '9004'],
  ['ADMIN_TIMELOCK_HOURS', '9005'],
  ['ADMIN_TRANSFER_TIMELOCK_DAYS', '9006'],
  ['CHAINLINK_STALENESS_CLAIM', 'ZZ-STALENESS-9007'],
  ['CROSS_QUOTE_WARN_PCT', '9.008%'],
  ['DEFILLAMA_BLOCK_PCT', '9.009%'],
  ['DEFILLAMA_HIGH_VALUE_USD_LABEL', '$90,010'],
  ['OUTLIER_MEDIAN_MULTIPLE', '9011'],
  ['PLATFORM_FEE_BPS', '9012'],
  ['PLATFORM_FEE_LABEL', '9.013%'],
  ['PRIVACY_BADGE', 'ZZ-BADGE-9014'],
  ['PRIVACY_DIRECT_NOTE', 'ZZ-DIRECTNOTE-9015'],
  ['PRIVACY_PROXY_CLAIM', 'ZZ-PROXYCLAIM-9016'],
  ['PRICE_DEVIATION_BLOCK_PCT', '9.017%'],
  ['PRICE_DEVIATION_WARN_PCT', '9.018%'],
  ['QUOTE_TIMEOUT_SEC', '9019'],
  ['SLIPPAGE_CLAMP_MAX_PCT', '9020'],
  ['SLIPPAGE_CLAMP_MIN_PCT', '0.9021'],
  ['SPLIT_MIN_IMPROVEMENT_BPS_SLOT', '9022'],
  ['SPLIT_MIN_IMPROVEMENT_PCT', '9.023%'],
  ['SWAP_CHAIN_LIST_LABEL', 'ZZ-CHAINLABEL-9024'],
  ['UNISWAP_FEE_TIER_COUNT', '9025'],
  ['UNISWAP_FEE_TIER_LABELS[0]', '9.0261%'],
  ['UNISWAP_FEE_TIER_LABELS[last]', '9.0262%'],
]

afterEach(cleanup)

describe('Docs claims are live reads of product-claims (29 symbols), not hardcoded', () => {
  it.each(SYMBOL_FAKES)('%s: its unique fake value renders in v2', (_symbol, fake) => {
    const { container } = render(<DocsTabV2 />)
    expect(container.textContent ?? '').toContain(fake)
  })

  it('chainNameFor(chainId) is a live read', () => {
    const { container } = render(<DocsTabV2 />)
    expect(container.textContent ?? '').toContain('ZZ-CHAINNAME-9028')
  })

  it('chainlinkFeedCountFor(chainId) is a live read', () => {
    const { container } = render(<DocsTabV2 />)
    expect(container.textContent ?? '').toContain('9029')
  })

  it("isOrderTypeLive(type) is a live read, not a hardcoded branch: mocked true only for 'limit', so only the Limit Orders section skips its Coming Soon banner", () => {
    const { container } = render(<DocsTabV2 />)
    const text = container.textContent ?? ''
    const limitSection = container.querySelector('#limit-orders')!.textContent ?? ''
    const dcaSection = container.querySelector('#dca')!.textContent ?? ''
    expect(limitSection).not.toContain('Coming Soon')
    expect(dcaSection).toContain('Coming Soon')
    expect(text).toContain('Coming Soon') // sanity: the banner renders at all (DCA/SL-TP)
  })
})
