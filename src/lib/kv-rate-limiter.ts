// [B-06] Persistent rate limiter via Vercel KV (Redis)
// Survives serverless cold starts. Fail-open if Redis unavailable.
// NOTE: This replaces the per-route in-memory Maps for API protection.
// The existing src/lib/rate-limiter.ts is for outbound API throttling — do NOT touch it.
//
// Uses sorted sets for sliding window rate limiting:
// - Each request adds a member with timestamp as score
// - Old entries (outside window) are pruned on each check
// - ZCARD gives the current count within the window
//
// Why sorted sets instead of INCR+TTL?
// INCR with TTL gives a fixed window (resets at TTL boundary), allowing
// burst of 2x the limit at the boundary edge. Sorted sets give a true
// sliding window — every request is evaluated against the last N seconds,
// providing consistent rate enforcement regardless of when in the window
// the requests arrive.
//
// [H-01] In-memory fallback when KV is unavailable. INC-2026-04-14-002
// showed KV can fail silently for 13 days — fail-open left all endpoints
// unprotected for that entire window. The fallback enforces 50% of the
// normal limits per-instance (resets on cold start — acceptable for a
// degraded mode).

import { kv } from '@/lib/kv'

export const SWAP_RATE_LIMIT = { limit: 20, windowMs: 60_000 }
export const QUOTE_RATE_LIMIT = { limit: 30, windowMs: 60_000 }
export const RPC_RATE_LIMIT = { limit: 60, windowMs: 60_000 }

interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

// ── [H-01] In-memory fallback state ─────────────────────
// Resets on cold start (per-Lambda-instance) — acceptable for a degraded
// mode. Normal operation goes through KV; this map is only touched on
// the catch path.

interface FallbackEntry {
  count: number
  windowStart: number
}

const fallbackMap = new Map<string, FallbackEntry>()

/** True once we have logged the KV outage at error level; resets on KV recovery. */
let kvFailureAlerted = false

/** Rolling counter to gate periodic cleanup of the fallback map. */
let checkCounter = 0
const CLEANUP_INTERVAL = 100

/** Prune entries whose window ended more than `windowMs` ago (so any still-relevant window is preserved). */
function cleanupFallbackMap(windowMs: number): void {
  const cutoff = Date.now() - 2 * windowMs
  for (const [key, entry] of fallbackMap) {
    if (entry.windowStart < cutoff) {
      fallbackMap.delete(key)
    }
  }
}

/**
 * In-memory fallback rate limiter — invoked from the KV catch block.
 * Enforces ceil(limit / 2) per (key, window) using process-local state.
 */
function fallbackRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const fallbackLimit = Math.ceil(limit / 2)
  const now = Date.now()
  const existing = fallbackMap.get(key)
  const entry: FallbackEntry = existing ?? { count: 0, windowStart: now }

  // Reset window if expired
  if (now - entry.windowStart > windowMs) {
    entry.count = 0
    entry.windowStart = now
  }

  entry.count++
  fallbackMap.set(key, entry)

  // Periodic cleanup to prevent unbounded growth across many keys
  checkCounter++
  if (checkCounter % CLEANUP_INTERVAL === 0) {
    cleanupFallbackMap(windowMs)
  }

  if (entry.count > fallbackLimit) {
    console.warn(`[RATE-LIMIT] KV unavailable, in-memory fallback BLOCKED request for ${key}`)
    return { allowed: false, remaining: 0, resetAt: entry.windowStart + windowMs }
  }

  console.warn(`[RATE-LIMIT] KV unavailable, using in-memory fallback for ${key}: ${entry.count}/${fallbackLimit}`)
  return {
    allowed: true,
    remaining: fallbackLimit - entry.count,
    resetAt: entry.windowStart + windowMs,
  }
}

/**
 * Check rate limit using Redis sorted sets (sliding window).
 *
 * @param key   — Unique key, e.g. "swap:192.168.1.1"
 * @param limit — Max requests per window
 * @param windowMs — Window size in milliseconds
 * @returns { allowed, remaining, resetAt }
 *
 * On KV failure: falls back to an in-memory limiter enforcing 50% of the
 * normal quota per Lambda instance. First failure per outage is logged
 * at error level; recovery is logged at info level.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  try {
    const redisKey = `ratelimit:${key}`
    const now = Date.now()
    const windowStart = now - windowMs

    // Pipeline: prune old entries → count → add new entry → set TTL
    // @upstash/redis uses HTTP-based Redis (Upstash) which doesn't support
    // traditional multi/exec. We use pipeline() for batching.
    const pipeline = kv.pipeline()
    pipeline.zremrangebyscore(redisKey, 0, windowStart)
    pipeline.zcard(redisKey)
    // Add member with score=now, member=now:random to prevent collisions
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`
    pipeline.zadd(redisKey, { score: now, member })
    pipeline.expire(redisKey, Math.ceil(windowMs / 1000))

    const results = await pipeline.exec()

    // KV call succeeded — clear the fallback flag if we were previously failing
    if (kvFailureAlerted) {
      console.log('[RATE-LIMIT] KV recovered — resumed sorted-set rate limiting.')
      kvFailureAlerted = false
    }

    // results[0] = ZREMRANGEBYSCORE result (number removed)
    // results[1] = ZCARD result (count BEFORE our ZADD — entries in window)
    // results[2] = ZADD result
    // results[3] = EXPIRE result
    const countBeforeAdd = (results[1] as number) ?? 0

    if (countBeforeAdd >= limit) {
      // Over limit — remove the entry we just added
      await kv.zrem(redisKey, member).catch(() => {})
      // Find the oldest entry in the window to calculate resetAt
      const oldest = await kv.zrange(redisKey, 0, 0, { withScores: true }).catch(() => [])
      const oldestScore = oldest.length >= 2 ? (oldest[1] as number) : now
      return {
        allowed: false,
        remaining: 0,
        resetAt: oldestScore + windowMs,
      }
    }

    return {
      allowed: true,
      remaining: limit - countBeforeAdd - 1,
      resetAt: now + windowMs,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // First failure per outage: log at error level so alerting picks it up
    if (!kvFailureAlerted) {
      console.error(
        `[RATE-LIMIT] KV UNAVAILABLE — switched to in-memory fallback. Rate limits reduced to 50%. error=${message}`,
      )
      kvFailureAlerted = true
    }

    return fallbackRateLimit(key, limit, windowMs)
  }
}

// ── Test-only exports ───────────────────────────────────

/** Reset module state for tests. Do NOT call from production code. */
export const _internal = {
  getFallbackMap: () => fallbackMap,
  isKvFailureAlerted: () => kvFailureAlerted,
  reset: () => {
    fallbackMap.clear()
    kvFailureAlerted = false
    checkCounter = 0
  },
  CLEANUP_INTERVAL,
}
