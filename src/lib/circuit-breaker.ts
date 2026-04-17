/**
 * Automated circuit breaker — P46.
 *
 * Detects mass source disablement and triggers a systemic P0 alert.
 * Two trigger conditions:
 *   1. Majority disabled: ≥6 of total sources currently disabled.
 *   2. Rapid cascade:    ≥4 sources disabled within a 10-minute window.
 *
 * Alert-only mechanism — does NOT automatically pause routing or alter
 * individual source states. Automatic swap halt is documented as a
 * future enhancement requiring manual override design.
 *
 * Cooldown: after triggering, suppresses re-trigger for 15 minutes
 * (prevents alert storm during prolonged outage). Cooldown tracked in KV.
 *
 * @internal — server-only module. Called by runMonitoringTick() after
 * state transitions are processed.
 */

import { kv } from '@vercel/kv'
import { emitTransitionAlert } from './alert-wrapper'
import type { SourceStatus } from './source-state-machine'

// ── Types ────────────────────────────────────────────────

export interface CircuitBreakerResult {
  triggered: boolean
  disabledCount: number
  totalSources: number
  disabledSources: string[]
  triggerReason?: string
}

export interface CircuitBreakerTrip {
  timestamp: string
  disabledCount: number
  totalSources: number
  sources: string[]
  reason: string
}

// ── Constants ────────────────────────────────────────────

/** ≥6 disabled = majority trip */
const MAJORITY_THRESHOLD = 6
/** ≥4 disabled in cascade window = rapid cascade trip */
const CASCADE_THRESHOLD = 4
/** Cascade detection window: 10 minutes */
const CASCADE_WINDOW_MS = 10 * 60 * 1000
/** Cooldown after trigger: 15 minutes (prevents alert storm) */
const COOLDOWN_MS = 15 * 60 * 1000

/** KV keys */
const LAST_TRIP_KEY = 'teraswap:circuit-breaker:last-trip'
const COOLDOWN_KEY = 'teraswap:circuit-breaker:cooldown'

// ── Core evaluation ──────────────────────────────────────

/**
 * Evaluate whether the circuit breaker should trip based on current
 * aggregate source health. Pure function — no side effects.
 *
 * @param statuses — current SourceStatus array (from getAllStatuses)
 */
export function evaluateCircuitBreaker(
  statuses: SourceStatus[],
): CircuitBreakerResult {
  const totalSources = statuses.length
  const disabledSources = statuses.filter(s => s.state === 'disabled')
  const disabledCount = disabledSources.length
  const disabledIds = disabledSources.map(s => s.id)

  // ── Condition 1: Majority disabled (≥6 of total, >50%) ──
  if (disabledCount >= MAJORITY_THRESHOLD) {
    return {
      triggered: true,
      disabledCount,
      totalSources,
      disabledSources: disabledIds,
      triggerReason: `${disabledCount}/${totalSources} sources disabled (majority threshold: ${MAJORITY_THRESHOLD})`,
    }
  }

  // ── Condition 2: Rapid cascade (≥4 disabled within window) ──
  const now = Date.now()
  const windowStart = now - CASCADE_WINDOW_MS
  const recentlyDisabled = disabledSources.filter(
    s => s.disabledAt != null && s.disabledAt >= windowStart,
  )

  if (recentlyDisabled.length >= CASCADE_THRESHOLD) {
    return {
      triggered: true,
      disabledCount,
      totalSources,
      disabledSources: disabledIds,
      triggerReason: `${recentlyDisabled.length} sources disabled within ${CASCADE_WINDOW_MS / 60_000}min (cascade threshold: ${CASCADE_THRESHOLD})`,
    }
  }

  // ── No trigger ──
  return {
    triggered: false,
    disabledCount,
    totalSources,
    disabledSources: disabledIds,
  }
}

// ── Cooldown check ───────────────────────────────────────

/**
 * Check if the circuit breaker is in cooldown (recently triggered).
 * Returns true if still in cooldown → should NOT re-trigger.
 */
export async function isInCooldown(): Promise<boolean> {
  try {
    const lastTripMs = await kv.get<number>(COOLDOWN_KEY)
    if (!lastTripMs) return false
    return Date.now() - lastTripMs < COOLDOWN_MS
  } catch (err) {
    // KV failure → fail-open (allow trigger to ensure systemic alerts are not missed)
    console.warn('[CIRCUIT-BREAKER] Cooldown check KV read failed, allowing trigger:', err instanceof Error ? err.message : err)
    return false
  }
}

// ── Trip handler ─────────────────────────────────────────

/**
 * Execute the circuit breaker trip: write audit trail, set cooldown,
 * and emit a systemic P0 alert.
 */
export async function executeTrip(result: CircuitBreakerResult): Promise<void> {
  if (!result.triggered || !result.triggerReason) return

  const trip: CircuitBreakerTrip = {
    timestamp: new Date().toISOString(),
    disabledCount: result.disabledCount,
    totalSources: result.totalSources,
    sources: result.disabledSources,
    reason: result.triggerReason,
  }

  // Write audit trail + cooldown in parallel
  await Promise.allSettled([
    writeAuditTrail(trip),
    setCooldown(),
  ])

  // Emit systemic P0 alert via full fan-out
  // Use synthetic sourceId 'circuit-breaker' and reason prefix that matches P0 detection
  const alertReason = `circuit-breaker-tripped: ${result.disabledCount}/${result.totalSources} sources disabled [${result.disabledSources.join(', ')}] — ${result.triggerReason}`

  try {
    await emitTransitionAlert(
      'circuit-breaker',
      'active',
      'disabled',
      alertReason,
    )
  } catch (err) {
    console.error('[CIRCUIT-BREAKER] Alert emission failed:', err instanceof Error ? err.message : err)
  }
}

// ── Convenience: evaluate + trip if needed ───────────────

/**
 * Run the full circuit breaker check: evaluate, check cooldown,
 * and execute trip if triggered. Returns the evaluation result.
 *
 * Called by runMonitoringTick() after state transitions are processed.
 */
export async function checkCircuitBreaker(
  statuses: SourceStatus[],
): Promise<CircuitBreakerResult> {
  const result = evaluateCircuitBreaker(statuses)

  if (!result.triggered) return result

  // Check cooldown before triggering
  if (await isInCooldown()) {
    console.log(`[CIRCUIT-BREAKER] Would trigger (${result.triggerReason}) but in cooldown — suppressed`)
    return { ...result, triggered: false, triggerReason: `${result.triggerReason} (suppressed: cooldown)` }
  }

  console.error(`[CIRCUIT-BREAKER] TRIGGERED: ${result.triggerReason}`)
  await executeTrip(result)

  return result
}

// ── KV helpers ───────────────────────────────────────────

async function writeAuditTrail(trip: CircuitBreakerTrip): Promise<void> {
  try {
    // Keep for 30 days
    await kv.set(LAST_TRIP_KEY, trip, { ex: 30 * 24 * 60 * 60 })
  } catch (err) {
    console.warn('[CIRCUIT-BREAKER] Audit trail write failed:', err instanceof Error ? err.message : err)
  }
}

async function setCooldown(): Promise<void> {
  try {
    // TTL = cooldown period + buffer
    await kv.set(COOLDOWN_KEY, Date.now(), { ex: Math.ceil(COOLDOWN_MS / 1000) + 60 })
  } catch (err) {
    console.warn('[CIRCUIT-BREAKER] Cooldown set failed:', err instanceof Error ? err.message : err)
  }
}

// ── Read last trip (for debugging/admin) ─────────────────

export async function getLastTrip(): Promise<CircuitBreakerTrip | null> {
  try {
    return await kv.get<CircuitBreakerTrip>(LAST_TRIP_KEY)
  } catch {
    return null
  }
}

// ── Exported constants (for tests) ───────────────────────

export const _constants = {
  MAJORITY_THRESHOLD,
  CASCADE_THRESHOLD,
  CASCADE_WINDOW_MS,
  COOLDOWN_MS,
  LAST_TRIP_KEY,
  COOLDOWN_KEY,
} as const
