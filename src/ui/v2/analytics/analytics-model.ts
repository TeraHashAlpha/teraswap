import { fmtUsd } from '@/lib/format'
import { AGGREGATOR_META, type AggregatorName } from '@/lib/constants'
import type { DashboardData, PeriodMetrics } from '@/lib/analytics-types'

/**
 * [ADR-025 / B9] Display helpers for the Analytics tab. PURE, and every one a line-for-line copy of what v1 computes in
 * `AnalyticsDashboard` / `PersonalDashboard` (those keep these private): the UI derives no aggregate v1 does not — the
 * server's `/api/analytics`, `/api/stats` and `/api/analytics/personal` answers are what is shown.
 */

export type Period = 'all' | '24h' | '7d' | '30d'
export const PERIODS: readonly Period[] = ['all', '24h', '7d', '30d']

/** v1: `p === 'all' ? 'All Time' : p.toUpperCase()` */
export function periodLabel(p: Period): string {
  return p === 'all' ? 'All Time' : p.toUpperCase()
}

export function periodMetrics(d: DashboardData, p: Period): PeriodMetrics {
  switch (p) {
    case '24h': return d.last24h
    case '7d': return d.last7d
    case '30d': return d.last30d
    default: return d.allTime
  }
}

export function formatUsd(n: number): string {
  return fmtUsd(n, { compact: true })
}

/** v1 `sourceLabel` (AnalyticsDashboard: `|| s`; PublicProtocolStats / PersonalDashboard: `?? s` — the labels are never empty, so one rule). */
export function sourceLabel(s: string): string {
  return AGGREGATOR_META[s as AggregatorName]?.label || s
}

/** v1 `timeAgo`: the Recent Activity age, from a ms timestamp. */
export function timeAgo(ts: number, now: number): string {
  const diff = now - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** v1's Recent Activity type words and (v2 tokens instead of v1's blue / purple / orange) their tone. */
export const ACTIVITY_LABEL: Record<string, string> = { swap: 'Swap', dca_buy: 'DCA Buy', limit_fill: 'Limit Fill', sltp_trigger: 'SL/TP' }
export const ACTIVITY_TONE: Record<string, string> = {
  swap: 'text-v2-text',
  dca_buy: 'text-v2-teal',
  limit_fill: 'text-v2-cream',
  sltp_trigger: 'text-v2-amber',
}

/** v1 DailyVolumeChart: bar height as a % of the tallest day, never under 2 %. */
export function barHeightPct(volumeUsd: number, maxVolumeUsd: number): number {
  return Math.max((volumeUsd / maxVolumeUsd) * 100, 2)
}

/** v1's per-bar tooltip, verbatim: `{date}: {usd} ({n} trades)`. */
export function barTitle(d: DashboardData['dailyVolume'][number]): string {
  return `${d.date}: ${formatUsd(d.volumeUsd)} (${d.tradeCount} trades)`
}

// ── PersonalDashboard ("When you trade") ──
export const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function formatHourUtc(h: number): string {
  const suffix = h >= 12 ? 'pm' : 'am'
  const display = h % 12 === 0 ? 12 : h % 12
  return `${display}${suffix} UTC`
}
