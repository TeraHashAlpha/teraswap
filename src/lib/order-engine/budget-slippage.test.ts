/**
 * [CHORE-DCA-BUDGET-UX] budgetUsdToBps / bpsToBudgetUsd — pure $ ↔ bps conversion.
 */
import { describe, it, expect } from 'vitest'
import { budgetUsdToBps, bpsToBudgetUsd, MIN_FLOOR_BPS, DEFAULT_MAX_BPS } from './budget-slippage'

describe('budgetUsdToBps', () => {
  it('maps a mid-range budget to the expected bps (rounded)', () => {
    // $2 budget on $100 notional = 2% = 200 bps.
    expect(budgetUsdToBps(100, 2)).toBe(200)
  })

  it('rounds to the nearest whole bps', () => {
    // $5.005 on $300 = 166.8333... bps -> rounds to 167.
    expect(budgetUsdToBps(300, 5.005)).toBe(167)
  })

  it('clamps at the floor for a tiny/near-zero budget', () => {
    expect(budgetUsdToBps(10_000, 0.01)).toBe(MIN_FLOOR_BPS)
    expect(budgetUsdToBps(1_000_000, 0)).toBe(MIN_FLOOR_BPS)
  })

  it('clamps at the ceiling for an oversized budget', () => {
    expect(budgetUsdToBps(100, 1000)).toBe(DEFAULT_MAX_BPS)
  })

  it('respects a custom maxBps/minFloorBps override', () => {
    expect(budgetUsdToBps(100, 1000, { maxBps: 250 })).toBe(250)
    expect(budgetUsdToBps(100, 0.01, { minFloorBps: 50 })).toBe(50)
  })

  it('tiny totalNotionalUsd still produces a valid clamped result, not a divide blowup', () => {
    const result = budgetUsdToBps(0.0001, 1)
    expect(result).toBe(DEFAULT_MAX_BPS) // huge ratio clamps to the ceiling, never NaN/Infinity
  })

  it('returns null for non-positive or non-finite totalNotionalUsd', () => {
    expect(budgetUsdToBps(0, 2)).toBeNull()
    expect(budgetUsdToBps(-5, 2)).toBeNull()
    expect(budgetUsdToBps(NaN, 2)).toBeNull()
    expect(budgetUsdToBps(Infinity, 2)).toBeNull()
  })

  it('returns null for negative or non-finite budgetUsd', () => {
    expect(budgetUsdToBps(100, -1)).toBeNull()
    expect(budgetUsdToBps(100, NaN)).toBeNull()
  })

  it('a zero budget clamps to the floor, not null (zero is a valid, if extreme, input)', () => {
    expect(budgetUsdToBps(100, 0)).toBe(MIN_FLOOR_BPS)
  })
})

describe('bpsToBudgetUsd (inverse, for display)', () => {
  it('round-trips a mid-range value', () => {
    expect(bpsToBudgetUsd(100, 200)).toBeCloseTo(2, 6)
  })

  it('300 bps default on $100 notional is $3', () => {
    expect(bpsToBudgetUsd(100, 300)).toBeCloseTo(3, 6)
  })

  it('returns null for non-positive or non-finite totalNotionalUsd', () => {
    expect(bpsToBudgetUsd(0, 200)).toBeNull()
    expect(bpsToBudgetUsd(NaN, 200)).toBeNull()
  })

  it('returns null for negative or non-finite bps', () => {
    expect(bpsToBudgetUsd(100, -1)).toBeNull()
    expect(bpsToBudgetUsd(100, NaN)).toBeNull()
  })

  it('zero bps yields $0, not null', () => {
    expect(bpsToBudgetUsd(100, 0)).toBe(0)
  })
})
