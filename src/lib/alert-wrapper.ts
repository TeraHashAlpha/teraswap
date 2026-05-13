/**
 * Alert fan-out wrapper for source state transitions.
 *
 * Fires exactly once per unique {sourceId, from, to} transition within a
 * dedup window (1h standard, 5min for P0). Fans out to Telegram, Email,
 * and Discord in parallel.
 *
 * - Dedup: KV key teraswap:alert:dedup:{sourceId}:{from}:{to}, TTL varies.
 * - Grace: process.env.MONITOR_GRACE_UNTIL (ISO 8601). Suppresses alerts
 *   during planned maintenance EXCEPT P0/critical transitions.
 * - Isolation: each channel failure is logged, never thrown. The monitoring
 *   loop is never blocked by alert delivery.
 *
 * @internal — server-only module. Same import restrictions as source-state-machine.ts.
 */

import { kv } from '@/lib/kv'
import type { SourceState } from './source-state-machine'
import { isP0Reason } from './p0-reasons'
import { isInGracePeriodAsync } from './grace-period'
import { sendTelegramAlert } from './alert-channels/telegram'
import { sendEmailAlert } from './alert-channels/email'
import { sendDiscordAlert } from './alert-channels/discord'

// ── Types ────────────────────────────────────────────────

export interface AlertPayload {
  sourceId: string
  from: SourceState
  to: SourceState
  reason?: string
  timestamp: string // ISO 8601
}

// ── Constants ────────────────────────────────────────────

const DEDUP_TTL_SECONDS = 900      // 15 minutes — counter-based window
const DEDUP_TTL_P0_SECONDS = 300   // 5 minutes — P0/critical alerts
const MAX_ALERTS_PER_WINDOW = 3    // max alerts before suppression within window
const DEDUP_KEY_PREFIX = 'teraswap:alert:dedup:'

/** [P110/M-04] KV key holding `Record<category, count>` of grace-tagged
 *  alerts since the current grace period started. Cleared after the
 *  post-grace summary is emitted. 24 h TTL is a defensive ceiling —
 *  the normal lifecycle is "set during grace, cleared at first emit
 *  after grace ends". */
const GRACE_COUNTS_KEY = 'teraswap:alert:grace-counts'
const GRACE_COUNTS_TTL = 24 * 60 * 60

// ── Counter-based dedup ─────────────────────────────────

interface DedupCounter {
  count: number
  firstAt: string
  lastAt: string
}

function dedupKey(sourceId: string, from: SourceState, to: SourceState): string {
  return `${DEDUP_KEY_PREFIX}${sourceId}:${from}:${to}`
}

/**
 * Read the dedup counter. Returns null if no counter exists or KV fails (fail-open).
 */
async function getCounter(sourceId: string, from: SourceState, to: SourceState): Promise<DedupCounter | null> {
  try {
    return await kv.get<DedupCounter>(dedupKey(sourceId, from, to))
  } catch (err) {
    console.warn('[ALERT] KV dedup check failed, allowing alert:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Check if alert should be suppressed based on counter.
 * Returns true only when count >= MAX_ALERTS_PER_WINDOW.
 */
async function shouldSuppress(sourceId: string, from: SourceState, to: SourceState): Promise<boolean> {
  const counter = await getCounter(sourceId, from, to)
  if (!counter) return false
  return counter.count >= MAX_ALERTS_PER_WINDOW
}

/**
 * Increment the dedup counter (or create if new). Returns the updated counter.
 */
async function incrementCounter(
  sourceId: string,
  from: SourceState,
  to: SourceState,
  ttl: number = DEDUP_TTL_SECONDS,
): Promise<DedupCounter> {
  const key = dedupKey(sourceId, from, to)
  const now = new Date().toISOString()

  try {
    const existing = await kv.get<DedupCounter>(key)
    const updated: DedupCounter = existing
      ? { count: existing.count + 1, firstAt: existing.firstAt, lastAt: now }
      : { count: 1, firstAt: now, lastAt: now }

    await kv.set(key, updated, { ex: ttl })
    return updated
  } catch (err) {
    console.warn('[ALERT] KV dedup increment failed:', err instanceof Error ? err.message : err)
    return { count: 1, firstAt: now, lastAt: now }
  }
}

/**
 * Build an occurrence note based on the counter state.
 */
function buildOccurrenceNote(counter: DedupCounter, sourceId: string): string | undefined {
  if (counter.count <= 1) return undefined

  const elapsedMs = new Date(counter.lastAt).getTime() - new Date(counter.firstAt).getTime()
  const elapsedMin = Math.max(1, Math.round(elapsedMs / 60_000))

  if (counter.count === MAX_ALERTS_PER_WINDOW) {
    return `⚠️ Source ${sourceId} is oscillating — ${counter.count} transitions in ${elapsedMin}min. Consider maintenance grace (/grace ${elapsedMin}).`
  }

  return `(${ordinal(counter.count)} occurrence in ${elapsedMin}min)`
}

function ordinal(n: number): string {
  if (n === 2) return '2nd'
  if (n === 3) return '3rd'
  return `${n}th`
}

// ── Fan-out ──────────────────────────────────────────────

const CHANNELS = [
  { name: 'telegram', send: sendTelegramAlert },
  { name: 'email', send: sendEmailAlert },
  { name: 'discord', send: sendDiscordAlert },
] as const

// ── [P110/M-04] Grace-period bookkeeping ─────────────────
//
// During grace, every non-P0 alert still fires on every channel but is
// tagged with [GRACE] so on-call operators see the maintenance context.
// We count how many alerts got tagged (keyed by sourceId:from→to) so
// that the first alert after grace ends can render a single summary
// instead of letting the operator infer the impact from scrollback.

type GraceCounts = Record<string, number>

async function readGraceCounts(): Promise<GraceCounts> {
  try {
    const raw = await kv.get<unknown>(GRACE_COUNTS_KEY)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    // Strict shape check: counts must be a flat Record<string, number>.
    // This guards against KV returning a stale value with a different
    // schema (e.g. a dedup counter) ending up parsed as grace counts.
    const out: GraceCounts = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        out[k] = v
      } else {
        return {}
      }
    }
    return out
  } catch {
    return {}
  }
}

async function incrementGraceCount(category: string): Promise<void> {
  try {
    const counts = await readGraceCounts()
    counts[category] = (counts[category] ?? 0) + 1
    await kv.set(GRACE_COUNTS_KEY, counts, { ex: GRACE_COUNTS_TTL })
  } catch (err) {
    console.warn('[ALERT] grace-counts write failed:', err instanceof Error ? err.message : err)
  }
}

async function clearGraceCounts(): Promise<void> {
  try {
    await kv.set(GRACE_COUNTS_KEY, {}, { ex: GRACE_COUNTS_TTL })
  } catch (err) {
    console.warn('[ALERT] grace-counts clear failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * [P110/M-04] Emit a single summary alert to every channel when a grace
 * period ends with at least one suppressed alert.
 *
 * Exported so the monitoring loop can also trigger the flush on its
 * own cadence; it's safe to call any number of times (a no-op when
 * counts are empty).
 */
export async function flushGraceEndSummary(): Promise<void> {
  const counts = await readGraceCounts()
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total === 0) return

  // Build a one-line summary keyed by category, sorted desc by count.
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${cat}×${n}`)
    .join(', ')

  const summary: AlertPayload = {
    sourceId: 'grace-end-summary',
    from: 'degraded',
    to: 'active',
    reason:
      `Grace period ended — normal alerting resumed. `
      + `${total} alert(s) were tagged [GRACE] during the window: ${breakdown}.`,
    timestamp: new Date().toISOString(),
  }

  // Each channel handles its own errors via .catch; the summary is
  // best-effort and never throws.
  await Promise.allSettled(
    CHANNELS.map((ch) =>
      ch.send(summary).catch((err) => {
        console.error(
          `[ALERT:${ch.name}] grace-end summary failed: ${err instanceof Error ? err.message : err}`,
        )
      }),
    ),
  )

  await clearGraceCounts()
}

// ── Main entry point ─────────────────────────────────────

export async function emitTransitionAlert(
  sourceId: string,
  from: SourceState,
  to: SourceState,
  reason?: string,
): Promise<void> {
  const critical = isP0Reason(reason)
  const inGrace = await isInGracePeriodAsync()

  // [P110/M-04] If we just exited a grace period, emit a single summary
  // before the current alert so operators see the maintenance impact
  // up-front. flushGraceEndSummary is a no-op when no counts are stored.
  if (!inGrace) {
    await flushGraceEndSummary()
  }

  // ① [API-H-03 + P110/M-04] Grace period:
  //    - P0/critical bypasses the grace tag entirely (full-severity fan-out).
  //    - Non-P0 fans out to ALL channels with [GRACE] tag — every channel
  //      sees the same tagged alert, which closes the M-04 inconsistency
  //      where only Telegram saw grace-tagged alerts and Email + Discord
  //      either flooded at full severity or saw nothing.
  //    Dedup is skipped during grace so post-grace alerts for the same
  //    transition still fire normally.
  if (inGrace && !critical) {
    const payload: AlertPayload = {
      sourceId,
      from,
      to,
      reason,
      timestamp: new Date().toISOString(),
    }
    const category = `${sourceId}:${from}->${to}`
    console.log(`[ALERT] grace-tagged (all channels) ${category}`)

    // Increment the per-category grace counter; the next post-grace
    // alert flushes a summary built from these counts.
    await incrementGraceCount(category)

    // Fan out to every channel with `{ grace: true }`. Each channel is
    // responsible for prepending [GRACE] to its display format.
    await Promise.allSettled(
      CHANNELS.map((ch) =>
        // We pass { grace: true } to every channel; the channel types
        // accept the option. TypeScript-wise the unified call expression
        // narrows ch.send to the most-specific overload, which all three
        // channels now share (payload, options?).
        (ch.send as (p: AlertPayload, o?: { grace?: boolean }) => Promise<void>)(
          payload,
          { grace: true },
        ).catch((err) => {
          console.error(
            `[ALERT:${ch.name}] grace delivery failed for ${sourceId}: ${err instanceof Error ? err.message : err}`,
          )
        }),
      ),
    )
    return
  }

  // ② Counter-based dedup — suppress after MAX_ALERTS_PER_WINDOW (P0 bypasses)
  const ttl = critical ? DEDUP_TTL_P0_SECONDS : DEDUP_TTL_SECONDS
  if (!critical && await shouldSuppress(sourceId, from, to)) {
    console.log(`[ALERT] dedup suppressed (≥${MAX_ALERTS_PER_WINDOW} in window), skipping ${sourceId}: ${from} → ${to}`)
    return
  }

  // ③ Increment counter BEFORE dispatching (at-most-once semantics)
  const counter = await incrementCounter(sourceId, from, to, ttl)
  const occurrenceNote = buildOccurrenceNote(counter, sourceId)

  // ④ Build payload — append occurrence note to reason if present
  const enrichedReason = occurrenceNote
    ? reason ? `${reason} ${occurrenceNote}` : occurrenceNote
    : reason

  const payload: AlertPayload = {
    sourceId,
    from,
    to,
    reason: enrichedReason,
    timestamp: new Date().toISOString(),
  }

  // ⑤ Fan out to all channels in parallel — never throw
  const results = await Promise.allSettled(
    CHANNELS.map(ch =>
      ch.send(payload).catch(err => {
        console.error(`[ALERT:${ch.name}] delivery failed for ${sourceId}: ${err instanceof Error ? err.message : err}`)
        throw err // re-throw so allSettled marks it as "rejected"
      }),
    ),
  )

  // ⑥ Log summary
  const succeeded = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected').length
  console.log(`[ALERT] ${sourceId}: ${from} → ${to} — ${succeeded}/${CHANNELS.length} channels delivered${failed ? `, ${failed} failed` : ''}`)
}

// ── Test helpers (exported for unit tests only) ──────────

export const _internal = {
  isInGracePeriodAsync,
  isP0Reason,
  shouldSuppress,
  incrementCounter,
  getCounter,
  buildOccurrenceNote,
  dedupKey,
  DEDUP_TTL_SECONDS,
  DEDUP_TTL_P0_SECONDS,
  MAX_ALERTS_PER_WINDOW,
  // [P110/M-04] grace-counts internals
  GRACE_COUNTS_KEY,
  readGraceCounts,
  clearGraceCounts,
} as const
