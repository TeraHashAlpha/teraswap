import { describe, it, expect } from 'vitest'
import { quickFillRaw, perChunkRaw, formatMinBuyUnit, formatMinBuyMessage } from './dca-quick-fill'

const ONE = 10n ** 18n // 1 WETH in smallest units (18 decimals)
const MIN_ORDER_AMOUNT = 10_000n // mirrors lib/order-engine/config.ts — NOT re-imported to keep this a pure unit test

describe('quickFillRaw — DCA quick-fill % presets (BigInt, no float drift)', () => {
  it('25% of 1 WETH = 0.25 WETH (exact)', () => {
    expect(quickFillRaw(ONE, 25)).toBe(ONE / 4n)
  })

  it('50% of 1 WETH = 0.5 WETH (exact)', () => {
    expect(quickFillRaw(ONE, 50)).toBe(ONE / 2n)
  })

  it('100% returns the full balance unchanged — exact to the wei', () => {
    // 1.000000000000000001 WETH: a Number() round-trip drops the trailing +1 wei.
    const odd = ONE + 1n
    expect(quickFillRaw(odd, 100)).toBe(odd)
  })

  it('uses floor division (never rounds up) for odd splits', () => {
    expect(quickFillRaw(3n, 50)).toBe(1n) // floor(1.5) = 1
    expect(quickFillRaw(1n, 50)).toBe(0n) // floor(0.5) = 0
  })

  it('preserves wei-level precision a float path would lose', () => {
    const weird = 123456789012345679n // ~0.1234… WETH, odd
    expect(quickFillRaw(weird, 50)).toBe(weird / 2n)
    expect(quickFillRaw(weird, 100)).toBe(weird)
  })

  it('zero balance or non-positive percent → 0n (buttons stay disabled)', () => {
    expect(quickFillRaw(0n, 100)).toBe(0n)
    expect(quickFillRaw(ONE, 0)).toBe(0n)
    expect(quickFillRaw(ONE, -25)).toBe(0n)
  })
})

describe('perChunkRaw — per-buy floor split (mirrors contract / useOrderEngine)', () => {
  it('splits the total across N buys with floor division', () => {
    expect(perChunkRaw(100n, 7)).toBe(14n) // floor(100/7)
    expect(perChunkRaw(ONE, 4)).toBe(ONE / 4n)
  })

  it('surfaces a per-chunk under the 10,000 base-unit MIN floor', () => {
    // 50,000 base units over 7 buys ⇒ 7,142 < 10,000 floor
    expect(perChunkRaw(50_000n, 7)).toBe(7_142n)
    expect(perChunkRaw(50_000n, 7) < 10_000n).toBe(true)
  })

  it('parts ≤ 0 or non-positive total → 0n (guard)', () => {
    expect(perChunkRaw(ONE, 0)).toBe(0n)
    expect(perChunkRaw(0n, 7)).toBe(0n)
  })
})

// [fix/dca-min-buy-copy] The per-buy floor error used to read "N base units" — developer-speak.
// These pin the human/USD rewrite across 3 decimal shapes (cbBTC 8dec, USDC 6dec, WETH 18dec) plus
// the price-unavailable fallback. COPY ONLY — MIN_ORDER_AMOUNT itself is untouched (mirrored above).
describe('formatMinBuyUnit — token-unit + approx-USD floor label', () => {
  it('cbBTC (8 dec): 10,000 base units = 0.0001 cbBTC, priced at ~$14', () => {
    expect(formatMinBuyUnit(MIN_ORDER_AMOUNT, 8, 'cbBTC', 140_000)).toBe('0.0001 cbBTC (~$14.00)')
  })

  it('USDC (6 dec): 10,000 base units = 0.01 USDC, priced at $1', () => {
    expect(formatMinBuyUnit(MIN_ORDER_AMOUNT, 6, 'USDC', 1)).toBe('0.01 USDC (~$0.01)')
  })

  it('WETH (18 dec): 10,000 base units = 1e-14 WETH — sub-cent USD renders at 4dp, not "$0.00"', () => {
    expect(formatMinBuyUnit(MIN_ORDER_AMOUNT, 18, 'WETH', 3500)).toBe('0.00000000000001 WETH (~$0.0000)')
  })

  it('price unavailable → token units only, no fabricated USD', () => {
    expect(formatMinBuyUnit(MIN_ORDER_AMOUNT, 8, 'cbBTC', null)).toBe('0.0001 cbBTC')
  })
})

describe('formatMinBuyMessage — full actionable copy (max buys / min total)', () => {
  it('cbBTC: computes the max buys the current total supports and includes it in the fix', () => {
    // 50,000 base units total ⇒ floor(50000/10000) = 5 max buys at the floor.
    const msg = formatMinBuyMessage({
      minBuyRaw: MIN_ORDER_AMOUNT, decimals: 8, symbol: 'cbBTC',
      totalRaw: 50_000n, requestedBuys: 10, priceUsd: 140_000,
    })
    expect(msg.maxBuys).toBe(5)
    expect(msg.minTotalRaw).toBe(100_000n) // 10,000 × 10 requested buys
    expect(msg.text).toContain('0.0001 cbBTC (~$14.00)')
    expect(msg.text).toContain('Lower to 5 buys')
    expect(msg.text).toMatch(/on-chain minimum/i)
  })

  it('USDC: total too small for even 1 buy ⇒ "raise your total" only, no "Lower to" clause', () => {
    const msg = formatMinBuyMessage({
      minBuyRaw: MIN_ORDER_AMOUNT, decimals: 6, symbol: 'USDC',
      totalRaw: 5_000n, requestedBuys: 3, priceUsd: 1,
    })
    expect(msg.maxBuys).toBe(0)
    expect(msg.text).toContain('Raise your total to at least')
    expect(msg.text).not.toContain('Lower to')
  })

  it('WETH: healthy total supports more buys than requested ⇒ still surfaces maxBuys/minTotal', () => {
    const msg = formatMinBuyMessage({
      minBuyRaw: MIN_ORDER_AMOUNT, decimals: 18, symbol: 'WETH',
      totalRaw: 200_000n, requestedBuys: 30, priceUsd: 3500,
    })
    expect(msg.maxBuys).toBe(20) // floor(200000/10000)
    expect(msg.minTotalRaw).toBe(300_000n) // 10,000 × 30 requested buys
    expect(msg.text).toContain('Lower to 20 buys')
  })

  it('price unavailable: fix clause falls back to token units, never fabricates a $ figure', () => {
    const msg = formatMinBuyMessage({
      minBuyRaw: MIN_ORDER_AMOUNT, decimals: 8, symbol: 'cbBTC',
      totalRaw: 50_000n, requestedBuys: 10, priceUsd: null,
    })
    expect(msg.text).not.toContain('$')
    expect(msg.text).toContain('0.0001 cbBTC')
    expect(msg.text).toContain('0.001 cbBTC') // minTotalHuman = 100,000 base units / 1e8
  })

  it('requestedBuys ≤ 0 is treated as 1 (never divides by zero / negative)', () => {
    const msg = formatMinBuyMessage({
      minBuyRaw: MIN_ORDER_AMOUNT, decimals: 6, symbol: 'USDC',
      totalRaw: 5_000n, requestedBuys: 0, priceUsd: 1,
    })
    expect(msg.minTotalRaw).toBe(MIN_ORDER_AMOUNT)
  })
})
