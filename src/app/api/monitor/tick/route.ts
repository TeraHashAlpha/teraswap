/**
 * POST /api/monitor/tick — Run one monitoring tick.
 *
 * Called by Vercel Cron every 60s, or manually for debugging.
 * Protected by CRON_SECRET to prevent public abuse.
 *
 * Returns health check results and any state transitions.
 */

import { NextRequest, NextResponse } from 'next/server'
import { runMonitoringTick } from '@/lib/monitoring-loop'

export const dynamic = 'force-dynamic'
export const maxDuration = 30 // Allow up to 30s for all health checks

export async function POST(req: NextRequest) {
  // Auth: Vercel Cron passes CRON_SECRET header
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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
