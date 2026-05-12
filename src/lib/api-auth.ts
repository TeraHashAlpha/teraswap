/**
 * [LP-08] Public-API key authentication + rate limiting.
 *
 * Single entry point: `verifyApiKey(req)` returns a typed result that
 * downstream /v1/* route handlers (P79 quote, P80 swap) convert into a
 * NextResponse. The result either grants the request — with the key's
 * tier + rate-limit headers to surface back to the client — or denies
 * it with a 401 / 429 / 503 and an explanatory message.
 *
 * Auth model:
 *   1. Client sends `X-API-Key: tsk_…` header.
 *   2. We SHA-256 the header value and look it up in `api_keys.key_hash`.
 *   3. Reject if missing, inactive, or past `expires_at`.
 *   4. Apply sliding-window rate limits (per-minute + per-day) keyed on
 *      the hash via the existing kv-rate-limiter primitive — same
 *      sorted-set scheme used for IP-based limits, just a different key
 *      namespace (`api:<hash>:min` / `api:<hash>:day`).
 *   5. Fire-and-forget bump `total_requests` + `last_used_at` so the
 *      admin dashboard sees fresh usage without blocking the hot path.
 *
 * Storage:
 *   - Plaintext keys are NEVER persisted (see supabase/api-keys.sql).
 *   - The plaintext exists only on POST /api/admin/api-keys and in the
 *     client's possession from that point on.
 */

import type { NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import { getSupabase } from '@/lib/supabase'
import { checkRateLimit } from '@/lib/kv-rate-limiter'
import { type ApiKeyTier } from '@/lib/constants'

// ── Types ─────────────────────────────────────────────────

export interface ApiKeyRow {
  id: string
  key_hash: string
  name: string
  tier: string
  rate_limit_per_min: number
  rate_limit_per_day: number
  is_active: boolean
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  total_requests: number
}

/** Rate-limit header shape, attached to the NextResponse by the caller. */
export interface RateLimitHeaders {
  /** Header name → value. Always includes the three X-RateLimit-* trio
   *  required by the spec; 429 responses additionally include Retry-After. */
  [key: string]: string
}

export type ApiAuthSuccess = {
  ok: true
  keyId: string
  keyName: string
  tier: ApiKeyTier
  /** Headers the route handler should attach to its success response. */
  rateLimitHeaders: RateLimitHeaders
}

export type ApiAuthFailure = {
  ok: false
  status: 401 | 429 | 503
  error: string
  /** Headers for the failure response (rate-limit headers on 429, etc.). */
  rateLimitHeaders?: RateLimitHeaders
}

export type ApiAuthResult = ApiAuthSuccess | ApiAuthFailure

// ── Constants ─────────────────────────────────────────────

const HEADER_NAME = 'x-api-key'
const HASH_RE = /^[a-f0-9]{64}$/ // sanity check on hex digest output

/** Sliding-window sizes — keep in lockstep with the column semantics. */
const MIN_WINDOW_MS = 60 * 1000
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000

// ── Helpers ───────────────────────────────────────────────

/**
 * SHA-256 hex digest of the plaintext key. Matches what the admin POST
 * route stored in `api_keys.key_hash` at creation time. Constant-time
 * comparison isn't strictly needed here because we look up by digest
 * (the timing leak would only reveal a hash, not the plaintext).
 */
export function hashApiKey(plaintext: string): string {
  // CodeQL: js/insufficient-key-size — ACCEPTED RISK:
  // API keys are 256-bit random strings (high entropy). SHA-256 is industry
  // standard for API key hashing (not passwords). bcrypt/scrypt are unnecessary
  // and would add latency to every API call. See: Stripe, GitHub, AWS patterns.
  return createHash('sha256').update(plaintext).digest('hex')
}

function rateLimitHeadersFromResult(
  limit: number,
  remaining: number,
  resetAtMs: number,
): RateLimitHeaders {
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
    'X-RateLimit-Reset': String(Math.ceil(resetAtMs / 1000)), // Unix seconds
  }
}

/** Fire-and-forget bump of usage counters. Never blocks the request. */
function bumpUsage(keyId: string): void {
  const supabase = getSupabase()
  if (!supabase) return
  // We don't await; analytics path must not slow the auth check.
  // Errors are logged but otherwise swallowed.
  ;(async () => {
    try {
      // Two-step is safer than RPC across providers — Postgres RPC isn't
      // guaranteed available on every Supabase project. The race between
      // concurrent bumps is fine for an approximate counter.
      const { data, error: readErr } = await supabase
        .from('api_keys')
        .select('total_requests')
        .eq('id', keyId)
        .single()
      if (readErr || !data) return
      const next = (data.total_requests ?? 0) + 1
      await supabase
        .from('api_keys')
        .update({ total_requests: next, last_used_at: new Date().toISOString() })
        .eq('id', keyId)
    } catch (err) {
      console.warn(
        '[api-auth] bumpUsage failed (non-blocking):',
        err instanceof Error ? err.message : err,
      )
    }
  })()
}

// ── Main entry point ─────────────────────────────────────

/**
 * Validate an incoming request's API key and apply rate limits.
 *
 * Failure modes:
 *   - missing / malformed header                 → 401 invalid_key
 *   - hash not found in `api_keys`               → 401 invalid_key
 *   - row.is_active === false                    → 401 key_revoked
 *   - row.expires_at < NOW()                     → 401 key_expired
 *   - per-minute or per-day window exhausted     → 429 rate_limited
 *   - Supabase unreachable                       → 503 db_unavailable
 *     (fail closed — we don't want unauth'd access if our auth store
 *     is dark, but we also don't make the client rotate keys)
 */
export async function verifyApiKey(req: NextRequest): Promise<ApiAuthResult> {
  const raw = req.headers.get(HEADER_NAME)?.trim() ?? ''
  if (!raw) {
    return {
      ok: false,
      status: 401,
      error: 'Missing X-API-Key header.',
    }
  }

  const keyHash = hashApiKey(raw)
  if (!HASH_RE.test(keyHash)) {
    // Defensive belt: shouldn't be reachable since createHash always
    // returns hex, but a transformed digest implementation could change
    // the shape — fail closed.
    return { ok: false, status: 401, error: 'Invalid API key.' }
  }

  const supabase = getSupabase()
  if (!supabase) {
    console.error('[api-auth] Supabase not configured — failing closed on /v1/*')
    return {
      ok: false,
      status: 503,
      error: 'Auth backend unavailable. Retry shortly.',
    }
  }

  let row: ApiKeyRow | null
  try {
    const { data, error } = await supabase
      .from('api_keys')
      .select(
        'id, key_hash, name, tier, rate_limit_per_min, rate_limit_per_day, is_active, created_at, expires_at, last_used_at, total_requests',
      )
      .eq('key_hash', keyHash)
      .maybeSingle()
    if (error) {
      console.error('[api-auth] Supabase lookup error:', error.message)
      return { ok: false, status: 503, error: 'Auth backend unavailable. Retry shortly.' }
    }
    row = (data as ApiKeyRow | null) ?? null
  } catch (err) {
    console.error(
      '[api-auth] Supabase lookup threw:',
      err instanceof Error ? err.message : err,
    )
    return { ok: false, status: 503, error: 'Auth backend unavailable. Retry shortly.' }
  }

  // [11-M-03] Unified 401 message — distinct error strings here would let
  // an attacker enumerate which hashes exist and what state they are in
  // (active-rate-limited vs revoked vs expired). The distinction is still
  // logged server-side for operators; only the wire response is uniform.
  const REJECTION_MESSAGE = 'Invalid or inactive API key.'
  const hashPrefix = keyHash.slice(0, 8)

  if (!row) {
    console.warn(`[api-auth] rejected: no key matched hash-prefix ${hashPrefix}`)
    return { ok: false, status: 401, error: REJECTION_MESSAGE }
  }
  if (!row.is_active) {
    console.warn(`[api-auth] rejected: revoked key ${hashPrefix} (id=${row.id})`)
    return { ok: false, status: 401, error: REJECTION_MESSAGE }
  }
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    console.warn(`[api-auth] rejected: expired key ${hashPrefix} (id=${row.id}, expired_at=${row.expires_at})`)
    return { ok: false, status: 401, error: REJECTION_MESSAGE }
  }

  // ── Rate limit: per-minute first, per-day second ────────
  // Both windows must allow the request. We check minute first because
  // it's the smaller of the two and most rejections happen there;
  // skipping the day check on a minute-fail saves one KV round-trip.
  const minResult = await checkRateLimit(`api:${keyHash}:min`, row.rate_limit_per_min, MIN_WINDOW_MS)
  if (!minResult.allowed) {
    const headers = rateLimitHeadersFromResult(
      row.rate_limit_per_min,
      0,
      minResult.resetAt,
    )
    // Retry-After in seconds, per RFC 6585.
    const retryAfter = Math.max(1, Math.ceil((minResult.resetAt - Date.now()) / 1000))
    headers['Retry-After'] = String(retryAfter)
    return {
      ok: false,
      status: 429,
      error: 'Per-minute rate limit exceeded.',
      rateLimitHeaders: headers,
    }
  }

  const dayResult = await checkRateLimit(`api:${keyHash}:day`, row.rate_limit_per_day, DAY_WINDOW_MS)
  if (!dayResult.allowed) {
    const headers = rateLimitHeadersFromResult(
      row.rate_limit_per_day,
      0,
      dayResult.resetAt,
    )
    const retryAfter = Math.max(1, Math.ceil((dayResult.resetAt - Date.now()) / 1000))
    headers['Retry-After'] = String(retryAfter)
    return {
      ok: false,
      status: 429,
      error: 'Daily rate limit exceeded.',
      rateLimitHeaders: headers,
    }
  }

  // Success — surface the tighter window's remaining budget. The minute
  // window is what most clients care about for backoff signalling; the
  // day budget is visible via the admin dashboard.
  const rateLimitHeaders = rateLimitHeadersFromResult(
    row.rate_limit_per_min,
    minResult.remaining,
    minResult.resetAt,
  )

  // Validate the stored tier label. If a row is somehow set to an
  // unknown tier (shouldn't happen given the admin route + isApiKeyTier
  // guard, but defensive), default to free so callers still get a
  // typed value.
  const tier: ApiKeyTier =
    row.tier === 'pro' || row.tier === 'enterprise' ? row.tier : 'free'

  // Fire-and-forget usage bump.
  bumpUsage(row.id)

  return {
    ok: true,
    keyId: row.id,
    keyName: row.name,
    tier,
    rateLimitHeaders,
  }
}
