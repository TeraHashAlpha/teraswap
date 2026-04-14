/**
 * Source availability state machine.
 *
 * Tracks health of each aggregator/endpoint with 3 states:
 *   active → degraded → disabled → (manual or auto recovery) → active
 *
 * State transitions:
 *   active → degraded:   3 consecutive failures OR p95 > 5000ms (last 10 checks)
 *   degraded → disabled: 2 more consecutive failures (total 5) OR forceDisable()
 *   degraded → active:   3 consecutive successes AND p95 < 2000ms
 *   disabled → active:   forceActivate() OR auto after 10min (non-critical only)
 *
 * In-memory for MVP — structured for future Supabase persistence.
 */

// ── Types ───────────────────────────────────────────────

export type SourceState = 'active' | 'degraded' | 'disabled'

export interface SourceStatus {
  id: string
  state: SourceState
  lastCheckAt: number        // Unix ms
  failureCount: number       // consecutive failures
  successCount: number       // consecutive successes (resets on failure)
  latencyHistory: number[]   // last 10 latency values in ms
  disabledReason?: string
  disabledAt?: number        // Unix ms when disabled
  lastTransitionAt: number   // Unix ms of last state change
}

export interface HealthCheckResult {
  ok: boolean
  latencyMs: number
  error?: string
}

// ── Critical reasons that block auto-recovery ───────────

const P0_REASONS = new Set([
  'tls-fingerprint-change',
  'dns-record-change',
  'kill-switch-triggered',
])

// ── Thresholds ──────────────────────────────────────────

const FAILURE_TO_DEGRADED = 3         // consecutive failures → degraded
const FAILURE_TO_DISABLED = 5         // consecutive failures → disabled (from active)
const SUCCESS_TO_ACTIVE = 3           // consecutive successes → active (from degraded)
const P95_DEGRADED_THRESHOLD = 5000   // ms
const P95_RECOVERY_THRESHOLD = 2000   // ms
const AUTO_RECOVERY_MS = 10 * 60_000  // 10 minutes
const MAX_LATENCY_HISTORY = 10

// ── State store ─────────────────────────────────────────
// Single boundary for future persistence upgrade

const store = new Map<string, SourceStatus>()

function getOrCreate(id: string): SourceStatus {
  let status = store.get(id)
  if (!status) {
    status = {
      id,
      state: 'active',
      lastCheckAt: 0,
      failureCount: 0,
      successCount: 0,
      latencyHistory: [],
      lastTransitionAt: Date.now(),
    }
    store.set(id, status)
  }
  return status
}

function calcP95(history: number[]): number {
  if (history.length === 0) return 0
  const sorted = [...history].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]
}

// ── State transition logic ──────────────────────────────

type TransitionCallback = (id: string, from: SourceState, to: SourceState, reason: string) => void
let onTransition: TransitionCallback | null = null

export function setTransitionCallback(cb: TransitionCallback): void {
  onTransition = cb
}

function transition(status: SourceStatus, newState: SourceState, reason: string): void {
  const from = status.state
  if (from === newState) return
  status.state = newState
  status.lastTransitionAt = Date.now()
  console.log(`[STATE] ${status.id}: ${from} → ${newState} (${reason})`)
  if (onTransition) onTransition(status.id, from, newState, reason)
}

// ── Public API ──────────────────────────────────────────

export function getStatus(sourceId: string): SourceStatus {
  return getOrCreate(sourceId)
}

export function getAllStatuses(): SourceStatus[] {
  return Array.from(store.values())
}

export function recordHealthCheck(sourceId: string, result: HealthCheckResult): void {
  const s = getOrCreate(sourceId)
  s.lastCheckAt = Date.now()

  // Update latency history
  s.latencyHistory.push(result.latencyMs)
  if (s.latencyHistory.length > MAX_LATENCY_HISTORY) {
    s.latencyHistory = s.latencyHistory.slice(-MAX_LATENCY_HISTORY)
  }

  if (result.ok) {
    s.successCount++
    s.failureCount = 0

    // Recovery: degraded → active
    if (s.state === 'degraded') {
      const p95 = calcP95(s.latencyHistory)
      if (s.successCount >= SUCCESS_TO_ACTIVE && p95 < P95_RECOVERY_THRESHOLD) {
        transition(s, 'active', `${SUCCESS_TO_ACTIVE} consecutive successes, p95=${Math.round(p95)}ms`)
      }
    }
  } else {
    s.failureCount++
    s.successCount = 0

    // Degradation: active → degraded
    if (s.state === 'active') {
      const p95 = calcP95(s.latencyHistory)
      if (s.failureCount >= FAILURE_TO_DEGRADED) {
        transition(s, 'degraded', `${s.failureCount} consecutive failures`)
      } else if (s.latencyHistory.length >= 5 && p95 > P95_DEGRADED_THRESHOLD) {
        transition(s, 'degraded', `p95=${Math.round(p95)}ms exceeds ${P95_DEGRADED_THRESHOLD}ms`)
      }
    }

    // Disabled: degraded → disabled (2 more failures after degraded = 5 total)
    if (s.state === 'degraded' && s.failureCount >= FAILURE_TO_DISABLED) {
      transition(s, 'disabled', `${s.failureCount} consecutive failures`)
      s.disabledAt = Date.now()
      s.disabledReason = result.error || 'health-check-failures'
    }
  }
}

export function forceDisable(sourceId: string, reason: string): void {
  const s = getOrCreate(sourceId)
  s.disabledReason = reason
  s.disabledAt = Date.now()
  transition(s, 'disabled', `force: ${reason}`)
}

export function forceActivate(sourceId: string): void {
  const s = getOrCreate(sourceId)
  s.failureCount = 0
  s.successCount = 0
  s.disabledReason = undefined
  s.disabledAt = undefined
  transition(s, 'active', 'force activated')
}

/**
 * Check for auto-recovery of non-critical disabled sources.
 * Called periodically by the monitoring loop.
 */
export function checkAutoRecovery(): string[] {
  const recovered: string[] = []
  const now = Date.now()

  for (const s of store.values()) {
    if (s.state !== 'disabled' || !s.disabledAt) continue
    // P0 reasons block auto-recovery
    if (s.disabledReason && P0_REASONS.has(s.disabledReason)) continue
    // Auto-recover after 10min
    if (now - s.disabledAt >= AUTO_RECOVERY_MS) {
      s.failureCount = 0
      s.successCount = 0
      s.disabledReason = undefined
      s.disabledAt = undefined
      transition(s, 'active', `auto-recovery after ${AUTO_RECOVERY_MS / 60_000}min`)
      recovered.push(s.id)
    }
  }

  return recovered
}

/** Reset all state (for testing) */
export function resetAllStates(): void {
  store.clear()
}
