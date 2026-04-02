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

import { kv } from '@vercel/kv'

export const SWAP_RATE_LIMIT = { limit: 20, windowMs: 60_000 }
export const QUOTE_RATE_LIMIT = { limit: 30, windowMs: 60_000 }
export const RPC_RATE_LIMIT = { limit: 60, windowMs: 60_000 }

interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

/**
 * Check rate limit using Redis sorted sets (sliding window).
 *
 * @param key   — Unique key, e.g. "swap:192.168.1.1"
 * @param limit — Max requests per window
 * @param windowMs — Window size in milliseconds
 * @returns { allowed, remaining, resetAt }
 *
 * Fail-open: returns { allowed: true, remaining: -1, resetAt: 0 } if KV is unavailable.
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
    // @vercel/kv uses HTTP-based Redis (Upstash) which doesn't support
    // traditional multi/exec. We use pipeline() for batching.
    const pipeline = kv.pipeline()
    pipeline.zremrangebyscore(redisKey, 0, windowStart)
    pipeline.zcard(redisKey)
    // Add member with score=now, member=now:random to prevent collisions
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`
    pipeline.zadd(redisKey, { score: now, member })
    pipeline.expire(redisKey, Math.ceil(windowMs / 1000))

    const results = await pipeline.exec()

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
    console.warn('[RATE-LIMIT] KV unavailable, allowing request:', message)
    return { allowed: true, remaining: -1, resetAt: 0 }
  }
}
