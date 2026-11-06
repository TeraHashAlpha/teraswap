/**
 * [feat/retire-force-mev C3] `[SOURCE] <id>: rate-limited (429) since <first seen>` every tick; alert after 30 min, then at
 * most once per hour; a recovery message when an alerted episode ends (a blip nobody was told about ends silently).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./alert-wrapper', () => ({ emitTransitionAlert: vi.fn() }))
vi.mock('./source-state-machine', () => ({ markRateLimitAlerted: vi.fn() }))

import {
  RATE_LIMIT_ALERT_AFTER_MS,
  RATE_LIMIT_ALERT_COOLDOWN_MS,
  durationLabel,
  rateLimitLine,
  runRateLimitWatch,
  shouldRaiseRateLimitAlert,
} from './rate-limit-watch'
import type { SourceStatus } from './source-state-machine'

const T0 = Date.parse('2026-10-29T14:02:00Z')
const MIN = 60_000

function status(over: Partial<SourceStatus> = {}): SourceStatus {
  return { id: 'cowswap', state: 'degraded', lastCheckAt: T0, failureCount: 0, successCount: 0, latencyHistory: [], lastTransitionAt: T0, ...over }
}
const limited = (over: Partial<NonNullable<SourceStatus['rateLimit']>> = {}, s: Partial<SourceStatus> = {}) =>
  status({ rateLimit: { since: T0, lastSeenAt: T0, via: ['probe'], ...over }, ...s })

const emit = vi.fn()
const markAlerted = vi.fn()
const deps = { emit, markAlerted }

beforeEach(() => {
  emit.mockReset().mockResolvedValue(undefined)
  markAlerted.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('the line and the timing rule', () => {
  it('formats the exact [SOURCE] line', () => {
    expect(rateLimitLine('cowswap', T0)).toBe('[SOURCE] cowswap: rate-limited (429) since 2026-10-29T14:02:00.000Z')
  })
  it('durations read as minutes / hours', () => {
    expect(durationLabel(31 * MIN)).toBe('31m')
    expect(durationLabel(125 * MIN)).toBe('2h 05m')
  })
  it('alert only from 30 min in, then once per hour', () => {
    expect(RATE_LIMIT_ALERT_AFTER_MS).toBe(30 * MIN)
    expect(RATE_LIMIT_ALERT_COOLDOWN_MS).toBe(60 * MIN)
    const rl = { since: T0, lastSeenAt: T0, via: ['probe' as const] }
    expect(shouldRaiseRateLimitAlert(rl, T0 + 29 * MIN)).toBe(false)
    expect(shouldRaiseRateLimitAlert(rl, T0 + 30 * MIN)).toBe(true)
    const alerted = { ...rl, alertedAt: T0 + 30 * MIN }
    expect(shouldRaiseRateLimitAlert(alerted, T0 + 89 * MIN)).toBe(false)
    expect(shouldRaiseRateLimitAlert(alerted, T0 + 90 * MIN)).toBe(true)
  })
})

describe('runRateLimitWatch (one tick)', () => {
  it('a rate-limited source yields its line every tick; no alert before 30 min', async () => {
    const r = await runRateLimitWatch([limited()], [limited()], T0 + 10 * MIN, deps)
    expect(r.lines).toEqual(['[SOURCE] cowswap: rate-limited (429) since 2026-10-29T14:02:00.000Z'])
    expect(emit).not.toHaveBeenCalled()
  })

  it('at 30 min: one alert through the alert path, with the line, the duration and the signals; then marked', async () => {
    const now = T0 + 31 * MIN
    const r = await runRateLimitWatch([limited()], [limited({ via: ['probe', 'quote'], retryAfterSec: 30 })], now, deps)
    expect(r.raised).toEqual(['cowswap'])
    expect(emit).toHaveBeenCalledTimes(1)
    const [id, from, to, reason] = emit.mock.calls[0]
    expect([id, from, to]).toEqual(['cowswap', 'degraded', 'degraded'])
    expect(reason).toContain('[SOURCE] cowswap: rate-limited (429) since 2026-10-29T14:02:00.000Z — 31m')
    expect(reason).toContain('seen by probe + quote, Retry-After 30s')
    expect(markAlerted).toHaveBeenCalledWith('cowswap', now)
  })

  it('inside the 1 h cooldown: the line, no second alert', async () => {
    const s = limited({ alertedAt: T0 + 30 * MIN })
    const r = await runRateLimitWatch([s], [s], T0 + 80 * MIN, deps)
    expect(r.lines).toHaveLength(1)
    expect(emit).not.toHaveBeenCalled()
  })

  it('recovery: an alerted episode that ended → one recovery message', async () => {
    const before = limited({ alertedAt: T0 + 30 * MIN })
    const after = status({ state: 'degraded' })
    const r = await runRateLimitWatch([before], [after], T0 + 125 * MIN, deps)
    expect(r.lines).toEqual([])
    expect(r.recovered).toEqual(['cowswap'])
    expect(emit).toHaveBeenCalledWith('cowswap', 'degraded', 'degraded', '[SOURCE] cowswap: recovered — no longer rate-limited (429 since 2026-10-29T14:02:00.000Z, lasted 2h 05m)')
  })

  it('a blip nobody was alerted about ends silently', async () => {
    const r = await runRateLimitWatch([limited()], [status()], T0 + 5 * MIN, deps)
    expect(r.recovered).toEqual([])
    expect(emit).not.toHaveBeenCalled()
  })

  it('an alert failure never throws out of the tick', async () => {
    emit.mockRejectedValueOnce(new Error('telegram down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await runRateLimitWatch([], [limited()], T0 + 40 * MIN, deps)
    expect(r.raised).toEqual([])
    expect(markAlerted).not.toHaveBeenCalled()
  })
})
