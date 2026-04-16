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
import { timingSafeEqual, createHash } from 'node:crypto'
import { runMonitoringTick } from '@/lib/monitoring-loop'

export const dynamic = 'force-dynamic'
export const maxDuration = 30 // Allow up to 30s for all health checks

/**
 * Constant-time comparison of bearer token via SHA-256 pre-hash.
 * Hashing both sides produces fixed 32-byte digests, eliminating the
 * length leak that direct timingSafeEqual would have on variable inputs.
 */
function verifyBearerToken(provided: string, expected: string): boolean {
  try {
    const hashA = createHash('sha256').update(provided).digest()
    const hashB = createHash('sha256').update(expected).digest()
    return timingSafeEqual(hashA, hashB)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  // [API-C-01] Auth is mandatory — 503 if secret not configured
  const secret = process.env.MONITOR_CRON_SECRET
  if (!secret) {
    console.error('[TICK] MONITOR_CRON_SECRET not configured')
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  const authHeader = req.headers.get('authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token || !verifyBearerToken(token, secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
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
