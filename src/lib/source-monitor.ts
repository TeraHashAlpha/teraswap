/**
 * Source Monitor — tracks aggregator health, success rates, and latency.
 *
 * Collects per-source metrics on every quote cycle so the system can:
 *  1. Surface degraded sources in the UI (AnalyticsDashboard)
 *  2. Auto-skip chronically failing sources to improve quote speed
 *  3. Provide ops telemetry via console or Supabase
 */

import type { AggregatorName } from '@/lib/constants'

// ── Types ────────────────────────────────────────────────

export interface SourceStats {
  source: AggregatorName
  /** Total quote attempts */
  totalRequests: number
  /** Successful quote returns */
  successes: number
  /** Failures (timeout, error, zero amount) */
  failures: number
  /** Success rate 0..1 */
  successRate: number
  /** Average response time (ms) — only for successful calls */
  avgLatencyMs: number
  /** Last seen healthy timestamp */
  lastSuccessAt: number
  /** Last error message */
  lastError: string | null
  /** Consecutive failures (resets on success) */
  consecutiveFailures: number
}

interface Ping {
  source: AggregatorName
  success: boolean
  latencyMs: number
  error?: string
  timestamp: number
}

// ── Store (in-memory, singleton) ─────────────────────────

const pings: Ping[] = []
const MAX_PINGS = 500 // rolling buffer

/** Record a quote attempt result */
export function recordSourcePing(
  source: AggregatorName,
  success: boolean,
  latencyMs: number,
  error?: string,
) {
  pings.push({
    source,
    success,
    latencyMs,
    error,
    timestamp: Date.now(),
  })

  // Trim old entries
  if (pings.length > MAX_PINGS) {
    pings.splice(0, pings.length - MAX_PINGS)
  }
}

/** Get aggregated stats per source */
export function getSourceStats(): SourceStats[] {
  const map = new Map<AggregatorName, {
    total: number
    successes: number
    failures: number
    latencies: number[]
    lastSuccess: number
    lastError: string | null
    consecutiveFail: number
  }>()

  for (const p of pings) {
    let entry = map.get(p.source)
    if (!entry) {
      entry = { total: 0, successes: 0, failures: 0, latencies: [], lastSuccess: 0, lastError: null, consecutiveFail: 0 }
      map.set(p.source, entry)
    }
    entry.total++
    if (p.success) {
      entry.successes++
      entry.latencies.push(p.latencyMs)
      entry.lastSuccess = p.timestamp
      entry.consecutiveFail = 0
    } else {
      entry.failures++
      entry.lastError = p.error ?? null
      entry.consecutiveFail++
    }
  }

  const stats: SourceStats[] = []
  for (const [source, e] of map) {
    const avgLatency = e.latencies.length > 0
      ? e.latencies.reduce((a, b) => a + b, 0) / e.latencies.length
      : 0
    stats.push({
      source,
      totalRequests: e.total,
      successes: e.successes,
      failures: e.failures,
      successRate: e.total > 0 ? e.successes / e.total : 0,
      avgLatencyMs: Math.round(avgLatency),
      lastSuccessAt: e.lastSuccess,
      lastError: e.lastError,
      consecutiveFailures: e.consecutiveFail,
    })
  }

  return stats.sort((a, b) => b.successRate - a.successRate)
}

/** Check if a source should be temporarily skipped (5+ consecutive failures) */
export function isSourceDegraded(source: AggregatorName): boolean {
  const stats = getSourceStats().find(s => s.source === source)
  if (!stats) return false
  return stats.consecutiveFailures >= 5
}

/** Get list of currently degraded sources */
export function getDegradedSources(): AggregatorName[] {
  return getSourceStats()
    .filter(s => s.consecutiveFailures >= 5)
    .map(s => s.source)
}

/** Reset all monitoring data */
export function resetMonitoring() {
  pings.length = 0
}
