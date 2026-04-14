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

import { MONITORED_ENDPOINTS } from './monitored-endpoints'
import { runHealthCheck } from './health-check'
import {
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
    // Only alert on transitions TO degraded or disabled
    if (to === 'degraded' || to === 'disabled') {
      const emoji = to === 'disabled' ? '🔴' : '⚠️'
      const message = `${emoji} Source ${to}: <b>${id}</b>\nFrom: ${from}\nReason: ${reason}\nTime: ${new Date().toISOString()}`

      // Fire-and-forget alert via internal endpoint
      sendInternalAlert(id, from, to, reason, message).catch(() => {})
    }
    // Alert on recovery too
    if (to === 'active' && (from === 'degraded' || from === 'disabled')) {
      const message = `✅ Source recovered: <b>${id}</b>\nFrom: ${from}\nReason: ${reason}\nTime: ${new Date().toISOString()}`
      sendInternalAlert(id, from, to, reason, message).catch(() => {})
    }
  })
}

async function sendInternalAlert(
  id: string,
  from: SourceState,
  to: SourceState,
  reason: string,
  message: string,
): Promise<void> {
  // Try Telegram directly if env vars are available (serverless context)
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (botToken && chatId) {
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

  console.log(`[MONITOR-ALERT] ${id}: ${from} → ${to} (${reason})`)
}

// ── Main tick function ──────────────────────────────────

export interface MonitoringTickResult {
  timestamp: string
  checksRun: number
  failures: number
  transitions: string[]
  recovered: string[]
  statuses: ReturnType<typeof getAllStatuses>
}

/**
 * Run one full monitoring tick.
 * Returns a summary of the results for the API response.
 */
export async function runMonitoringTick(): Promise<MonitoringTickResult> {
  initAlerts()

  const transitions: string[] = []
  const originalStates = new Map(
    getAllStatuses().map(s => [s.id, s.state])
  )

  let failures = 0

  // Run all health checks in parallel
  const results = await Promise.allSettled(
    MONITORED_ENDPOINTS.map(async (ep) => {
      const result = await runHealthCheck(ep)
      recordHealthCheck(ep.id, result)
      if (!result.ok) failures++
      return { id: ep.id, ...result }
    })
  )

  // ── H2: TLS + DNS baseline validation ──────────────────
  const baseline = loadBaseline()
  if (baseline) {
    await Promise.allSettled(
      MONITORED_ENDPOINTS.map(async (ep) => {
        try {
          // TLS fingerprint check
          const cert = await captureLiveTLS(ep.hostname)
          if (cert) {
            const tlsResult = validateTLS(ep.id, cert)
            if (!tlsResult.ok) {
              console.error(`[H2] 🚨 TLS mismatch for ${ep.id}: ${tlsResult.reason}`)
              forceDisable(ep.id, `tls-fingerprint-change: ${tlsResult.reason}`)
            }
          }

          // DNS record check
          const dnsRecords = await captureLiveDNS(ep.hostname)
          const dnsResult = validateDNS(ep.id, dnsRecords)
          if (!dnsResult.ok) {
            console.error(`[H2] 🚨 DNS mismatch for ${ep.id}: ${dnsResult.reason}`)
            forceDisable(ep.id, `dns-record-change: ${dnsResult.reason}`)
          }
        } catch (err) {
          // H2 errors don't block H1 — just log
          console.warn(`[H2] Error validating ${ep.id}:`, err)
        }
      })
    )
  }

  // Detect state transitions
  for (const s of getAllStatuses()) {
    const prev = originalStates.get(s.id)
    if (prev && prev !== s.state) {
      transitions.push(`${s.id}: ${prev} → ${s.state}`)
    }
  }

  // Check for auto-recovery of non-critical disabled sources
  const recovered = checkAutoRecovery()

  return {
    timestamp: new Date().toISOString(),
    checksRun: MONITORED_ENDPOINTS.length,
    failures,
    transitions,
    recovered,
    statuses: getAllStatuses(),
  }
}
