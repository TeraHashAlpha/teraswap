/**
 * GET /api/monitor/heartbeat — Public health probe for external watchdogs.
 *
 * Returns monitoring loop freshness, source state summary, and health status.
 * Unauthenticated (read-only, no sensitive data). GitHub Actions watchdog
 * polls this every 5 minutes and pages if `healthy` is false.
 *
 * During a maintenance grace period (MONITOR_GRACE_UNTIL), `healthy` is
 * forced to true and `grace: true` is added so watchdogs don't page.
 */

import { NextResponse } from 'next/server'
import { kv } from '@vercel/kv'
import { getAllStatuses } from '@/lib/source-state-machine'
import { isInGracePeriod } from '@/lib/grace-period'

export const dynamic = 'force-dynamic'

const HEARTBEAT_STALE_SECONDS = 180 // 3 minutes — if tick is older, unhealthy

export async function GET() {
  try {
    // Read heartbeat data + latest quorum result from KV
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

    // Read source state summary
    const statuses = await getAllStatuses()
    const sources = {
      active: statuses.filter(s => s.state === 'active').length,
      degraded: statuses.filter(s => s.state === 'degraded').length,
      disabled: statuses.filter(s => s.state === 'disabled').length,
    }

    // Calculate age
    const lastTickMs = lastTickIso ? new Date(lastTickIso).getTime() : 0
    const ageSeconds = lastTickMs > 0 ? Math.round((Date.now() - lastTickMs) / 1000) : null

    // Health determination
    const grace = isInGracePeriod()
    const tickFresh = ageSeconds !== null && ageSeconds < HEARTBEAT_STALE_SECONDS
    const healthy = grace || tickFresh

    // Quorum health: healthy if no correlated anomaly and last check is recent
    const quorumOutliers = lastQuorum?.outliers?.filter(o => o.classification === 'flagged' || o.classification === 'correlated') ?? []
    const quorumHealthy = lastQuorum ? lastQuorum.correlatedOutlierCount === 0 : true // no data = assume ok

    const body: Record<string, unknown> = {
      lastTick: lastTickIso || null,
      tickCount: tickCount ?? 0,
      ageSeconds,
      healthy,
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
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    })
  } catch (err) {
    console.error('[HEARTBEAT] KV read failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'KV unavailable', healthy: false },
      { status: 500 },
    )
  }
}
