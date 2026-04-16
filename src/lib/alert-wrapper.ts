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

import { kv } from '@vercel/kv'
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

// ── Main entry point ─────────────────────────────────────

export async function emitTransitionAlert(
  sourceId: string,
  from: SourceState,
  to: SourceState,
  reason?: string,
): Promise<void> {
  const critical = isP0Reason(reason)
  const inGrace = await isInGracePeriodAsync()

  // ① [API-H-03] Grace period: P0/critical bypasses entirely.
  //    Non-P0 during grace → send to Telegram only with [GRACE] tag, skip dedup.
  if (inGrace && !critical) {
    const payload: AlertPayload = {
      sourceId,
      from,
      to,
      reason,
      timestamp: new Date().toISOString(),
    }

    console.log(`[ALERT] grace-tagged (Telegram only) ${sourceId}: ${from} → ${to}`)

    // Send to Telegram only with grace flag — no buttons, tagged message
    // Do NOT mark dedup — post-grace alert for same transition should still fire
    await sendTelegramAlert(payload, { grace: true }).catch(err => {
      console.error(`[ALERT:telegram] grace delivery failed for ${sourceId}: ${err instanceof Error ? err.message : err}`)
    })
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
} as const
