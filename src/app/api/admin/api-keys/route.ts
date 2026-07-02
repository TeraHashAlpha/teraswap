/**
 * [LP-08] /api/admin/api-keys — CRUD for public-API keys.
 *
 *   POST   create a new key  → returns plaintext key ONCE (never persisted)
 *   GET    list keys (no hash, no plaintext)
 *   DELETE soft-delete by id (sets is_active = false)
 *
 * Authentication: Bearer token via ADMIN_API_KEYS_SECRET env var, verified
 * with the same constant-time SHA-256-comparison helper used by the
 * kill-switch route. There is no UI for this endpoint yet — admins
 * curl it directly from a secured workstation.
 *
 * DESIGN — single-shot plaintext exposure:
 *   - The /v1/* hot path looks up by SHA-256(plaintext) only; we never
 *     need the plaintext ourselves once the key has been issued.
 *   - On POST we return the plaintext exactly once and write the digest.
 *   - If the admin loses the plaintext they revoke and reissue —
 *     there's no recovery path. This is by design (NIST 800-63B-ish
 *     handling for credentials).
 *
 * @internal — server-only route. Excluded from the public surface.
 */

import { NextRequest, NextResponse } from 'next/server'
import { bodySizeGuard } from '@/lib/body-limit'
import { randomBytes } from 'node:crypto'
import { getSupabase } from '@/lib/supabase'
import { verifyBearerToken } from '@/lib/auth'
import { hashApiKey } from '@/lib/api-auth'
import { API_KEY_TIERS, isApiKeyTier, type ApiKeyTier } from '@/lib/constants'

export const dynamic = 'force-dynamic'

// [11-L-05] Hard caps on admin-configurable per-key rate limits. An honest
// typo (`rateLimitPerMin: 999999999`) used to silently mint an effectively
// unlimited key; the caps force the value back to the tier default and
// surface the override in a `warnings` array on the response.
const MAX_RATE_LIMIT_PER_MIN = 10_000
const MAX_RATE_LIMIT_PER_DAY = 1_000_000

// ── Helpers ────────────────────────────────────────────────

function isAuthed(req: NextRequest): boolean {
  const secret = process.env.ADMIN_API_KEYS_SECRET
  if (!secret) return false
  return verifyBearerToken(req.headers.get('authorization'), secret)
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
}

function supabaseUnavailable(): NextResponse {
  // [11-L-04 → covered by 11-M-02 sweep] Original message leaked the
  // names of the missing env vars to anyone who could authenticate
  // against this admin route. The operator-facing detail stays in the
  // server log; the response is the generic envelope.
  console.error('[api-keys] Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  return NextResponse.json({ error: 'Service unavailable.' }, { status: 503 })
}

/**
 * Generate a fresh plaintext API key.
 *
 * Format: `tsk_` prefix + base64url(32 random bytes).
 *   - The `tsk_` prefix lets clients spot the credential class in logs,
 *     env vars, and IDE autocomplete (mirrors the Stripe `sk_…` / GitHub
 *     `ghp_…` conventions).
 *   - 32 bytes = 256 bits of entropy, well above the 128-bit threshold
 *     where birthday-collision math becomes irrelevant.
 *   - base64url (no `+`, `/`, or `=`) is URL/header safe without escaping.
 */
function generatePlaintextKey(): string {
  const body = randomBytes(32).toString('base64url')
  return `tsk_${body}`
}

// ── POST: create a new key ─────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // [AUDIT-W6 / W6-L-01] Oversized body -> 413 before any other work.
  const tooLarge = bodySizeGuard(req)
  if (tooLarge) return tooLarge
  if (!isAuthed(req)) return unauthorized()
  const supabase = getSupabase()
  if (!supabase) return supabaseUnavailable()

  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  // Required: name. Optional: tier (default 'free'), expiresAt (ISO).
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 200) {
    return NextResponse.json(
      { error: 'name is required (1..200 chars).' },
      { status: 400 },
    )
  }

  const requestedTier: unknown = body.tier ?? 'free'
  if (!isApiKeyTier(requestedTier)) {
    return NextResponse.json(
      { error: `tier must be one of: ${Object.keys(API_KEY_TIERS).join(', ')}` },
      { status: 400 },
    )
  }
  const tier: ApiKeyTier = requestedTier
  const limits = API_KEY_TIERS[tier]

  let expiresAt: string | null = null
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (typeof body.expiresAt !== 'string') {
      return NextResponse.json(
        { error: 'expiresAt must be an ISO 8601 string or null.' },
        { status: 400 },
      )
    }
    const parsed = Date.parse(body.expiresAt)
    if (!Number.isFinite(parsed) || parsed <= Date.now()) {
      return NextResponse.json(
        { error: 'expiresAt must be a valid ISO 8601 date in the future.' },
        { status: 400 },
      )
    }
    expiresAt = new Date(parsed).toISOString()
  }

  // Allow admin to override per-key limits (special arrangements). When
  // omitted, OR when the value exceeds the hard cap, fall back to the
  // tier defaults — [11-L-05] never error on an over-the-cap value, just
  // surface a warning so an honest typo doesn't block key creation.
  const rateLimitPerMin =
    typeof body.rateLimitPerMin === 'number' &&
    Number.isInteger(body.rateLimitPerMin) &&
    body.rateLimitPerMin > 0 &&
    body.rateLimitPerMin <= MAX_RATE_LIMIT_PER_MIN
      ? body.rateLimitPerMin
      : limits.perMin
  const rateLimitPerDay =
    typeof body.rateLimitPerDay === 'number' &&
    Number.isInteger(body.rateLimitPerDay) &&
    body.rateLimitPerDay > 0 &&
    body.rateLimitPerDay <= MAX_RATE_LIMIT_PER_DAY
      ? body.rateLimitPerDay
      : limits.perDay

  // Surface capped overrides on the response so the admin notices.
  const warnings: string[] = []
  if (typeof body.rateLimitPerMin === 'number' && body.rateLimitPerMin > MAX_RATE_LIMIT_PER_MIN) {
    warnings.push(`rateLimitPerMin capped at ${MAX_RATE_LIMIT_PER_MIN}`)
  }
  if (typeof body.rateLimitPerDay === 'number' && body.rateLimitPerDay > MAX_RATE_LIMIT_PER_DAY) {
    warnings.push(`rateLimitPerDay capped at ${MAX_RATE_LIMIT_PER_DAY}`)
  }

  // Mint and hash. Plaintext leaves this function only via the response
  // body; the DB only ever sees the digest.
  const plaintext = generatePlaintextKey()
  const keyHash = hashApiKey(plaintext)

  try {
    const { data, error } = await supabase
      .from('api_keys')
      .insert({
        key_hash: keyHash,
        name,
        tier,
        rate_limit_per_min: rateLimitPerMin,
        rate_limit_per_day: rateLimitPerDay,
        expires_at: expiresAt,
      })
      .select('id, name, tier, rate_limit_per_min, rate_limit_per_day, is_active, created_at, expires_at')
      .single()

    if (error || !data) {
      console.error('[api-keys] insert failed:', error?.message ?? 'no row returned')
      return NextResponse.json({ error: 'Failed to create API key.' }, { status: 500 })
    }

    return NextResponse.json({
      id: data.id,
      name: data.name,
      tier: data.tier,
      rateLimitPerMin: data.rate_limit_per_min,
      rateLimitPerDay: data.rate_limit_per_day,
      isActive: data.is_active,
      createdAt: data.created_at,
      expiresAt: data.expires_at,
      // SECURITY: plaintext returned ONCE. The server has only the SHA-256
      // digest from this point forward; lose this string and the key must
      // be revoked + re-issued.
      key: plaintext,
      // [11-L-05] Empty when no overrides were capped — present when one was.
      ...(warnings.length > 0 ? { warnings } : {}),
    }, { status: 201 })
  } catch (err) {
    console.error('[api-keys] POST threw:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to create API key.' }, { status: 500 })
  }
}

// ── GET: list keys (no hash, no plaintext) ─────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized()
  const supabase = getSupabase()
  if (!supabase) return supabaseUnavailable()

  try {
    // key_hash deliberately excluded — there's no operational reason an
    // admin needs the digest, and including it widens the blast radius
    // of any future log/leak of this response.
    const { data, error } = await supabase
      .from('api_keys')
      .select(
        'id, name, tier, rate_limit_per_min, rate_limit_per_day, is_active, created_at, expires_at, last_used_at, total_requests',
      )
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[api-keys] list failed:', error.message)
      return NextResponse.json({ error: 'Failed to list API keys.' }, { status: 500 })
    }

    const keys = (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      tier: row.tier,
      rateLimitPerMin: row.rate_limit_per_min,
      rateLimitPerDay: row.rate_limit_per_day,
      isActive: row.is_active,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      totalRequests: Number(row.total_requests ?? 0),
    }))

    return NextResponse.json({ keys })
  } catch (err) {
    console.error('[api-keys] GET threw:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to list API keys.' }, { status: 500 })
  }
}

// ── DELETE: soft-delete a key ──────────────────────────────

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized()
  const supabase = getSupabase()
  if (!supabase) return supabaseUnavailable()

  const id = new URL(req.url).searchParams.get('id')?.trim()
  if (!id) {
    return NextResponse.json({ error: '?id=<uuid> query parameter is required.' }, { status: 400 })
  }
  // Lightweight UUID shape check — Supabase will also reject malformed
  // UUIDs but this gives a clearer error message.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'id must be a valid UUID.' }, { status: 400 })
  }

  try {
    const { data, error } = await supabase
      .from('api_keys')
      .update({ is_active: false })
      .eq('id', id)
      .select('id, is_active')
      .maybeSingle()

    if (error) {
      console.error('[api-keys] soft-delete failed:', error.message)
      return NextResponse.json({ error: 'Failed to deactivate API key.' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'API key not found.' }, { status: 404 })
    }

    return NextResponse.json({ ok: true, id: data.id, isActive: data.is_active })
  } catch (err) {
    console.error('[api-keys] DELETE threw:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to deactivate API key.' }, { status: 500 })
  }
}
