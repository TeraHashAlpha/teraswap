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
 *
 * Response: { status: 'OK' | 'PAUSED' | 'UNKNOWN', chains: [{ chainId, active, readable, paused,
 * pausedSince }] } — UNKNOWN when no chain could be read (no Supabase, or the migration
 * 20261031120000_keeper_runtime_config_paused.sql is not applied yet).
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyBearerToken } from '@/lib/auth'
import { readAllKeeperPausedStates } from '@/lib/keeper-health-monitor'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  const secret = process.env.MONITOR_SECRET
  if (!secret) return NextResponse.json({ error: 'not configured' }, { status: 503, headers: NO_STORE })
  if (!verifyBearerToken(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const chains = await readAllKeeperPausedStates()
  const status = chains.some((c) => c.paused) ? 'PAUSED' : chains.some((c) => c.readable) ? 'OK' : 'UNKNOWN'
  return NextResponse.json({ status, chains }, { headers: NO_STORE })
}
