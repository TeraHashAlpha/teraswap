/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] Per-fill USD valuation, shared with the analytics route.
 *
 * Values a fill as human(amount) × an approximate price (the SAME APPROX_PRICES table #228 uses).
 * Returns null when the token has no known price — the dashboard renders "—" rather than a fabricated
 * "$0" (the "do not fabricate USD" rule).
 */

import { describe, it, expect } from 'vitest'
import { fillUsd, APPROX_PRICES } from './usd'

describe('fillUsd', () => {
  it('values a stablecoin fill at its face amount', () => {
    expect(fillUsd('1000000', 6, 'USDC')).toBeCloseTo(1, 6) // 1 USDC × $1
  })

  it('values a WETH fill via the approximate ETH price', () => {
    expect(fillUsd('1000000000000000000', 18, 'WETH')).toBeCloseTo(APPROX_PRICES.WETH, 6)
  })

  it('is symbol-case-insensitive', () => {
    expect(fillUsd('1000000000000000000', 18, 'weth')).toBeCloseTo(APPROX_PRICES.WETH, 6)
  })

  it('values a mixed-case-symbol token whose price IS defined (stETH, cbETH, …)', () => {
    // The lookup uppercases the symbol, so every priced token must resolve regardless of its casing.
    expect(fillUsd('1000000000000000000', 18, 'stETH')).toBeGreaterThan(0)
    expect(fillUsd('1000000000000000000', 18, 'cbETH')).toBeGreaterThan(0)
    expect(fillUsd('100000000', 8, 'tBTC')).toBeGreaterThan(0)
  })

  it('returns null for a token with no known price (no fabrication)', () => {
    expect(fillUsd('1000000000000000000', 18, 'ETHFI')).toBeNull()
  })

  it('returns 0 for a zero amount of a priced token', () => {
    expect(fillUsd('0', 18, 'WETH')).toBe(0)
  })

  it('returns null for an unparseable amount', () => {
    expect(fillUsd('not-a-number', 18, 'WETH')).toBeNull()
    expect(fillUsd(null, 18, 'WETH')).toBeNull()
  })
})
