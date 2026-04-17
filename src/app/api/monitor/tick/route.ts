/**
 * POST /api/monitor/tick — Run one monitoring tick.
 *
 * Called every 60s by Cloudflare Worker (teraswap-monitor-tick-cron).
 * Protected by MONITOR_CRON_SECRET bearer token (constant-time comparison).
 *
 * [API-C-01] GET handler removed — all invocations require auth.
 * Manual debugging: curl -X POST -H "Authorization: Bearer $TOKEN" /api/monitor/tick
 *
 * Returns health check results and any state transitions.
 */

import { NextRequest, NextResponse } from 'next/server'
import { runMonitoringTick } from '@/lib/monitoring-loop'
import { verifyBearerToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 30 // Allow up to 30s for all health checks

export async function POST(req: NextRequest) {
  // [API-C-01] Auth is mandatory — 503 if secret not configured
  const secret = process.env.MONITOR_CRON_SECRET
  if (!secret) {
    console.error('[TICK] MONITOR_CRON_SECRET not configured')
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  if (!verifyBearerToken(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await runMonitoringTick()

    // [API-M-03] Skipped tick (concurrent lock) — 200 OK, not an error
    if (result.skipped) {
      return NextResponse.json(
        { ok: true, skipped: true, reason: result.reason },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    console.error('[MONITOR-TICK] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
