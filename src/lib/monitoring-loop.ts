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
import {
  checkCircuitBreaker,
  type CircuitBreakerResult,
} from './circuit-breaker'
import {
  shouldRunOnChainScan,
  runOnChainScan,
  type OnChainScanResult,
} from './on-chain-monitor'

// ── Heartbeat keys ──────────────────────────────────────

const HEARTBEAT_KEY = 'teraswap:monitor:lastTick'
const TICK_COUNT_KEY = 'teraswap:monitor:tickCount'
const WARMUP_KEY = 'teraswap:monitor:lastTickWarmup'

/** Gap between ticks that indicates a cold start (Vercel Hobby sleep). */
const WARMUP_GAP_MS = 5 * 60 * 1000 // 5 minutes

// ── Distributed lock ───────────────────────────────────

const LOCK_KEY = 'teraswap:monitor:tick-lock'
/**
 * Lock TTL must be shorter than the 60s tick interval.
 * No explicit unlock — TTL is the sole release mechanism. This prevents
 * deadlocks if the Lambda crashes between acquire and release.
 */
const LOCK_TTL_SECONDS = 55

async function writeHeartbeat(warmup: boolean): Promise<void> {
  try {
    const pipeline = kv.pipeline()
    pipeline.set(HEARTBEAT_KEY, new Date().toISOString(), { ex: 3600 }) // 1h TTL
    pipeline.incr(TICK_COUNT_KEY)
    pipeline.set(WARMUP_KEY, warmup, { ex: 3600 })
    await pipeline.exec()
  } catch (err) {
    console.warn('[MONITOR] Heartbeat write failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Detect cold-start warmup: if the gap since last tick exceeds WARMUP_GAP_MS,
 * the function likely started from a cold state (Vercel Hobby sleep) and
 * all latency measurements in this tick are inflated.
 */
async function detectWarmup(): Promise<boolean> {
  try {
    const lastTickIso = await kv.get<string>(HEARTBEAT_KEY)
    if (!lastTickIso) return true // first tick ever → treat as warmup
    const gap = Date.now() - new Date(lastTickIso).getTime()
    return gap > WARMUP_GAP_MS
  } catch (err) {
    console.warn('[MONITOR] Warmup detection KV read failed, assuming warm:', err instanceof Error ? err.message : err)
    return false // fail-open: assume warm to avoid silently discarding data
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
  /** Circuit breaker evaluation result (present when ≥1 source is disabled). */
  circuitBreaker?: CircuitBreakerResult
  /** On-chain event scan result (present on every 5th tick). */
  onChainScan?: OnChainScanResult
  /** True when tick was flagged as cold-start warmup (latency discarded). */
  warmup?: boolean
  /** True when tick was skipped due to concurrent lock. */
  skipped?: boolean
  /** Reason the tick was skipped (e.g., 'concurrent-tick-lock'). */
  reason?: string
}

/**
 * Run one full monitoring tick.
 * Returns a summary of the results for the API response.
 */
export async function runMonitoringTick(): Promise<MonitoringTickResult> {
  // ── [API-M-03] Distributed lock — prevent concurrent ticks ──
  try {
    const acquired = await kv.set(LOCK_KEY, Date.now().toString(), { nx: true, ex: LOCK_TTL_SECONDS })
    if (!acquired) {
      console.log('[TICK] Skipped — another tick is in progress')
      return {
        timestamp: new Date().toISOString(),
        checksRun: 0,
        failures: 0,
        transitions: [],
        recovered: [],
        statuses: [],
        skipped: true,
        reason: 'concurrent-tick-lock',
      }
    }
  } catch (err) {
    // Fail-open: if KV is unreachable, proceed with the tick.
    // Better to risk a rare duplicate than miss a tick entirely.
    console.warn('[TICK] Lock acquire failed (proceeding):', err instanceof Error ? err.message : err)
  }

  // Invalidate per-tick cache (fresh reads from KV)
  beginTick()

  // ── Warmup detection (gap-based) ──────────────────────
  const warmup = await detectWarmup()
  if (warmup) {
    console.log(`[TICK] Cold start detected — latency measurements discarded`)
  }

  const transitions: string[] = []
  const allBefore = await getAllStatuses()
  const originalStates = new Map(allBefore.map(s => [s.id, s.state]))

  let failures = 0

  // ── H1: Health checks ─────────────────────────────────
  // Warmup ticks still run checks (availability matters) but skip latency recording
  await Promise.allSettled(
    MONITORED_ENDPOINTS.map(async (ep) => {
      const result = await runHealthCheck(ep)
      await recordHealthCheck(ep.id, result, { skipLatency: warmup })
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

  // ── P47: On-chain event scan (every 5th tick) ─────────
  let onChainScanResult: OnChainScanResult | undefined
  try {
    if (await shouldRunOnChainScan()) {
      const result = await runOnChainScan()
      if (result) onChainScanResult = result
    }
  } catch (err) {
    console.warn('[MONITOR] On-chain scan failed:', err instanceof Error ? err.message : err)
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

  // ── P46: Circuit breaker — detect mass source disablement ──
  // Runs after all state transitions (H1/H2/H5/auto-recovery) are complete.
  let circuitBreakerResult: CircuitBreakerResult | undefined
  try {
    // Re-read statuses after auto-recovery may have changed states
    const finalStatuses = await getAllStatuses()
    circuitBreakerResult = await checkCircuitBreaker(finalStatuses)
  } catch (err) {
    console.error('[MONITOR] Circuit breaker check failed:', err instanceof Error ? err.message : err)
  }

  // Write heartbeat to KV (dead-man's-switch)
  await writeHeartbeat(warmup)

  return {
    timestamp: new Date().toISOString(),
    checksRun: MONITORED_ENDPOINTS.length,
    failures,
    transitions,
    recovered,
    statuses: allAfter,
    ...(quorumResult ? { quorum: quorumResult } : {}),
    ...(circuitBreakerResult ? { circuitBreaker: circuitBreakerResult } : {}),
    ...(onChainScanResult ? { onChainScan: onChainScanResult } : {}),
    ...(warmup ? { warmup: true } : {}),
  }
}
