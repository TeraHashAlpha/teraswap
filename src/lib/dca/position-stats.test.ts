/**
 * [CHORE-DCA-VISIBILITY-AND-STATS #3] Per-position DCA stats + P&L.
 *
 * The golden fixture is the one ever-completed Base DCA `0x5449dea0`
 * (WETH→ETHFI, 5/5 fills, daily 07-01→07-05), transcribed from the recon report
 * (Audits/Reviews/DCA-VISIBILITY-DATA-2026-07.md §2): 0.004 WETH in per fill;
 * 19.57 / 19.56 / 20.32 / 17.70 / 16.75 ETHFI out. The stats must reconcile the
 * amounts EXACTLY, and P&L must use a live spot price (never price_at_execution,
 * which is all-NULL on live data).
 */
import { describe, it, expect } from 'vitest'
import { computePositionStats, computePositionPnl, type StatFill } from './position-stats'

// 0.004 WETH = 4e15 wei; ETHFI out per fill = coeff × 1e16 (18-decimals token).
const IN_PER_FILL = (4n * 10n ** 15n).toString()
const OUT_COEFFS = [1957n, 1956n, 2032n, 1770n, 1675n] // ×1e16 = 19.57 … 16.75 ETHFI

const GOLDEN: StatFill[] = OUT_COEFFS.map((c, i) => ({
  amount_in: IN_PER_FILL,
  amount_out: (c * 10n ** 16n).toString(),
  status: 'confirmed',
  created_at: `2026-07-0${i + 1}T11:52:00.000Z`,
}))

describe('computePositionStats — golden completed DCA 0x5449dea0 (WETH→ETHFI, 5/5)', () => {
  const stats = computePositionStats(GOLDEN, { dcaTotal: 5, tokenInDecimals: 18, tokenOutDecimals: 18 })

  it('reconciles fills executed / planned and % complete', () => {
    expect(stats.fillsExecuted).toBe(5)
    expect(stats.fillsPlanned).toBe(5)
    expect(stats.pctComplete).toBe(100)
  })

  it('reconciles total invested (Σ amount_in) exactly', () => {
    // 5 × 0.004 WETH = 0.02 WETH
    expect(stats.totalInvestedRaw).toBe((2n * 10n ** 16n).toString())
    expect(stats.totalInvested).toBeCloseTo(0.02, 12)
  })

  it('reconciles total received (Σ amount_out) exactly', () => {
    // 19.57 + 19.56 + 20.32 + 17.70 + 16.75 = 93.90 ETHFI
    expect(stats.totalReceivedRaw).toBe((9390n * 10n ** 16n).toString())
    expect(stats.totalReceived).toBeCloseTo(93.9, 10)
  })

  it('computes avg buy price = cost basis (invested ÷ received, input per output)', () => {
    // 0.02 WETH / 93.90 ETHFI ≈ 0.00021299 WETH per ETHFI
    expect(stats.avgBuyPrice).toBeCloseTo(0.02 / 93.9, 12)
  })

  it('captures the fill date range (first → last)', () => {
    expect(stats.firstFillAt).toBe('2026-07-01T11:52:00.000Z')
    expect(stats.lastFillAt).toBe('2026-07-05T11:52:00.000Z')
  })
})

describe('computePositionStats — edge cases', () => {
  it('excludes failed / pending fills from the sums but keeps confirmed', () => {
    const fills: StatFill[] = [
      { amount_in: '1000', amount_out: '2000', status: 'confirmed' },
      { amount_in: '9999', amount_out: '9999', status: 'failed' },
      { amount_in: '9999', amount_out: '9999', status: 'pending' },
    ]
    const s = computePositionStats(fills, { dcaTotal: 3, tokenInDecimals: 0, tokenOutDecimals: 0 })
    expect(s.fillsExecuted).toBe(1)
    expect(s.totalInvestedRaw).toBe('1000')
    expect(s.totalReceivedRaw).toBe('2000')
    expect(s.pctComplete).toBe(33) // 1 of 3
  })

  it('never divides by zero when nothing was received (avgBuyPrice = null)', () => {
    const s = computePositionStats([{ amount_in: '1000', amount_out: '0', status: 'confirmed' }], {})
    expect(s.avgBuyPrice).toBeNull()
  })

  it('is decimals-aware (USDC input, 6 decimals)', () => {
    const s = computePositionStats(
      [{ amount_in: (100n * 10n ** 6n).toString(), amount_out: (5n * 10n ** 17n).toString(), status: 'confirmed' }],
      { tokenInDecimals: 6, tokenOutDecimals: 18 },
    )
    expect(s.totalInvested).toBeCloseTo(100, 9) // 100 USDC
    expect(s.totalReceived).toBeCloseTo(0.5, 12) // 0.5 output token
  })

  it('handles an empty fills list', () => {
    const s = computePositionStats([], { dcaTotal: 4 })
    expect(s.fillsExecuted).toBe(0)
    expect(s.totalInvested).toBe(0)
    expect(s.avgBuyPrice).toBeNull()
    expect(s.pctComplete).toBe(0)
  })
})

describe('computePositionPnl — P&L vs live spot', () => {
  const stats = computePositionStats(GOLDEN, { dcaTotal: 5, tokenInDecimals: 18, tokenOutDecimals: 18 })

  it('values the accumulated output at a LIVE price and compares to what was spent', () => {
    // invested = 0.02 WETH × $3500 = $70 ; value = 93.90 ETHFI × $1.20 = $112.68
    const pnl = computePositionPnl(stats, { priceIn: 3500, priceOut: 1.2 })!
    expect(pnl.investedUsd).toBeCloseTo(70, 6)
    expect(pnl.currentValueUsd).toBeCloseTo(112.68, 6)
    expect(pnl.pnlUsd).toBeCloseTo(42.68, 6)
    expect(pnl.pnlPct).toBeCloseTo(60.97, 1)
    expect(pnl.direction).toBe('up')
  })

  it('marks a loss calmly (direction=down), not alarmingly', () => {
    const pnl = computePositionPnl(stats, { priceIn: 3500, priceOut: 0.5 })!
    // value = 93.90 × 0.5 = $46.95 < $70 invested
    expect(pnl.pnlUsd).toBeLessThan(0)
    expect(pnl.direction).toBe('down')
  })

  it('returns null when either token is unpriceable (no fabricated P&L)', () => {
    expect(computePositionPnl(stats, { priceIn: 3500, priceOut: null })).toBeNull()
    expect(computePositionPnl(stats, { priceIn: 0, priceOut: 1 })).toBeNull()
    expect(computePositionPnl(stats, {})).toBeNull()
  })
})
