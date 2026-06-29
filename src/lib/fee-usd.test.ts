// Tests for the Platform-fee USD valuation.
//
// BUG being fixed: for a swap whose INPUT token has no Chainlink oracle (e.g.
// AERO→WETH), the fee — denominated in the input token (AERO) — was multiplied
// by `evaluatePairOracle`'s cross-leg fallback price, which is the OUTPUT token's
// (WETH≈ETH) price. A ~$1.87 swap then showed a ~$5.79 fee (valuing AERO at ETH's
// ~$1558 rate) instead of ~$0.002.
//
// FIX: value the fee as FEE_PERCENT% of the swap's REAL USD notional, taken from
// whichever side is reliably priced (its own oracle) — never the fee token's
// cross-leg fallback. Oracle-input swaps are unchanged (input notional × 0.1% ==
// the old feeAbsolute × inputPrice).

import { describe, it, expect } from 'vitest'
import { swapNotionalUsd, feeUsd, formatFeeUsd } from './fee-usd'

describe('swapNotionalUsd — reliably-priced notional, never a cross-leg fallback', () => {
  it('uses the INPUT side when the input token has an oracle (oracle-input unchanged)', () => {
    // WETH→USDC style: input priced → input notional, output price ignored.
    expect(
      swapNotionalUsd({ inputAmount: 10, inputPrice: 2, outputAmount: 999, outputPrice: 999 }),
    ).toBe(20)
  })

  it('falls back to the OUTPUT side when the input token has NO oracle (the AERO→WETH case)', () => {
    // AERO (no feed) → WETH (feed). 0.0005 WETH × $3740 ≈ $1.87 swap.
    const notional = swapNotionalUsd({
      inputAmount: 3.716, // AERO, irrelevant because inputPrice is null
      inputPrice: null,
      outputAmount: 0.0005,
      outputPrice: 3740,
    })
    expect(notional).toBeCloseTo(1.87, 2)
  })

  it('returns null when neither side has an oracle (AERO→USDbC) — no USD shown', () => {
    expect(
      swapNotionalUsd({ inputAmount: 5, inputPrice: null, outputAmount: 7, outputPrice: null }),
    ).toBeNull()
  })

  it('skips a side whose amount is 0 even if it has a price', () => {
    expect(
      swapNotionalUsd({ inputAmount: 0, inputPrice: 2, outputAmount: 4, outputPrice: 3 }),
    ).toBe(12) // input amount 0 → use output
  })
})

describe('feeUsd — FEE_PERCENT% of the trusted notional', () => {
  it('is 0.1% of the notional (AERO→WETH ≈ $1.87 → ≈ $0.00187)', () => {
    expect(feeUsd(1.87, 0.1)).toBeCloseTo(0.00187, 5)
  })

  it('matches the old correct value for an oracle-input swap ($2000 notional → $2 fee)', () => {
    expect(feeUsd(2000, 0.1)).toBeCloseTo(2, 6)
  })

  it('returns null when there is no reliable notional', () => {
    expect(feeUsd(null, 0.1)).toBeNull()
    expect(feeUsd(0, 0.1)).toBeNull()
  })
})

describe('formatFeeUsd — small fees stay visible (~$0.002, never $0.00 or $5.79)', () => {
  it('renders the AERO→WETH fee as ~0.002, not 0.00', () => {
    expect(formatFeeUsd(0.00187)).toBe('0.002')
  })

  it('uses 2 decimals for cent-and-above amounts', () => {
    expect(formatFeeUsd(2)).toBe('2.00')
    expect(formatFeeUsd(0.5)).toBe('0.50')
    expect(formatFeeUsd(5.79)).toBe('5.79')
  })

  it('renders exact zero as 0.00', () => {
    expect(formatFeeUsd(0)).toBe('0.00')
  })
})

describe('end-to-end: the AERO→WETH regression is fixed', () => {
  it('values the AERO fee from the WETH (output) oracle → ~$0.002, NOT the ~$5.79 ETH-priced value', () => {
    const FEE_PERCENT = 0.1
    // AERO→WETH: input AERO has no feed; output WETH does.
    const notional = swapNotionalUsd({
      inputAmount: 3.716, // AERO sold
      inputPrice: null, // no Chainlink feed for AERO
      outputAmount: 0.0005, // WETH received
      outputPrice: 3740, // WETH/USD oracle → ~$1.87 swap
    })
    const usd = feeUsd(notional, FEE_PERCENT)
    expect(usd).not.toBeNull()
    expect(usd!).toBeLessThan(0.01) // tiny — proves it is NOT the inflated ~$5.79
    expect(usd!).toBeCloseTo(0.00187, 4)
    expect(formatFeeUsd(usd!)).toBe('0.002')

    // The OLD bug computed feeAmount(AERO) × outputPrice — assert we are nowhere near it.
    const buggy = (3.716 * FEE_PERCENT) / 100 * 3740 // ≈ $13.9 (same class of error as $5.79)
    expect(usd!).toBeLessThan(buggy / 1000)
  })
})
