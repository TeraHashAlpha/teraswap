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
  /** Total quote attempts (success + failure + no-route) */
  totalRequests: number
  /** Successful quote returns */
  successes: number
  /** Failures (timeout, error, zero/unusable amount) */
  failures: number
  /**
   * [SPRINT-9F backlog] No-routes — the adapter resolved `null` (it answered
   * but had no quote for this pair/size). NEITHER a success NOR a failure:
   * excluded from `successRate` and never touches `consecutiveFailures`,
   * mirroring the circuit breaker's NEUTRAL treatment of a resolved null.
   */
  noRoutes: number
  /** Success rate 0..1 over decisive attempts (success / (success+failure)) */
  successRate: number
  /** Average response time (ms) — only for successful calls */
  avgLatencyMs: number
  /** Last seen healthy timestamp */
  lastSuccessAt: number
  /** Last error message */
  lastError: string | null
  /** Consecutive failures (resets on success; a no-route leaves it untouched) */
  consecutiveFailures: number
}

/**
 * [SPRINT-9F backlog] A quote attempt resolves to one of three outcomes —
 * `no_route` is distinct from `failure` so a legitimate absence is never
 * counted (or alerted) as a real failure.
 */
type PingOutcome = 'success' | 'failure' | 'no_route'

interface Ping {
  source: AggregatorName
  outcome: PingOutcome
  latencyMs: number
  error?: string
  timestamp: number
}

// ── Store (in-memory, singleton) ─────────────────────────

const pings: Ping[] = []
const MAX_PINGS = 500 // rolling buffer

function push(ping: Ping) {
  pings.push(ping)
  // Trim old entries
  if (pings.length > MAX_PINGS) {
    pings.splice(0, pings.length - MAX_PINGS)
  }
}

/** Record a quote attempt that succeeded (`success`) or failed (`!success`). */
export function recordSourcePing(
  source: AggregatorName,
  success: boolean,
  latencyMs: number,
  error?: string,
) {
  push({
    source,
    outcome: success ? 'success' : 'failure',
    latencyMs,
    error,
    timestamp: Date.now(),
  })
}

/**
 * [SPRINT-9F backlog] Record a no-route: the adapter resolved `null` (it
 * answered but has no quote for this pair/size). This is NOT a failure — it
 * does not increment failures / consecutiveFailures and is excluded from the
 * success rate. Distinct from a 'Zero output' failure (a present-but-unusable
 * amount), which `recordSourcePing(false, …)` still records.
 */
export function recordSourceNoRoute(source: AggregatorName, latencyMs: number) {
  push({
    source,
    outcome: 'no_route',
    latencyMs,
    timestamp: Date.now(),
  })
}

/** Get aggregated stats per source */
export function getSourceStats(): SourceStats[] {
  const map = new Map<AggregatorName, {
    total: number
    successes: number
    failures: number
    noRoutes: number
    latencies: number[]
    lastSuccess: number
    lastError: string | null
    consecutiveFail: number
  }>()

  for (const p of pings) {
    let entry = map.get(p.source)
    if (!entry) {
      entry = { total: 0, successes: 0, failures: 0, noRoutes: 0, latencies: [], lastSuccess: 0, lastError: null, consecutiveFail: 0 }
      map.set(p.source, entry)
    }
    entry.total++
    if (p.outcome === 'success') {
      entry.successes++
      entry.latencies.push(p.latencyMs)
      entry.lastSuccess = p.timestamp
      entry.consecutiveFail = 0
    } else if (p.outcome === 'failure') {
      entry.failures++
      entry.lastError = p.error ?? null
      entry.consecutiveFail++
    } else {
      // no_route — NEUTRAL: not a success, not a failure. Never resets nor
      // increments the failure streak (mirrors the circuit breaker).
      entry.noRoutes++
    }
  }

  const stats: SourceStats[] = []
  for (const [source, e] of map) {
    const avgLatency = e.latencies.length > 0
      ? e.latencies.reduce((a, b) => a + b, 0) / e.latencies.length
      : 0
    const decisive = e.successes + e.failures
    stats.push({
      source,
      totalRequests: e.total,
      successes: e.successes,
      failures: e.failures,
      noRoutes: e.noRoutes,
      successRate: decisive > 0 ? e.successes / decisive : 0,
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
