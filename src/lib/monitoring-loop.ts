/**
 * Monitoring loop — runs health checks on all endpoints and
 * feeds results into the source state machine.
 *
 * Designed for Vercel Cron: each call to runMonitoringTick()
 * performs one full round of checks. The cron job calls this
 * every 60s via /api/monitor/tick.
 *
 * Alerts are emitted exclusively through emitTransitionAlert()
 * in the alert-wrapper (fans out to Telegram/Email/Discord with
 * dedup, grace period, and HTML escaping). No direct Telegram
 * sends from this module — see I-02 audit finding.
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
} from './source-state-machine'
import {
  loadBaseline,
  validateTLS,
  validateDNS,
  captureLiveTLS,
  captureLiveDNS,
} from './fingerprint-validator'
import {
  shouldRunQuorum,
  runQuorumCheck,
  type QuorumCheckResult,
} from './quorum-check'

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
  /** Present only on quorum ticks (every 5th tick). */
  quorum?: QuorumCheckResult
}

/**
 * Run one full monitoring tick.
 * Returns a summary of the results for the API response.
 */
export async function runMonitoringTick(): Promise<MonitoringTickResult> {
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

  // ── H5: Quorum cross-check (every 5th tick) ──────────
  let quorumResult: QuorumCheckResult | undefined
  try {
    if (await shouldRunQuorum()) {
      quorumResult = await runQuorumCheck()
      if (quorumResult.correlatedOutlierCount >= 3) {
        console.error(`[MONITOR] H5 correlated anomaly — ${quorumResult.correlatedOutlierCount} sources flagged`)
      }
    }
  } catch (err) {
    console.warn('[MONITOR] Quorum check failed:', err instanceof Error ? err.message : err)
  }

  // Detect state transitions (after H1 + H2 + H5 may have changed states)
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
    ...(quorumResult ? { quorum: quorumResult } : {}),
  }
}
