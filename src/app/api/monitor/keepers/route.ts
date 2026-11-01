/**
 * GET /api/monitor/keepers — the keepers' self-reported paused state, per chain.
 *
 * [fix/executor-alert-masking-rpc-auth] INC-2026-10-30-001: the Base keeper's RPC provider rejected
 * every call for ~20 h and the daily report could not see it — it reads production through HTTP
 * only, and the keeper host (SSM-only) exposes nothing. The keeper now writes `paused` /
 * `paused_since` to its keeper_runtime_config row; this route is the daily report's read of it.
 *
 * Auth: `Authorization: Bearer <MONITOR_SECRET>` (same secret the workflow already sends to
 * /api/monitor/alerts; constant-time compare). Read-only: one SELECT per chain, no writes.
 * [A71 L-1] Rate-limited per trusted client IP BEFORE the auth check, so guessing the secret or
 * hammering the Supabase reads costs a 429, not a database round-trip per request.
 *
 * Response: { status: 'OK' | 'PAUSED' | 'UNKNOWN', chains: [{ chainId, active, readable, paused,
 * pausedSince }] } — UNKNOWN when any ACTIVE chain could not be read (no Supabase, or the migration
 * 20261031120000_keeper_runtime_config_paused.sql is not applied yet) or none could; never OK then.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyBearerToken } from '@/lib/auth'
import { readAllKeeperPausedStates } from '@/lib/keeper-health-monitor'
import { checkRateLimit } from '@/lib/kv-rate-limiter'
import { trustedClientIp } from '@/lib/trusted-ip'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
/** The daily report calls this once a day; 30/min per IP leaves room for manual checks only.
 *  (Not exported: a Next.js route file may only export route fields.) */
const KEEPERS_RATE_LIMIT = { limit: 30, windowMs: 60_000 }

export async function GET(req: NextRequest) {
  const rate = await checkRateLimit(`monitor:${trustedClientIp(req)}`, KEEPERS_RATE_LIMIT.limit, KEEPERS_RATE_LIMIT.windowMs)
  if (!rate.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(retryAfter) } })
  }

  const secret = process.env.MONITOR_SECRET
  if (!secret) return NextResponse.json({ error: 'not configured' }, { status: 503, headers: NO_STORE })
  if (!verifyBearerToken(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const chains = await readAllKeeperPausedStates()
  // [A71 M-2] A partial read is never OK: an ACTIVE chain whose state could not be read may be the
  // paused one. Inactive chains do not count (they execute nothing).
  const status = chains.some((c) => c.paused)
    ? 'PAUSED'
    : chains.some((c) => c.active && !c.readable) || !chains.some((c) => c.readable)
      ? 'UNKNOWN'
      : 'OK'
  return NextResponse.json({ status, chains }, { headers: NO_STORE })
}
