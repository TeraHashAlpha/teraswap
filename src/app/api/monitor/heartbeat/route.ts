/**
 * GET /api/monitor/heartbeat — Public health probe for external watchdogs.
 *
 * [API-H-01] Returns minimal health status only. No source names, states,
 * quorum data, or operational details. Detailed data available at
 * /api/monitor/heartbeat/admin (auth required).
 *
 * Response: { healthy: boolean, ageSeconds: number | null, tickFresh: boolean }
 */

import { NextResponse } from 'next/server'
import { kv } from '@vercel/kv'
import { isInGracePeriodAsync } from '@/lib/grace-period'

export const dynamic = 'force-dynamic'

const HEARTBEAT_STALE_SECONDS = 180 // 3 minutes — if tick is older, unhealthy

export async function GET() {
  try {
    const lastTickIso = await kv.get<string>('teraswap:monitor:lastTick')

    const lastTickMs = lastTickIso ? new Date(lastTickIso).getTime() : 0
    const ageSeconds = lastTickMs > 0 ? Math.round((Date.now() - lastTickMs) / 1000) : null

    const grace = await isInGracePeriodAsync()
    const tickFresh = ageSeconds !== null && ageSeconds < HEARTBEAT_STALE_SECONDS
    const healthy = grace || tickFresh

    return NextResponse.json(
      { healthy, ageSeconds, tickFresh },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      },
    )
  } catch (err) {
    console.error('[HEARTBEAT] KV read failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'KV unavailable', healthy: false },
      { status: 500 },
    )
  }
}
