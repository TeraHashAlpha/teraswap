/**
 * GET /api/monitor/heartbeat/admin — Detailed health data (auth required).
 *
 * [API-H-01] Full monitoring state including per-source status, quorum
 * outliers, and grace period info. Protected by MONITOR_CRON_SECRET bearer.
 */

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual, createHash } from 'node:crypto'
import { kv } from '@vercel/kv'
import { getAllStatuses } from '@/lib/source-state-machine'
import { isInGracePeriodAsync } from '@/lib/grace-period'

export const dynamic = 'force-dynamic'

const HEARTBEAT_STALE_SECONDS = 180

function verifyBearerToken(provided: string, expected: string): boolean {
  try {
    const hashA = createHash('sha256').update(provided).digest()
    const hashB = createHash('sha256').update(expected).digest()
    return timingSafeEqual(hashA, hashB)
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const secret = process.env.MONITOR_CRON_SECRET
  if (!secret) {
    console.error('[HEARTBEAT-ADMIN] MONITOR_CRON_SECRET not configured')
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  const authHeader = req.headers.get('authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token || !verifyBearerToken(token, secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const [lastTickIso, tickCount, lastQuorum] = await Promise.all([
      kv.get<string>('teraswap:monitor:lastTick'),
      kv.get<number>('teraswap:monitor:tickCount'),
      kv.get<{
        timestamp: string
        outliers: Array<{ sourceId: string; deviationPercent: number; classification: string; pairLabel: string }>
        correlatedOutlierCount: number
        skipped: boolean
        skipReason?: string
      }>('teraswap:monitor:lastQuorumResult'),
    ])

    const statuses = await getAllStatuses()
    const sources = {
      active: statuses.filter(s => s.state === 'active').length,
      degraded: statuses.filter(s => s.state === 'degraded').length,
      disabled: statuses.filter(s => s.state === 'disabled').length,
    }

    const lastTickMs = lastTickIso ? new Date(lastTickIso).getTime() : 0
    const ageSeconds = lastTickMs > 0 ? Math.round((Date.now() - lastTickMs) / 1000) : null

    const grace = await isInGracePeriodAsync()
    const tickFresh = ageSeconds !== null && ageSeconds < HEARTBEAT_STALE_SECONDS
    const healthy = grace || tickFresh

    const quorumOutliers = lastQuorum?.outliers?.filter(
      o => o.classification === 'flagged' || o.classification === 'correlated',
    ) ?? []
    const quorumHealthy = lastQuorum ? lastQuorum.correlatedOutlierCount === 0 : true

    const body: Record<string, unknown> = {
      lastTick: lastTickIso || null,
      tickCount: tickCount ?? 0,
      ageSeconds,
      healthy,
      tickFresh,
      sources,
      lastQuorumCheck: lastQuorum?.timestamp ?? null,
      quorumOutliers: quorumOutliers.length,
      quorumHealthy,
    }

    if (grace) {
      body.grace = true
    }

    return NextResponse.json(body, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    console.error('[HEARTBEAT-ADMIN] KV read failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'KV unavailable', healthy: false },
      { status: 500 },
    )
  }
}
