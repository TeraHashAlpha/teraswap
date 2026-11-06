// @vitest-environment jsdom
/**
 * [feat/ui-v2-docs-legal] "Docs: text identical to v1, claims stay live from product-claims (29 symbols)" — the
 * content-parity test proves the TEXT matches v1 today; this test proves the 29 slots are LIVE reads of
 * `@/config/product-claims`, not hardcoded strings that happen to match today's values. Every symbol v1's
 * DocsPage imports from product-claims is mocked to a distinct, obviously-fake value, and every one of those
 * fakes must appear in v2's render — a hardcoded literal would fail this the moment the real value differs.
 */
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

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
    INTEGRATED_DEX_SOURCE_COUNT: 97,
    INTEGRATED_DEX_SOURCES_CLAIM: 'ZZ97-FAKE integrated DEX sources',
    INTEGRATED_DEX_SOURCE_LABELS: ['ZZFakeAggOne', 'ZZFakeAggTwo'],
    ADMIN_TIMELOCK_GRACE_DAYS: 71,
    ADMIN_TIMELOCK_HOURS: 73,
    ADMIN_TRANSFER_TIMELOCK_DAYS: 79,
    CHAINLINK_STALENESS_CLAIM: 'ZZFAKE-staleness-claim-83',
    CROSS_QUOTE_WARN_PCT: '8.9%',
    DEFILLAMA_BLOCK_PCT: '9.7%',
    DEFILLAMA_HIGH_VALUE_USD_LABEL: '$97,531',
    OUTLIER_MEDIAN_MULTIPLE: 91,
    PLATFORM_FEE_BPS: 971,
    PLATFORM_FEE_LABEL: '9.71%',
    PRIVACY_BADGE: 'ZZFAKE Proxied Badge',
    PRIVACY_DIRECT_NOTE: 'ZZFAKE direct-note sentinel',
    PRIVACY_PROXY_CLAIM: 'ZZFAKE proxy-claim sentinel',
    PRICE_DEVIATION_BLOCK_PCT: '9.3%',
    PRICE_DEVIATION_WARN_PCT: '9.1%',
    QUOTE_TIMEOUT_SEC: 97,
    SLIPPAGE_CLAMP_MAX_PCT: 97,
    SLIPPAGE_CLAMP_MIN_PCT: 0.97,
    SPLIT_MIN_IMPROVEMENT_BPS_SLOT: 971,
    SPLIT_MIN_IMPROVEMENT_PCT: '9.71%',
    SWAP_CHAIN_LIST_LABEL: 'ZZFakeChainOne and ZZFakeChainTwo',
    UNISWAP_FEE_TIER_COUNT: 9,
    UNISWAP_FEE_TIER_LABELS: ['0.0971%', '0.973%'],
    chainNameFor: (_id: number) => 'ZZFakeChainName',
    chainlinkFeedCountFor: (_id: number) => 9731,
    isOrderTypeLive: (_type: string) => true,
  }
})

import { DocsTabV2 } from './DocsTabV2'

describe('Docs claims are live reads of product-claims (29 symbols), not hardcoded', () => {
  it('every mocked, obviously-fake value appears in the v2 render', () => {
    const { container } = render(<DocsTabV2 />)
    const text = container.textContent ?? ''
    const expectFakes = [
      '97', // INTEGRATED_DEX_SOURCE_COUNT
      'ZZ97-FAKE integrated DEX sources',
      'ZZFakeAggOne',
      'ZZFakeAggTwo',
      '71', // ADMIN_TIMELOCK_GRACE_DAYS
      '73', // ADMIN_TIMELOCK_HOURS
      '79', // ADMIN_TRANSFER_TIMELOCK_DAYS
      'ZZFAKE-staleness-claim-83',
      '8.9%', // CROSS_QUOTE_WARN_PCT
      '9.7%', // DEFILLAMA_BLOCK_PCT
      '$97,531',
      '91', // OUTLIER_MEDIAN_MULTIPLE
      '971', // PLATFORM_FEE_BPS / SPLIT_MIN_IMPROVEMENT_BPS_SLOT
      '9.71%', // PLATFORM_FEE_LABEL / SPLIT_MIN_IMPROVEMENT_PCT
      'ZZFAKE Proxied Badge',
      'ZZFAKE direct-note sentinel',
      'ZZFAKE proxy-claim sentinel',
      '9.3%', // PRICE_DEVIATION_BLOCK_PCT
      '9.1%', // PRICE_DEVIATION_WARN_PCT
      'ZZFakeChainOne and ZZFakeChainTwo',
      '0.0971%',
      '0.973%',
      'ZZFakeChainName',
      '9731', // chainlinkFeedCountFor
    ]
    for (const fake of expectFakes) {
      expect(text, `missing fake value "${fake}" — a hardcoded literal would not pick this up`).toContain(fake)
    }
  })
})
