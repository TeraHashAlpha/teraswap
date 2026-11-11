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
import { forLog } from '@/lib/log-sanitize'

export const SWAP_RATE_LIMIT = { limit: 20, windowMs: 60_000 }
export const QUOTE_RATE_LIMIT = { limit: 30, windowMs: 60_000 }
// RPC proxy is read-only (the blacklist in src/app/api/rpc/route.ts blocks
// every write/sign method). Injected wallet extensions (MetaMask, Rainbow,
// ...) poll through this endpoint for block headers, balances, gas, and
// token prices — typically 30–50 req/min on top of our own app traffic
// (~10–20 req/min) and simulation eth_calls. 60/min starved legitimate
// calls almost immediately; 300/min leaves headroom while still blunting
// abuse. The fallback (degraded mode) is ceil(300/2) = 150/min.
export const RPC_RATE_LIMIT = { limit: 300, windowMs: 60_000 }
// [AUDIT-W6 / W6-M-02] Unauthenticated ingestion + order creation.
// The four log-* telemetry routes share ONE per-IP budget (key `log:<ip>`) —
// 120/min covers a busy real session across all of them while bounding
// spam / analytics-poisoning / Supabase-cost floods; degraded fallback 60/min.
export const LOG_RATE_LIMIT = { limit: 120, windowMs: 60_000 }
// Every order creation needs a fresh wallet signature, so 10/min/IP is
// generous for humans while stopping self-signed spam loops (fallback 5/min).
// Complements (does not replace) the per-wallet DB limit in the orders route.
export const ORDER_CREATE_RATE_LIMIT = { limit: 10, windowMs: 60_000 }

// [fix/user-ip-privacy A76 S-1] /api/cow/* — the browser's CoW Protocol calls, relayed so CoW never sees the
// visitor's IP (cow-proxy.ts). One bucket per route, key `cow-<route>:<ip hash>`:
//  - quote 30/min: the limit-order price read (once per pair change, then once per active order card every
//    30 s) — the same ceiling as /api/quote.
//  - orders 10/min: every submit or cancel carries a fresh wallet signature — the same as ORDER_CREATE_RATE_LIMIT.
//  - order-status 60/min: a CoW swap polls every 3 s (20/min) for up to 2 min, so three concurrent swaps fit.
//  - trades 30/min: read once per filled order.
// Degraded (KV down or slow) is half of each, per instance — checkRateLimitWithin.
export const COW_PROXY_RATE_LIMITS = {
  quote: { limit: 30, windowMs: 60_000 },
  orders: { limit: 10, windowMs: 60_000 },
  'order-status': { limit: 60, windowMs: 60_000 },
  trades: { limit: 30, windowMs: 60_000 },
} as const

// [fix/zerox-quote-hygiene T3] Per-identity ceiling on 0x FIRM /quote builds
// (adapters/zerox.ts fetchSwapData, invoked from api.ts's fetchSwapFromSource
// — the swap-BUILD step, gated on a Swap click / an authenticated /v1/swap
// POST). Distinct from QUOTE_RATE_LIMIT above, which bounds the /price
// meta-fan-out (every source, every poll tick) — this is 0x-specific and
// exists solely to keep our 0x key under 0x's own throttling threshold
// (0x's 2026-09-12 warning), never to protect our own infra.
//
// Sizing: a real user builds a 0x quote once per deliberate Swap click on a
// 0x-routed pair, occasionally a couple more times (adjusting slippage,
// retrying after a wallet rejection). SPLIT_MAX_LEGS (split-router.ts) is 3,
// but 0x occupies at most ONE leg per split swap (each leg is a distinct
// source), so a split swap never multiplies this count. 8/min and 40/hour
// give a single active user roughly 5-8x headroom over that real pattern
// while bounding a script that hammers /api/swap with source=0x and never
// confirms — exactly the pattern 0x flagged.
export const ZEROX_QUOTE_BUILD_MINUTE_LIMIT = { limit: 8, windowMs: 60_000 }
export const ZEROX_QUOTE_BUILD_HOUR_LIMIT = { limit: 40, windowMs: 3_600_000 }

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
/** When checkRateLimitWithin last logged a KV timeout (at most one line a minute per instance). */
let kvTimeoutLoggedAt = 0

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
  cost: number,
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

  entry.count += cost
  fallbackMap.set(key, entry)

  // Periodic cleanup to prevent unbounded growth across many keys
  checkCounter++
  if (checkCounter % CLEANUP_INTERVAL === 0) {
    cleanupFallbackMap(windowMs)
  }

  if (entry.count > fallbackLimit) {
    console.warn(`[RATE-LIMIT] KV unavailable, in-memory fallback BLOCKED request for ${forLog(key)}`)
    return { allowed: false, remaining: 0, resetAt: entry.windowStart + windowMs }
  }

  console.warn(`[RATE-LIMIT] KV unavailable, using in-memory fallback for ${forLog(key)}: ${entry.count}/${fallbackLimit}`)
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
 * @param cost  — Units this call consumes (default 1; [FEAT-SERVER-RPC-ENV-SPLIT] /api/rpc charges
 *                one unit per JSON-RPC call in a batch). Allowed iff count + cost <= limit; cost 1
 *                is exactly the old `count < limit`.
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
  cost: number = 1,
  /** @internal checkRateLimitWithin: true once the caller stopped waiting and already charged the fallback. */
  abandoned?: () => boolean,
): Promise<RateLimitResult> {
  const units = Number.isFinite(cost) && cost >= 1 ? Math.floor(cost) : 1
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
    // Add `units` members with score=now, member=now:random to prevent collisions
    const members = Array.from({ length: units }, () => `${now}:${Math.random().toString(36).slice(2, 8)}`)
    const [first, ...rest] = members.map((m) => ({ score: now, member: m }))
    pipeline.zadd(redisKey, first, ...rest)
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

    if (countBeforeAdd + units > limit) {
      // Over limit — remove the entries we just added
      await kv.zrem(redisKey, ...members).catch(() => {})
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
      remaining: limit - countBeforeAdd - units,
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

    // The caller gave up waiting (checkRateLimitWithin) and already charged this request to the
    // fallback; charging it again here would halve the degraded limit a second time.
    if (abandoned?.()) return { allowed: true, remaining: 0, resetAt: Date.now() + windowMs }
    return fallbackRateLimit(key, limit, windowMs, units)
  }
}

/**
 * [fix/user-ip-privacy A76 S-5] How long a request waits on the limiter before it takes the degraded path.
 * Same idea as /api/quote's KV gate (withTimeout around checkRateLimit), shorter: the RPC and CoW proxies sit on
 * the read path of every page, and with Redis unreachable the Upstash client retries a pipeline for ~4.3 s
 * (measured by the A76 audit) before checkRateLimit's catch path runs — added to EVERY proxied call.
 */
export const RATE_LIMIT_GATE_TIMEOUT_MS = 1_000

/**
 * {@link checkRateLimit} with a deadline. When the KV call has not answered within `timeoutMs`, the request is
 * decided by the SAME in-memory fallback the catch path uses (50% of the limit, per instance) — so a hung Redis
 * costs at most `timeoutMs`, and the endpoint is degraded, never unlimited. The KV call is left to finish in the
 * background; if it then fails it does not charge the fallback a second time.
 */
export async function checkRateLimitWithin(
  key: string,
  limit: number,
  windowMs: number,
  cost: number = 1,
  timeoutMs: number = RATE_LIMIT_GATE_TIMEOUT_MS,
): Promise<RateLimitResult> {
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    const result = await Promise.race([checkRateLimit(key, limit, windowMs, cost, () => timedOut), deadline])
    if (result !== null) return result
  } finally {
    clearTimeout(timer)
  }
  timedOut = true
  if (Date.now() - kvTimeoutLoggedAt > 60_000) {
    console.error(`[RATE-LIMIT] KV did not answer within ${timeoutMs} ms — deciding by the in-memory fallback (50%).`)
    kvTimeoutLoggedAt = Date.now()
  }
  const units = Number.isFinite(cost) && cost >= 1 ? Math.floor(cost) : 1
  return fallbackRateLimit(key, limit, windowMs, units)
}

// ── Test-only exports ───────────────────────────────────

/** Reset module state for tests. Do NOT call from production code. */
export const _internal = {
  getFallbackMap: () => fallbackMap,
  isKvFailureAlerted: () => kvFailureAlerted,
  reset: () => {
    fallbackMap.clear()
    kvFailureAlerted = false
    kvTimeoutLoggedAt = 0
    checkCounter = 0
  },
  CLEANUP_INTERVAL,
}
