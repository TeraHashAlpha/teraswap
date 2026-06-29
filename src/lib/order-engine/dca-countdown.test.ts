/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] Pure next-buy countdown math for the DCA Positions dashboard.
 *
 * next buy = last fill's created_at + dcaInterval; with ZERO fills it is the schedule start
 * (order creation) + dcaInterval. At/after the target the keeper runs within ~30s → "due".
 * Pure functions so the 1s tick is jank-free and unit-testable (no timers in the math).
 */

import { describe, it, expect } from 'vitest'
import { nextBuyAtMs, formatHMS, isDue } from './dca-countdown'

const HOUR = 3600
const START = 1_700_000_000_000 // fixed epoch ms

describe('nextBuyAtMs', () => {
  it('after a fill: last fill created_at + interval', () => {
    const lastFillAtMs = START + 5 * HOUR * 1000
    expect(nextBuyAtMs({ lastFillAtMs, scheduleStartMs: START, intervalSec: HOUR })).toBe(lastFillAtMs + HOUR * 1000)
  })

  it('with ZERO fills: schedule start + interval (not "now")', () => {
    expect(nextBuyAtMs({ lastFillAtMs: null, scheduleStartMs: START, intervalSec: HOUR })).toBe(START + HOUR * 1000)
  })

  it('uses the daily interval for a 1d DCA', () => {
    expect(nextBuyAtMs({ lastFillAtMs: null, scheduleStartMs: START, intervalSec: 24 * HOUR })).toBe(START + 24 * HOUR * 1000)
  })
})

describe('formatHMS', () => {
  it('formats hours:minutes:seconds zero-padded', () => {
    expect(formatHMS((1 * HOUR + 2 * 60 + 3) * 1000)).toBe('01:02:03')
  })
  it('formats sub-minute', () => {
    expect(formatHMS(90 * 1000)).toBe('00:01:30')
  })
  it('does not cap hours at 24 (long intervals)', () => {
    expect(formatHMS(25 * HOUR * 1000)).toBe('25:00:00')
  })
  it('floors to whole seconds (no jitter from sub-second ms)', () => {
    expect(formatHMS(90 * 1000 + 999)).toBe('00:01:30')
  })
  it('clamps negatives and zero to 00:00:00', () => {
    expect(formatHMS(0)).toBe('00:00:00')
    expect(formatHMS(-5000)).toBe('00:00:00')
  })
})

describe('isDue', () => {
  it('is true at or past the target (keeper will run soon)', () => {
    expect(isDue(0)).toBe(true)
    expect(isDue(-1)).toBe(true)
  })
  it('is false while time remains', () => {
    expect(isDue(1)).toBe(false)
    expect(isDue(60_000)).toBe(false)
  })
})
