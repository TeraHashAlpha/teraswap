// [CB-01] Circuit breaker per DEX adapter — prevents hammering failed APIs
// States: CLOSED (normal) → OPEN (blocking) → HALF_OPEN (testing) → CLOSED
//
// Separate from source-monitor.ts (telemetry/UI) — this is active flow control.
// In-memory state: resets on Vercel cold start, rebuilds in ~3 failures (~90s).

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
}

// ── Wrapper ─────────────────────────────────────────────────

/**
 * Wrap an adapter call with circuit breaker protection.
 * If circuit is OPEN, rejects immediately without calling the adapter.
 * Records success/failure to transition states.
 */
export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  config?: Partial<CircuitBreakerConfig>,
): Promise<T> {
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
