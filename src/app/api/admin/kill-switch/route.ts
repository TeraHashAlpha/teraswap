/**
 * POST /api/admin/kill-switch — Emergency source kill-switch.
 *
 * Force-disables a source with reason 'kill-switch-triggered' (P0).
 * The P0 designation means:
 *   - Alerts bypass grace period and fire to ALL channels immediately
 *   - Short dedup TTL (5 min) so repeated kills re-alert quickly
 *   - Auto-recovery is blocked — source stays disabled until manually re-activated
 *
 * Authentication: Bearer token (KILL_SWITCH_SECRET env var).
 * Uses constant-time comparison to prevent timing attacks.
 *
 * DESIGN DECISION — No re-activation endpoint:
 * Re-activating a P0-disabled source requires calling forceActivate() via code
 * deployment or a future admin panel. This friction is intentional — re-activation
 * after a kill-switch should require investigation, not a single curl.
 * See also: source-state-machine.ts forceActivate() comments.
 *
 * Rate limited: 10 requests/minute per IP (in-memory — emergency endpoint, not hot path).
 *
 * @internal — server-only route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { kv } from '@vercel/kv'
import { forceDisable, getStatus } from '@/lib/source-state-machine'

export const dynamic = 'force-dynamic'

// ── Rate limiting (in-memory) ───────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX = 10

const rateLimitMap = new Map<string, { count: number; windowStart: number }>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now })
    return false
  }

  entry.count++
  return entry.count > RATE_LIMIT_MAX
}

// Periodic cleanup to prevent memory leak (emergency endpoint — map stays tiny)
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip)
    }
  }
}, RATE_LIMIT_WINDOW_MS * 5).unref?.()

// ── Auth helpers ────────────────────────────────────────

function verifyToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

function extractBearer(req: NextRequest): string | null {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7)
}

// ── KV audit trail ──────────────────────────────────────

const AUDIT_KEY_PREFIX = 'teraswap:audit:kill-switch:'
const AUDIT_INDEX_KEY = 'teraswap:audit:kill-switch:index'
let auditSeq = 0 // monotonic counter to prevent same-ms key collisions

interface AuditEntry {
  sourceId: string
  reason: string
  triggeredBy: 'api'
  timestamp: string
  previousState: string
}

async function writeAuditEntry(entry: AuditEntry): Promise<void> {
  const auditKey = `${AUDIT_KEY_PREFIX}${entry.timestamp}:${++auditSeq}`
  try {
    const pipeline = kv.pipeline()
    pipeline.set(auditKey, entry)
    pipeline.sadd(AUDIT_INDEX_KEY, auditKey)
    await pipeline.exec()
  } catch (err) {
    // Audit write failure must not block the kill-switch operation.
    // Log prominently — the kill itself already succeeded at this point.
    console.error(
      '[KILL-SWITCH] Audit trail write failed:',
      err instanceof Error ? err.message : err,
    )
  }
}

// ── Route handler ───────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ① Rate limit
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: 'rate limited' },
      { status: 429 },
    )
  }

  // ② Check KILL_SWITCH_SECRET is configured
  const secret = process.env.KILL_SWITCH_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'kill-switch not configured' },
      { status: 503 },
    )
  }

  // ③ Authenticate — constant-time comparison, no info leakage
  const token = extractBearer(req)
  if (!token || !verifyToken(token, secret)) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401 },
    )
  }

  // ④ Parse & validate body
  let body: { sourceId?: string; reason?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { error: 'invalid JSON body' },
      { status: 400 },
    )
  }

  const { sourceId, reason } = body
  if (!sourceId || typeof sourceId !== 'string') {
    return NextResponse.json(
      { error: 'sourceId is required' },
      { status: 400 },
    )
  }

  // ⑤ Verify source exists in KV index
  try {
    const knownSources = await kv.smembers('teraswap:source-state:index') as string[]
    if (!knownSources || !knownSources.includes(sourceId)) {
      return NextResponse.json(
        { error: 'source not found' },
        { status: 404 },
      )
    }
  } catch (err) {
    console.error('[KILL-SWITCH] KV read failed during source lookup:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'KV unavailable' },
      { status: 503 },
    )
  }

  // ⑥ Build full reason
  const fullReason = reason
    ? `kill-switch-triggered: ${reason}`
    : 'kill-switch-triggered'

  // ⑦ Get previous state for audit trail
  const previousStatus = await getStatus(sourceId)
  const previousState = previousStatus.state
  const timestamp = new Date().toISOString()

  // ⑧ Force-disable (idempotent — forceDisable always writes, transition() is a no-op if already disabled)
  await forceDisable(sourceId, fullReason)

  // ⑨ Write audit entry (even for idempotent calls)
  await writeAuditEntry({
    sourceId,
    reason: fullReason,
    triggeredBy: 'api',
    timestamp,
    previousState,
  })

  // ⑩ Return success
  return NextResponse.json({
    success: true,
    sourceId,
    state: 'disabled',
    reason: fullReason,
    timestamp,
  })
}

// ── Export for testing ──────────────────────────────────

export const _internal = {
  rateLimitMap,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  verifyToken,
} as const
