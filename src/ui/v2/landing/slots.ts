/**
 * [ADR-025] Every number on the landing is a slot of `product-claims.ts` — never typed here. This file is the one
 * place the stat rows are assembled, so the slot table in docs/feedback and the "every number is a slot" test read
 * the same list. Labels are v1's, verbatim (the content-parity gate pins that).
 */
import {
  INTEGRATED_DEX_SOURCE_COUNT,
  VERIFICATION_CHECKS,
  VERIFICATION_CHECK_COUNT,
  VERIFICATION_STAGES,
  chainNameFor,
  chainlinkFeedCountFor,
} from '@/config/product-claims'

export interface StatCell {
  value: number
  label: string
  /** The product-claims export (or call) the value comes from — documentation + test evidence. */
  slot: string
}

/** Hero: 3 cells, numeral + label (fix/hero-stat-layout). The stage count lives in the label. */
export function heroStats(chainId: number): StatCell[] {
  return [
    { value: INTEGRATED_DEX_SOURCE_COUNT, label: 'LIQUIDITY SOURCES', slot: 'INTEGRATED_DEX_SOURCE_COUNT' },
    {
      value: VERIFICATION_CHECKS.length,
      label: `VERIFICATION CHECKS · ${VERIFICATION_STAGES.length} STAGES`,
      slot: 'VERIFICATION_CHECKS.length · VERIFICATION_STAGES.length',
    },
    {
      value: chainlinkFeedCountFor(chainId),
      label: `CHAINLINK ORACLES · ${chainNameFor(chainId)}`,
      slot: 'chainlinkFeedCountFor(chainId) · chainNameFor(chainId)',
    },
  ]
}

/** Security bar (pack 10 §4): sources · checks · feeds on the selected chain · the post-execution mark. */
export function securityStats(chainId: number): Array<StatCell | { value: null; label: string; text: string; slot: string }> {
  return [
    { value: INTEGRATED_DEX_SOURCE_COUNT, label: 'Liquidity sources', slot: 'INTEGRATED_DEX_SOURCE_COUNT' },
    { value: VERIFICATION_CHECK_COUNT, label: 'Independent verification checks', slot: 'VERIFICATION_CHECK_COUNT' },
    {
      value: chainlinkFeedCountFor(chainId),
      label: `Chainlink token price feeds on ${chainNameFor(chainId)}`,
      slot: 'chainlinkFeedCountFor(chainId) · chainNameFor(chainId)',
    },
    { value: null, label: 'Post-execution verified', text: '✓ Verified', slot: '(text, no number)' },
  ]
}
