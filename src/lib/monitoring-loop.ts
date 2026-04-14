/**
 * Monitoring loop — runs health checks on all endpoints and
 * feeds results into the source state machine.
 *
 * Designed for Vercel Cron: each call to runMonitoringTick()
 * performs one full round of checks. The cron job calls this
 * every 60s via /api/monitor/tick.
 *
 * Alert on state transitions only (not every tick).
 */

import { kv } from '@vercel/kv'
import { MONITORED_ENDPOINTS } from './monitored-endpoints'
import { runHealthCheck } from './health-check'
import {
  beginTick,
  recordHealthCheck,
  checkAutoRecovery,
  forceDisable,
  getAllStatuses,
  setTransitionCallback,
  type SourceState,
} from './source-state-machine'
import {
  loadBaseline,
  validateTLS,
  validateDNS,
  captureLiveTLS,
  captureLiveDNS,
} from './fingerprint-validator'

// ── Alert on state transitions ──────────────────────────

let alertInitialized = false

function initAlerts(): void {
  if (alertInitialized) return
  alertInitialized = true

  setTransitionCallback((id, from, to, reason) => {
    if (to === 'degraded' || to === 'disabled') {
      const emoji = to === 'disabled' ? '🔴' : '⚠️'
      const message = `${emoji} Source ${to}: <b>${id}</b>\nFrom: ${from}\nReason: ${reason}\nTime: ${new Date().toISOString()}`
      sendTelegramAlert(message).catch(() => {})
    }
    if (to === 'active' && (from === 'degraded' || from === 'disabled')) {
      const message = `✅ Source recovered: <b>${id}</b>\nFrom: ${from}\nReason: ${reason}\nTime: ${new Date().toISOString()}`
      sendTelegramAlert(message).catch(() => {})
    }
  })
}

async function sendTelegramAlert(message: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!botToken || !chatId) return

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🚨 <b>TeraSwap Monitoring</b>\n\n${message}`,
        parse_mode: 'HTML',
      }),
    })
  } catch (err) {
    console.warn('[MONITOR] Telegram alert failed:', err)
  }
}

// ── Heartbeat keys ──────────────────────────────────────

const HEARTBEAT_KEY = 'teraswap:monitor:lastTick'
const TICK_COUNT_KEY = 'teraswap:monitor:tickCount'

async function writeHeartbeat(): Promise<void> {
  try {
    const pipeline = kv.pipeline()
    pipeline.set(HEARTBEAT_KEY, new Date().toISOString(), { ex: 3600 }) // 1h TTL
    pipeline.incr(TICK_COUNT_KEY)
    await pipeline.exec()
  } catch (err) {
    console.warn('[MONITOR] Heartbeat write failed:', err instanceof Error ? err.message : err)
  }
}

// ── Main tick function ──────────────────────────────────

export interface MonitoringTickResult {
  timestamp: string
  checksRun: number
  failures: number
  transitions: string[]
  recovered: string[]
  statuses: Awaited<ReturnType<typeof getAllStatuses>>
}

/**
 * Run one full monitoring tick.
 * Returns a summary of the results for the API response.
 */
export async function runMonitoringTick(): Promise<MonitoringTickResult> {
  initAlerts()

  // Invalidate per-tick cache (fresh reads from KV)
  beginTick()

  const transitions: string[] = []
  const allBefore = await getAllStatuses()
  const originalStates = new Map(allBefore.map(s => [s.id, s.state]))

  let failures = 0

  // ── H1: Health checks ─────────────────────────────────
  await Promise.allSettled(
    MONITORED_ENDPOINTS.map(async (ep) => {
      const result = await runHealthCheck(ep)
      await recordHealthCheck(ep.id, result)
      if (!result.ok) failures++
    })
  )

  // ── H2: TLS + DNS baseline validation ─────────────────
  const baseline = loadBaseline()
  if (baseline) {
    await Promise.allSettled(
      MONITORED_ENDPOINTS.map(async (ep) => {
        try {
          const cert = await captureLiveTLS(ep.hostname)
          if (cert) {
            const tlsResult = validateTLS(ep.id, cert)
            if (!tlsResult.ok) {
              console.error(`[H2] 🚨 TLS mismatch for ${ep.id}: ${tlsResult.reason}`)
              await forceDisable(ep.id, `tls-fingerprint-change: ${tlsResult.reason}`)
            }
          }

          const dnsRecords = await captureLiveDNS(ep.hostname)
          const dnsResult = validateDNS(ep.id, dnsRecords)
          if (!dnsResult.ok) {
            console.error(`[H2] 🚨 DNS mismatch for ${ep.id}: ${dnsResult.reason}`)
            await forceDisable(ep.id, `dns-record-change: ${dnsResult.reason}`)
          }
        } catch (err) {
          console.warn(`[H2] Error validating ${ep.id}:`, err)
        }
      })
    )
  }

  // Detect state transitions
  const allAfter = await getAllStatuses()
  for (const s of allAfter) {
    const prev = originalStates.get(s.id)
    if (prev && prev !== s.state) {
      transitions.push(`${s.id}: ${prev} → ${s.state}`)
    }
  }

  // Check for auto-recovery of non-critical disabled sources
  const recovered = await checkAutoRecovery()

  // Write heartbeat to KV (dead-man's-switch)
  await writeHeartbeat()

  return {
    timestamp: new Date().toISOString(),
    checksRun: MONITORED_ENDPOINTS.length,
    failures,
    transitions,
    recovered,
    statuses: allAfter,
  }
}
