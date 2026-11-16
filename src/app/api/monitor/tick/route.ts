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
import { bodySizeGuard } from '@/lib/body-limit'
import { runMonitoringTick } from '@/lib/monitoring-loop'
import { verifyBearerToken } from '@/lib/auth'
import { runWithAlertsSettled } from '@/lib/alert-inflight'

export const dynamic = 'force-dynamic'
export const maxDuration = 30 // Allow up to 30s for all health checks

/**
 * The response goes out by this point (ms after the request arrived), leaving 3 s of the 30 s `maxDuration` for
 * serialising and sending it. The tick waits for the alerts it caused only until then (and never longer than
 * ALERT_SETTLE_MAX_MS): see `runWithAlertsSettled`.
 */
const TICK_RESPONSE_DEADLINE_MS = 27_000

export async function POST(req: NextRequest) {
  const requestedAt = Date.now()
  // [AUDIT-W6 / W6-L-01] Oversized body -> 413 before any other work.
  const tooLarge = bodySizeGuard(req)
  if (tooLarge) return tooLarge
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
    // Nobody waits on this cron call, so the alerts the tick caused (state-machine transitions are fire-and-forget) are
    // awaited, bounded, before the response: a frozen function must not cut a Telegram message in flight.
    const result = await runWithAlertsSettled(() => runMonitoringTick(), { deadlineAt: requestedAt + TICK_RESPONSE_DEADLINE_MS })

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
