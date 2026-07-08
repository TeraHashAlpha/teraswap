/**
 * [CHORE-DCA-CUSTOM-PERIODS] Pure Custom-mode DCA helpers.
 *
 * Bounds asserted here mirror what was verified read-only against the current deployment
 * (contract dcaTotal>0/dcaInterval>0, no on-chain upper bound; keeper polls every 30s;
 * the order-creation API hard-rejects expiry > 90 days) — see dca-custom.ts header + FEEDBACK.
 */

import { describe, it, expect } from 'vitest'
import {
  DCA_CUSTOM_BUYS_MIN,
  DCA_CUSTOM_INTERVAL_NUMBER_MIN,
  DCA_CUSTOM_INTERVAL_NUMBER_MAX,
  clampCustomBuys,
  clampCustomIntervalNumber,
  customIntervalSeconds,
  deriveCustomExpirySeconds,
  applyDcaMinChunkGuard,
  getDcaMinChunkUsd,
  DCA_MIN_CHUNK_USD_DEFAULT,
  customDcaSummary,
} from './dca-custom'
import { MAX_EXPIRY_DAYS } from './config'

describe('clampCustomBuys / clampCustomIntervalNumber — input clamps', () => {
  it('clamps buys below the minimum up to 1', () => {
    expect(clampCustomBuys(0)).toBe(1)
    expect(clampCustomBuys(-5)).toBe(1)
  })

  it('clamps buys above the maximum down to 100', () => {
    expect(clampCustomBuys(101)).toBe(100)
    expect(clampCustomBuys(9999)).toBe(100)
  })

  it('leaves an in-range buys value unchanged', () => {
    expect(clampCustomBuys(42)).toBe(42)
  })

  it('rounds a fractional buys value', () => {
    expect(clampCustomBuys(7.6)).toBe(8)
  })

  it('falls back to the minimum for any non-finite input (NaN, ±Infinity) — never signs a garbage buys count', () => {
    expect(clampCustomBuys(NaN)).toBe(DCA_CUSTOM_BUYS_MIN)
    expect(clampCustomBuys(Infinity)).toBe(DCA_CUSTOM_BUYS_MIN)
    expect(clampCustomBuys(-Infinity)).toBe(DCA_CUSTOM_BUYS_MIN)
  })

  it('clamps the interval number to [1, 10]', () => {
    expect(clampCustomIntervalNumber(0)).toBe(DCA_CUSTOM_INTERVAL_NUMBER_MIN)
    expect(clampCustomIntervalNumber(11)).toBe(DCA_CUSTOM_INTERVAL_NUMBER_MAX)
    expect(clampCustomIntervalNumber(5)).toBe(5)
  })
})

describe('customIntervalSeconds — unit conversion, clamped', () => {
  it('converts hours', () => {
    expect(customIntervalSeconds(1, 'hours')).toBe(3600)
    expect(customIntervalSeconds(10, 'hours')).toBe(36_000)
  })

  it('converts days', () => {
    expect(customIntervalSeconds(1, 'days')).toBe(86_400)
    expect(customIntervalSeconds(10, 'days')).toBe(864_000)
  })

  it('clamps an out-of-range number before converting', () => {
    expect(customIntervalSeconds(50, 'days')).toBe(10 * 86_400)
    expect(customIntervalSeconds(0, 'hours')).toBe(1 * 3600)
  })

  it('always returns a positive value — mirrors the contract InvalidDCAInterval guard (dcaInterval must be > 0)', () => {
    for (const n of [-5, 0, 1, 10, 99]) {
      for (const unit of ['hours', 'days'] as const) {
        expect(customIntervalSeconds(n, unit)).toBeGreaterThan(0)
      }
    }
  })
})

describe('deriveCustomExpirySeconds — auto-derived expiry, capped at MAX_EXPIRY_DAYS', () => {
  it('derives interval*buys + a buffer when the schedule fits well within the cap', () => {
    // 1h interval × 5 buys = 18,000s needed. Buffer = max(3600, 10% of 3600) = 3600.
    const seconds = deriveCustomExpirySeconds({ intervalSeconds: 3600, buys: 5 })
    expect(seconds).toBe(18_000 + 3600)
  })

  it('uses a larger buffer for longer intervals (10% of interval, floor 1h)', () => {
    // 10-day interval × 2 buys = 20 days needed. Buffer = max(3600, 10%*864000=86400) = 86400 (1 day).
    const seconds = deriveCustomExpirySeconds({ intervalSeconds: 864_000, buys: 2 })
    expect(seconds).toBe(864_000 * 2 + 86_400)
  })

  it('hard-caps at MAX_EXPIRY_DAYS when interval*buys already exceeds it — the derived value is LESS than the schedule needs', () => {
    // 10 days × 100 buys = 1000 days — far past the 90-day ceiling.
    const intervalSeconds = 10 * 86_400
    const buys = 100
    const neededSeconds = intervalSeconds * buys
    const seconds = deriveCustomExpirySeconds({ intervalSeconds, buys })
    expect(seconds).toBe(MAX_EXPIRY_DAYS * 86_400)
    // This is the "hard-warn" contract: the existing dcaScheduleFitsExpiry() gate in DCAPanel
    // reads this returned expiry — since it's below what the schedule needs, that gate blocks
    // submit with its standard message. No separate warning string is needed here.
    expect(seconds).toBeLessThan(neededSeconds)
  })

  it('never exceeds the cap for any in-range buys/interval combination', () => {
    for (const buys of [1, 50, 100]) {
      for (const n of [1, 5, 10]) {
        for (const unit of ['hours', 'days'] as const) {
          const seconds = deriveCustomExpirySeconds({ intervalSeconds: customIntervalSeconds(n, unit), buys })
          expect(seconds).toBeLessThanOrEqual(MAX_EXPIRY_DAYS * 86_400)
        }
      }
    }
  })
})

describe('getDcaMinChunkUsd — env override with a sane default', () => {
  it('returns the default when unset', () => {
    expect(getDcaMinChunkUsd()).toBe(DCA_MIN_CHUNK_USD_DEFAULT)
  })
})

describe('applyDcaMinChunkGuard — SC-02 dust guard', () => {
  it('passes through unchanged when the total is unpriced (fails OPEN on pricing — the base-unit floor is the backstop)', () => {
    const r = applyDcaMinChunkGuard({ totalUsd: null, requestedBuys: 50, minChunkUsd: 5 })
    expect(r).toEqual({ buys: 50, warning: null, blocked: false })
  })

  it('passes through unchanged when each buy already clears the minimum', () => {
    // $1000 / 20 buys = $50/buy ≥ $5 minimum.
    const r = applyDcaMinChunkGuard({ totalUsd: 1000, requestedBuys: 20, minChunkUsd: 5 })
    expect(r).toEqual({ buys: 20, warning: null, blocked: false })
  })

  it('caps buys down when the requested count would produce dust, with a warning', () => {
    // $100 / 50 buys = $2/buy < $5 minimum. Max buys clearing $5 = floor(100/5) = 20.
    const r = applyDcaMinChunkGuard({ totalUsd: 100, requestedBuys: 50, minChunkUsd: 5 })
    expect(r.buys).toBe(20)
    expect(r.blocked).toBe(false)
    expect(r.warning).toMatch(/50 buys/)
    expect(r.warning).toMatch(/capped to 20/)
  })

  it('blocks (does not just cap to 1) when even a single buy would be dust', () => {
    // $3 total can never clear a $5-per-buy minimum, even at 1 buy.
    const r = applyDcaMinChunkGuard({ totalUsd: 3, requestedBuys: 10, minChunkUsd: 5 })
    expect(r.blocked).toBe(true)
    expect(r.buys).toBe(10) // unchanged — caller must block submit, not silently resize
    expect(r.warning).toMatch(/below the \$5 minimum/)
  })

  it('never lets the effective buys produce a per-chunk below the minimum (property check)', () => {
    for (const totalUsd of [10, 47, 100, 999]) {
      for (const requestedBuys of [1, 10, 50, 100]) {
        const r = applyDcaMinChunkGuard({ totalUsd, requestedBuys, minChunkUsd: 5 })
        if (!r.blocked) {
          expect(totalUsd / r.buys).toBeGreaterThanOrEqual(5)
        }
      }
    }
  })

  it('no-ops when there is no total yet (buys unchanged, no warning)', () => {
    expect(applyDcaMinChunkGuard({ totalUsd: 0, requestedBuys: 10, minChunkUsd: 5 }))
      .toEqual({ buys: 10, warning: null, blocked: false })
  })
})

describe('customDcaSummary — live non-alarmist summary line', () => {
  it('renders buys, per-buy amount, interval, and a rounded expiry', () => {
    const s = customDcaSummary({ buys: 12, perBuyLabel: '0.05 WETH', intervalLabel: '3h', expirySeconds: 18_000 })
    expect(s).toBe('12 buys of 0.05 WETH every 3h, ends ~5h.')
  })

  it('shows a day-scale expiry once past 24h', () => {
    const s = customDcaSummary({ buys: 4, perBuyLabel: '10 USDC', intervalLabel: '2d', expirySeconds: 9 * 86_400 })
    expect(s).toBe('4 buys of 10 USDC every 2d, ends ~9.0d.')
  })
})
