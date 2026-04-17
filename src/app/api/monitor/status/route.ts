/**
 * GET /api/monitor/status — Public source health data for the status page.
 *
 * No auth required. Returns a sanitised view of source states:
 *   - id, status, p95 latency, uptime %, last checked, last tick timestamp.
 *
 * Deliberately omits: thresholds, failure/success counts, disabled reasons,
 * alert history, operator actions, P0 reasons, KV keys, lock state.
 *
 * Cached at the edge for 30s (stale-while-revalidate 30s) so the status page
 * doesn't hammer KV on every visitor, while staying fresh enough for monitoring.
 *
 * @public — no auth, safe for external consumption.
 */

import { NextResponse } from 'next/server'
import { kv } from '@vercel/kv'
import { getAllStatuses } from '@/lib/source-state-machine'

export const dynamic = 'force-dynamic'

// ── Types ──────────────────────────────────────────────

interface PublicSourceStatus {
  id: string
  status: 'active' | 'degraded' | 'disabled'
  p95LatencyMs: number | null
  uptimePercent: number | null
  lastChecked: string | null
}

interface StatusResponse {
  healthy: boolean
  sources: PublicSourceStatus[]
  lastTick: string | null
  tickFresh: boolean
}

// ── Helpers ────────────────────────────────────────────

const HEARTBEAT_STALE_SECONDS = 180

function calcP95(history: number[]): number {
  if (history.length === 0) return 0
  const sorted = [...history].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]
}

// ── Route handler ──────────────────────────────────────

export async function GET(): Promise<NextResponse<StatusResponse | { error: string; healthy: false }>> {
  try {
    const [statuses, lastTickIso] = await Promise.all([
      getAllStatuses(),
      kv.get<string>('teraswap:monitor:lastTick'),
    ])

    const lastTickMs = lastTickIso ? new Date(lastTickIso).getTime() : 0
    const ageSeconds = lastTickMs > 0 ? Math.round((Date.now() - lastTickMs) / 1000) : null
    const tickFresh = ageSeconds !== null && ageSeconds < HEARTBEAT_STALE_SECONDS

    const sources: PublicSourceStatus[] = statuses.map(s => {
      const totalChecks = s.successCount + s.failureCount
      const p95 = calcP95(s.latencyHistory)

      return {
        id: s.id,
        status: s.state,
        p95LatencyMs: p95 > 0 ? Math.round(p95) : null,
        uptimePercent: totalChecks >= 10
          ? Math.round((s.successCount / totalChecks) * 1000) / 10 // 1 decimal
          : null,
        lastChecked: s.lastCheckAt > 0
          ? new Date(s.lastCheckAt).toISOString()
          : null,
      }
    })

    // Sort: active first, then degraded, then disabled; alphabetical within each group
    const stateOrder: Record<string, number> = { active: 0, degraded: 1, disabled: 2 }
    sources.sort((a, b) => {
      const orderDiff = (stateOrder[a.status] ?? 3) - (stateOrder[b.status] ?? 3)
      return orderDiff !== 0 ? orderDiff : a.id.localeCompare(b.id)
    })

    // Overall health: all sources active + tick fresh
    const hasDisabled = sources.some(s => s.status === 'disabled')
    const hasDegraded = sources.some(s => s.status === 'degraded')
    const healthy = tickFresh && !hasDisabled && !hasDegraded

    const body: StatusResponse = {
      healthy,
      sources,
      lastTick: lastTickIso || null,
      tickFresh,
    }

    return NextResponse.json(body, {
      status: 200,
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=30',
      },
    })
  } catch (err) {
    console.error('[STATUS-API] KV read failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'Status data temporarily unavailable', healthy: false as const },
      { status: 503 },
    )
  }
}
