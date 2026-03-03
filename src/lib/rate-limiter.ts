/**
 * Rate Limiter — sliding-window per-key throttle for API calls.
 *
 * Usage:
 *   const limiter = createRateLimiter({ maxRequests: 5, windowMs: 10_000 })
 *   if (!limiter.allow('1inch')) throw new Error('Rate limited')
 */

interface RateLimiterConfig {
  /** Maximum requests per window */
  maxRequests: number
  /** Sliding window duration in milliseconds */
  windowMs: number
}

interface RateLimiter {
  /** Check if a request is allowed for the given key. Returns true if allowed. */
  allow: (key: string) => boolean
  /** Get remaining requests for a key */
  remaining: (key: string) => number
  /** Reset all counters */
  reset: () => void
}

export function createRateLimiter({ maxRequests, windowMs }: RateLimiterConfig): RateLimiter {
  const windows = new Map<string, number[]>()

  function pruneKey(key: string) {
    const now = Date.now()
    const timestamps = windows.get(key)
    if (!timestamps) return
    // Remove timestamps outside the window
    const cutoff = now - windowMs
    const pruned = timestamps.filter(t => t > cutoff)
    if (pruned.length === 0) {
      windows.delete(key)
    } else {
      windows.set(key, pruned)
    }
  }

  function allow(key: string): boolean {
    pruneKey(key)
    const timestamps = windows.get(key) ?? []
    if (timestamps.length >= maxRequests) return false
    timestamps.push(Date.now())
    windows.set(key, timestamps)
    return true
  }

  function remaining(key: string): number {
    pruneKey(key)
    const timestamps = windows.get(key) ?? []
    return Math.max(0, maxRequests - timestamps.length)
  }

  function reset() {
    windows.clear()
  }

  return { allow, remaining, reset }
}

// ── Pre-configured limiters for TeraSwap ─────────────────

/** Per-aggregator: max 3 quote requests per 10 seconds */
export const quoteLimiter = createRateLimiter({ maxRequests: 3, windowMs: 10_000 })

/** Global API: max 30 requests per minute */
export const globalLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 })

/** Price feed: max 10 requests per 30 seconds */
export const priceLimiter = createRateLimiter({ maxRequests: 10, windowMs: 30_000 })
