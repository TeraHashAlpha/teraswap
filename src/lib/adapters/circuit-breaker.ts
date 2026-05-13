// [CB-01] Circuit breaker per DEX adapter — prevents hammering failed APIs
// States: CLOSED (normal) → OPEN (blocking) → HALF_OPEN (testing) → CLOSED
//
// Separate from source-monitor.ts (telemetry/UI) — this is active flow control.
// In-memory state: resets on Vercel cold start, rebuilds in ~3 failures (~90s).
//
// [P112/M-02] Cold-start pre-seed: on first use, the registry asks the
// source-state-machine for every source's persisted health and force-opens
// any breaker whose KV state is `disabled` or `degraded`. That collapses the
// recovery window from ~90s (3 failures × ~30s) to ~0s for sources already
// known to be unhealthy. KV failures degrade silently to the CLOSED default
// — never blocking the hot path on a KV read.

// ── Types & Config ──────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerConfig {
  /** Consecutive failures before opening circuit */
  failureThreshold: number
  /** Time in ms to wait before testing again (OPEN → HALF_OPEN) */
  cooldownMs: number
  /** Max test requests in HALF_OPEN before deciding */
  halfOpenMaxAttempts: number
}

export const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 60_000,     // 60 seconds
  halfOpenMaxAttempts: 1,
}

// ── CircuitBreaker class ────────────────────────────────────

export class CircuitBreaker {
  readonly name: string
  private state: CircuitState = 'CLOSED'
  private consecutiveFailures = 0
  private lastFailureAt = 0
  private halfOpenAttempts = 0
  private config: CircuitBreakerConfig

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.name = name
    this.config = { ...DEFAULT_CB_CONFIG, ...config }
  }

  /**
   * Check if circuit is OPEN (blocking requests).
   * Side effect: transitions OPEN → HALF_OPEN when cooldown has elapsed.
   */
  isOpen(): boolean {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureAt >= this.config.cooldownMs) {
        this.state = 'HALF_OPEN'
        console.log(`[CB] ${this.name}: OPEN → HALF_OPEN (cooldown elapsed)`)
        return false // Allow test request
      }
      return true // Still blocking
    }
    // HALF_OPEN: allow test requests
    // CLOSED: normal operation
    return false
  }

  /** Record a successful call — may close a HALF_OPEN circuit. */
  onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED'
      console.log(`[CB] ${this.name}: HALF_OPEN → CLOSED (test succeeded)`)
    }
    this.consecutiveFailures = 0
    this.halfOpenAttempts = 0
  }

  /** Record a failed call — may open the circuit. */
  onFailure(): void {
    this.consecutiveFailures++
    this.lastFailureAt = Date.now()

    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++
      if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
        this.state = 'OPEN'
        console.warn(`[CB] ${this.name}: HALF_OPEN → OPEN (test failed)`)
        this.halfOpenAttempts = 0
      }
    } else if (this.state === 'CLOSED') {
      if (this.consecutiveFailures >= this.config.failureThreshold) {
        this.state = 'OPEN'
        console.warn(`[CB] ${this.name}: CLOSED → OPEN (${this.consecutiveFailures} consecutive failures)`)
      }
    }
  }

  /**
   * [P112/M-02] Drive the breaker to OPEN without waiting for the failure
   * threshold. Used by initFromKV() to align the in-memory state with a
   * persistent "this source is unhealthy" signal from KV on cold start.
   *
   * Sets consecutiveFailures to the threshold so the diagnostic info
   * surfaces the right count, and lastFailureAt to now so the normal
   * cooldown timer applies — the next request after cooldownMs probes
   * the upstream again via the HALF_OPEN transition.
   */
  forceOpen(reason: string): void {
    this.state = 'OPEN'
    this.consecutiveFailures = this.config.failureThreshold
    this.lastFailureAt = Date.now()
    console.warn(`[CB] ${this.name}: pre-seeded OPEN from KV (${reason})`)
  }

  /** Current state */
  getState(): CircuitState {
    return this.state
  }

  /** Debugging/metrics info */
  getInfo() {
    const cooldownRemaining = this.state === 'OPEN'
      ? Math.max(0, this.config.cooldownMs - (Date.now() - this.lastFailureAt))
      : 0
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
      cooldownRemaining,
    }
  }
}

// ── Registry ────────────────────────────────────────────────

const breakers = new Map<string, CircuitBreaker>()

/** Get or create circuit breaker for a source */
export function getCircuitBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
  let cb = breakers.get(name)
  if (!cb) {
    cb = new CircuitBreaker(name, config)
    breakers.set(name, cb)
  }
  return cb
}

/** Get all circuit breaker states (for metrics/dashboard) */
export function getAllCircuitStates(): Array<ReturnType<CircuitBreaker['getInfo']>> {
  return Array.from(breakers.values()).map(cb => cb.getInfo())
}

/** Reset all circuit breakers (for testing) */
export function resetAllCircuitBreakers(): void {
  breakers.clear()
  // [P112/M-02] Also clear the lazy-init cache so tests can drive a
  // fresh boot. Without this, the second test in a file would short-
  // circuit on the cached promise from the first.
  initPromise = null
}

// ── [P112/M-02] KV pre-seed ─────────────────────────────────

/**
 * Read every persisted source status from KV and pre-open any breaker
 * whose state is `disabled` or `degraded`. Active sources are left to
 * be created on first use (default CLOSED).
 *
 * Errors are swallowed with a console.warn — the hot path can never
 * block on KV. The result is best-effort accuracy: when KV is healthy
 * we eliminate the 3-failure warm-up; when it isn't, we fall back to
 * the pre-P112 behaviour. Dynamic import of source-state-machine keeps
 * the dependency graph one-way (state machine → breaker is fine; the
 * breaker importing the state machine eagerly would create a cycle
 * via monitoring-loop).
 */
export async function initFromKV(): Promise<void> {
  try {
    const { getAllStatuses } = await import('@/lib/source-state-machine')
    const statuses = await getAllStatuses()
    for (const status of statuses) {
      if (status.state === 'active') continue
      const cb = getCircuitBreaker(status.id)
      cb.forceOpen(`kv state=${status.state}`)
    }
  } catch (err) {
    console.warn(
      '[CB] initFromKV failed; defaulting all breakers to CLOSED:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Cached promise for the cold-start init. Shared across all callers so
 * concurrent requests on a fresh Lambda await the same KV round-trip
 * instead of each firing their own. Reset by resetAllCircuitBreakers()
 * for the test suite.
 */
let initPromise: Promise<void> | null = null

/**
 * Ensure pre-seed init has run at least once. Lazy + idempotent: the
 * first caller drives the KV read; everyone else races to the same
 * resolved promise.
 */
function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = initFromKV()
  }
  return initPromise
}

// ── Wrapper ─────────────────────────────────────────────────

/**
 * Wrap an adapter call with circuit breaker protection.
 * If circuit is OPEN, rejects immediately without calling the adapter.
 * Records success/failure to transition states.
 *
 * [P112/M-02] Awaits the lazy KV pre-seed before the OPEN check so the
 * very first request after a cold start sees the persisted state. The
 * pre-seed is a single KV read shared across all concurrent callers —
 * adds one round-trip to the cold-start path, no overhead on warm.
 */
export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  config?: Partial<CircuitBreakerConfig>,
): Promise<T> {
  await ensureInitialized()
  const cb = getCircuitBreaker(name, config)

  if (cb.isOpen()) {
    throw new Error(`[CB] ${name}: circuit is OPEN — skipping request`)
  }

  try {
    const result = await fn()
    cb.onSuccess()
    return result
  } catch (err) {
    cb.onFailure()
    throw err
  }
}
