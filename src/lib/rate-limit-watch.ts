/**
 * [feat/retire-force-mev C3] Rate-limited sources (HTTP 429) are visible, not green.
 *
 * CoW's free quote API has answered 429 to our servers since 2026-10-29 while the monitor read every 429 as healthy
 * (status < 500). The state machine now keeps a `rateLimit` episode per source (H1 probe and/or the real quote path via the
 * H5 quorum — source-state-machine.ts); this module turns it into:
 *   - one `[SOURCE] <id>: rate-limited (429) since <first seen>` line per tick (tick result + log; the daily report reads the
 *     same `since` from /api/monitor/status),
 *   - an alert once the episode is RATE_LIMIT_ALERT_AFTER_MS old, repeated at most every RATE_LIMIT_ALERT_COOLDOWN_MS,
 *   - a recovery message when an episode that was alerted about ends.
 * Alerts go through the one alert path (emitTransitionAlert → Telegram/Email/Discord, dedup, grace).
 */
import { emitTransitionAlert } from './alert-wrapper'
import { forLog } from './log-sanitize'
import { markRateLimitAlerted, type RateLimitEpisode, type SourceStatus } from './source-state-machine'

export const RATE_LIMIT_ALERT_AFTER_MS = 30 * 60_000
export const RATE_LIMIT_ALERT_COOLDOWN_MS = 60 * 60_000

export function rateLimitLine(id: string, since: number): string {
  return `[SOURCE] ${id}: rate-limited (429) since ${new Date(since).toISOString()}`
}

/** "2h 05m" / "31m" — for alert text only. */
export function durationLabel(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** Pure: raise the alert once the episode is ≥ 30 min old, then at most once per hour while it lasts. */
export function shouldRaiseRateLimitAlert(rl: RateLimitEpisode, now: number): boolean {
  if (now - rl.since < RATE_LIMIT_ALERT_AFTER_MS) return false
  return rl.alertedAt === undefined || now - rl.alertedAt >= RATE_LIMIT_ALERT_COOLDOWN_MS
}

export interface RateLimitWatchDeps {
  emit: typeof emitTransitionAlert
  markAlerted: typeof markRateLimitAlerted
}

export interface RateLimitWatchResult {
  /** One `[SOURCE] …` line per currently rate-limited source. */
  lines: string[]
  raised: string[]
  recovered: string[]
}

/**
 * Run once per tick, after H1 and H5 have recorded this tick's evidence. `before` = statuses at tick start, `after` = now.
 * Never throws: an alert failure is logged and the tick goes on.
 */
export async function runRateLimitWatch(
  before: readonly SourceStatus[],
  after: readonly SourceStatus[],
  now: number = Date.now(),
  deps: RateLimitWatchDeps = { emit: emitTransitionAlert, markAlerted: markRateLimitAlerted },
): Promise<RateLimitWatchResult> {
  const result: RateLimitWatchResult = { lines: [], raised: [], recovered: [] }
  const afterById = new Map(after.map((s) => [s.id, s]))

  for (const s of after) {
    if (!s.rateLimit) continue
    const line = rateLimitLine(s.id, s.rateLimit.since)
    result.lines.push(line)
    console.warn(forLog(line))
    if (!shouldRaiseRateLimitAlert(s.rateLimit, now)) continue
    const retry = s.rateLimit.retryAfterSec ? `, Retry-After ${s.rateLimit.retryAfterSec}s` : ''
    const reason = `${line} — ${durationLabel(now - s.rateLimit.since)} (seen by ${s.rateLimit.via.join(' + ')}${retry}); source stays degraded and is still queried`
    try {
      await deps.emit(s.id, s.state, s.state, reason)
      await deps.markAlerted(s.id, now)
      result.raised.push(s.id)
    } catch (err) {
      console.error('[RATE-LIMIT] alert failed for %s:', forLog(s.id), forLog(err instanceof Error ? err.message : err))
    }
  }

  for (const b of before) {
    if (!b.rateLimit || b.rateLimit.alertedAt === undefined) continue // a blip nobody was told about ends silently
    const a = afterById.get(b.id)
    if (!a || a.rateLimit) continue
    const reason = `[SOURCE] ${b.id}: recovered — no longer rate-limited (429 since ${new Date(b.rateLimit.since).toISOString()}, lasted ${durationLabel(now - b.rateLimit.since)})`
    try {
      await deps.emit(b.id, b.state, a.state, reason)
      result.recovered.push(b.id)
    } catch (err) {
      console.error('[RATE-LIMIT] recovery alert failed for %s:', forLog(b.id), forLog(err instanceof Error ? err.message : err))
    }
  }
  return result
}
