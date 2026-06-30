/**
 * [chore/dca-resilience] Creation guard — a DCA whose schedule cannot finish
 * before it expires (interval × dcaTotal > expiry) is doomed to a partial,
 * eventually-failed order. dcaScheduleFitsExpiry() is the pure check the DCA
 * create form uses to warn/block at creation and suggest a fix.
 */
import { describe, it, expect } from 'vitest'
import { dcaScheduleFitsExpiry } from './dca-creation-guard'

describe('dcaScheduleFitsExpiry', () => {
  it('fits when the schedule completes well before expiry (10×1d within 30d)', () => {
    const r = dcaScheduleFitsExpiry({ intervalSeconds: 86_400, dcaTotal: 10, expirySeconds: 2_592_000 })
    expect(r.fits).toBe(true)
    expect(r.reason).toBeNull()
    expect(r.neededSeconds).toBe(864_000)
    expect(r.expirySeconds).toBe(2_592_000)
  })

  it('blocks when the schedule cannot finish before expiry (30×1d but only 7d expiry)', () => {
    const r = dcaScheduleFitsExpiry({ intervalSeconds: 86_400, dcaTotal: 30, expirySeconds: 604_800 })
    expect(r.fits).toBe(false)
    expect(r.neededSeconds).toBe(2_592_000)
    expect(typeof r.reason).toBe('string')
  })

  it('the block reason suggests all three remedies (longer expiry / fewer buys / shorter interval)', () => {
    const r = dcaScheduleFitsExpiry({ intervalSeconds: 86_400, dcaTotal: 30, expirySeconds: 604_800 })
    expect(r.reason).toMatch(/expir/i)
    expect(r.reason).toMatch(/buy|fewer/i)
    expect(r.reason).toMatch(/interval|shorter/i)
  })

  it('exact equality fits (needed === expiry: the last buy lands right at expiry)', () => {
    const r = dcaScheduleFitsExpiry({ intervalSeconds: 86_400, dcaTotal: 7, expirySeconds: 604_800 })
    expect(r.fits).toBe(true)
    expect(r.reason).toBeNull()
  })

  it('one second over the line blocks (needed = expiry + 1)', () => {
    const r = dcaScheduleFitsExpiry({ intervalSeconds: 1, dcaTotal: 605_800, expirySeconds: 604_800 })
    expect(r.fits).toBe(false)
  })

  it('does NOT block on degenerate / not-yet-entered inputs (fail open)', () => {
    for (const bad of [
      { intervalSeconds: 0, dcaTotal: 10, expirySeconds: 2_592_000 },
      { intervalSeconds: 86_400, dcaTotal: 0, expirySeconds: 2_592_000 },
      { intervalSeconds: 86_400, dcaTotal: 10, expirySeconds: 0 },
      { intervalSeconds: NaN, dcaTotal: 10, expirySeconds: 2_592_000 },
      { intervalSeconds: -1, dcaTotal: 10, expirySeconds: 2_592_000 },
    ]) {
      const r = dcaScheduleFitsExpiry(bad)
      expect(r.fits).toBe(true)
      expect(r.reason).toBeNull()
    }
  })
})
