/**
 * POST /api/monitor/tick — Run one monitoring tick.
 *
 * Called every 60s by Cloudflare Worker (teraswap-monitor-tick-cron).
 * Protected by MONITOR_CRON_SECRET bearer token.
 *
 * Returns health check results and any state transitions.
 */

import { NextRequest, NextResponse } from 'next/server'
import { runMonitoringTick } from '@/lib/monitoring-loop'

export const dynamic = 'force-dynamic'
export const maxDuration = 30 // Allow up to 30s for all health checks

export async function POST(req: NextRequest) {
  // Auth: Cloudflare Worker passes MONITOR_CRON_SECRET as bearer
  const secret = process.env.MONITOR_CRON_SECRET
  const authHeader = req.headers.get('authorization')

  if (secret && authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runMonitoringTick()

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

// GET for manual debugging (no auth required — returns status only)
export async function GET() {
  try {
    const result = await runMonitoringTick()
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
