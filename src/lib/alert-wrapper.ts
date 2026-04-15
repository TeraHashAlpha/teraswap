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
import { isInGracePeriod } from './grace-period'
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

const DEDUP_TTL_SECONDS = 3600     // 1 hour — standard alerts
const DEDUP_TTL_P0_SECONDS = 300   // 5 minutes — P0/critical alerts
const DEDUP_KEY_PREFIX = 'teraswap:alert:dedup:'

// ── Dedup helpers ────────────────────────────────────────

function dedupKey(sourceId: string, from: SourceState, to: SourceState): string {
  return `${DEDUP_KEY_PREFIX}${sourceId}:${from}:${to}`
}

async function isDuplicate(sourceId: string, from: SourceState, to: SourceState): Promise<boolean> {
  try {
    const existing = await kv.get(dedupKey(sourceId, from, to))
    return existing !== null
  } catch (err) {
    // KV unavailable → fail open (allow alert through to avoid silent failures)
    console.warn('[ALERT] KV dedup check failed, allowing alert:', err instanceof Error ? err.message : err)
    return false
  }
}

async function markSent(sourceId: string, from: SourceState, to: SourceState, ttl: number = DEDUP_TTL_SECONDS): Promise<void> {
  try {
    await kv.set(dedupKey(sourceId, from, to), Date.now(), { ex: ttl })
  } catch (err) {
    console.warn('[ALERT] KV dedup mark failed:', err instanceof Error ? err.message : err)
  }
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

  // ① Grace period check — P0/critical always bypasses
  if (isInGracePeriod() && !critical) {
    console.log(`[ALERT] suppressed (grace period) ${sourceId}: ${from} → ${to}`)
    return
  }

  // ② Dedup — same transition within window is skipped (P0 bypasses dedup)
  if (!critical && await isDuplicate(sourceId, from, to)) {
    console.log(`[ALERT] dedup hit, skipping ${sourceId}: ${from} → ${to}`)
    return
  }

  // ③ Build payload
  const payload: AlertPayload = {
    sourceId,
    from,
    to,
    reason,
    timestamp: new Date().toISOString(),
  }

  // ④ Mark sent BEFORE dispatching (at-most-once semantics for dedup)
  //    P0 gets shorter TTL (5min) so repeated critical events aren't silenced long
  await markSent(sourceId, from, to, critical ? DEDUP_TTL_P0_SECONDS : DEDUP_TTL_SECONDS)

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
  isInGracePeriod,
  isP0Reason,
  isDuplicate,
  markSent,
  dedupKey,
  DEDUP_TTL_SECONDS,
  DEDUP_TTL_P0_SECONDS,
} as const
