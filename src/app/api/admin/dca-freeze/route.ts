/**
 * /api/admin/dca-freeze — Admin DCA circuit-breaker freeze toggle.
 *
 * The ONLY writer of the Supabase `circuit_breaker` row (id='dca'). When
 * frozen, the create-order API rejects new DCA orders and the keeper
 * (executor.js) skips execution of existing DCA orders this cycle; non-DCA
 * orders (limit/stop_loss) are unaffected. The on-chain pause() remains the
 * nuclear fail-safe — this flag is the application-layer brake.
 *
 * NO AUTO-FREEZE: nothing else sets this flag. The observability bot only
 * alerts ("consider freezing"); a human operator flips the switch here.
 *
 * Authentication: Bearer token (DCA_FREEZE_SECRET env var), verified with the
 * shared constant-time helper. The 0x9A38 admin wallet gates the client UI;
 * the server enforces this Bearer secret, mirroring api/admin/kill-switch.
 *
 *   POST { frozen: boolean, reason?: string }  → set state, return new state
 *   GET                                        → return current state
 *
 * Both verbs are auth-gated and return 503 when the secret is unconfigured.
 *
 * @internal — server-only route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { bodySizeGuard } from '@/lib/body-limit'
import { verifyBearerToken } from '@/lib/auth'
import { getDcaFreezeState, setDcaFreezeState } from '@/lib/dca-freeze'

export const dynamic = 'force-dynamic'

const UPDATED_BY = 'admin'

/**
 * Resolve and validate the configured secret + Bearer token.
 * Returns a NextResponse to short-circuit on failure, or null when authorised.
 */
function authorize(req: NextRequest): NextResponse | null {
  const secret = process.env.DCA_FREEZE_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'dca-freeze not configured' },
      { status: 503 },
    )
  }

  if (!verifyBearerToken(req.headers.get('authorization'), secret)) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401 },
    )
  }

  return null
}

// ── POST: set freeze state ──────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // [AUDIT-W6 / W6-L-01] Oversized body -> 413 before any other work.
  const tooLarge = bodySizeGuard(req)
  if (tooLarge) return tooLarge
  // ① Auth (503 if unconfigured, 401 if bad token)
  const denied = authorize(req)
  if (denied) return denied

  // ② Parse & validate body
  let body: { frozen?: unknown; reason?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { error: 'invalid JSON body' },
      { status: 400 },
    )
  }

  if (typeof body.frozen !== 'boolean') {
    return NextResponse.json(
      { error: 'frozen (boolean) is required' },
      { status: 400 },
    )
  }

  const reason = typeof body.reason === 'string' ? body.reason : ''

  // ③ Persist — admin is the sole writer (no auto-freeze)
  try {
    const state = await setDcaFreezeState(body.frozen, reason, UPDATED_BY)
    return NextResponse.json(state)
  } catch (err) {
    console.error(
      '[DCA-FREEZE] write failed:',
      err instanceof Error ? err.message : err,
    )
    return NextResponse.json(
      { error: 'failed to set freeze state' },
      { status: 503 },
    )
  }
}

// ── GET: read current freeze state ──────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = authorize(req)
  if (denied) return denied

  // getDcaFreezeState is fail-open and never throws.
  const state = await getDcaFreezeState()
  return NextResponse.json(state)
}
