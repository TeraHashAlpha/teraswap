'use client'

import { useState, useMemo } from 'react'
import { useAnalytics } from '@/hooks/useAnalytics'
import { AGGREGATOR_META, ETHERSCAN_TX, type AggregatorName } from '@/lib/constants'
import type { DashboardData, PeriodMetrics } from '@/lib/analytics-types'

// ── Helpers ──

type Period = 'all' | '24h' | '7d' | '30d'

function periodMetrics(d: DashboardData, p: Period): PeriodMetrics {
  switch (p) {
    case '24h': return d.last24h
    case '7d': return d.last7d
    case '30d': return d.last30d
    default: return d.allTime
  }
}

function sourceLabel(s: AggregatorName): string {
  return AGGREGATOR_META[s]?.label || s
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Stat Card ──
function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-cream-35">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-cream">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-cream-35">{sub}</div>}
    </div>
  )
}

// ── Best Source Indicator ──
function BestSources({ data }: { data: DashboardData['bySource'] }) {
  const top3 = data.slice(0, 3)
  if (top3.length === 0) return null

  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
      <h3 className="mb-3 text-xs font-semibold text-cream-65">Best Routes</h3>
      <div className="space-y-3">
        {top3.map((s, i) => (
          <div key={s.source} className="flex items-center gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
              style={{
                background: i === 0 ? 'rgba(74,222,128,0.15)' : 'rgba(200,184,154,0.08)',
                color: i === 0 ? '#4ADE80' : 'rgba(200,184,154,0.5)',
                border: `1px solid ${i === 0 ? 'rgba(74,222,128,0.3)' : 'rgba(200,184,154,0.12)'}`,
              }}
            >
              {i + 1}
            </span>
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-cream-65">{sourceLabel(s.source)}</span>
                <span className="tabular-nums text-cream-50">{s.winRate.toFixed(0)}% win rate</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-cream-08">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${s.winRate}%`,
                    backgroundColor: i === 0 ? '#4ADE80' : 'rgba(200,184,154,0.3)',
                  }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Activity Feed (simplified: no wallet addresses, no internal details) ──
function ActivityFeed({ trades }: { trades: DashboardData['recentTrades'] }) {
  const typeLabel: Record<string, string> = {
    swap: 'Swap', dca_buy: 'DCA Buy', limit_fill: 'Limit Fill', sltp_trigger: 'SL/TP',
  }
  const typeColor: Record<string, string> = {
    swap: 'text-cream-65', dca_buy: 'text-blue-400', limit_fill: 'text-purple-400', sltp_trigger: 'text-orange-400',
  }

  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
      <h3 className="mb-3 text-xs font-semibold text-cream-65">Recent Activity</h3>
      <div className="space-y-1.5">
        {trades.slice(0, 10).map((t) => (
          <div key={t.id} className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-2">
              <span className={`font-semibold ${typeColor[t.type] || 'text-cream-50'}`}>
                {typeLabel[t.type] || t.type}
              </span>
              {t.tokenIn && t.tokenOut ? (
                <span className="text-cream-50">{t.tokenIn} → {t.tokenOut}</span>
              ) : (
                <span className="text-cream-35">Trade executed</span>
              )}
            </span>
            <span className="flex items-center gap-2 text-cream-35">
              <span>{sourceLabel(t.source)}</span>
              <span>{timeAgo(t.timestamp)}</span>
              {t.txHash && (
                <a href={`${ETHERSCAN_TX}${t.txHash}`} target="_blank" rel="noopener noreferrer"
                  className="text-cream-35 transition hover:text-cream" title="View on Etherscan">↗</a>
              )}
            </span>
          </div>
        ))}
        {trades.length === 0 && (
          <div className="py-6 text-center text-xs text-cream-35">
            No trades recorded yet. Execute a swap to see activity here.
          </div>
        )}
      </div>
    </div>
  )
}

// ── Top Pairs ──
function PopularPairs({ data }: { data: DashboardData['topPairs'] }) {
  if (data.length === 0) return null
  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
      <h3 className="mb-3 text-xs font-semibold text-cream-65">Popular Pairs</h3>
      <div className="space-y-1.5">
        {data.slice(0, 6).map((p, i) => (
          <div key={p.pair} className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-2">
              <span className="w-4 text-right tabular-nums text-cream-35">{i + 1}</span>
              <span className="font-medium text-cream-65">{p.pair}</span>
            </span>
            <span className="tabular-nums text-cream-50">{p.tradeCount} trades</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Daily Volume Mini Chart ──
function DailyVolumeChart({ data }: { data: DashboardData['dailyVolume'] }) {
  const maxVol = Math.max(...data.map(d => d.volumeUsd), 1)
  if (data.length === 0) return null

  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
      <h3 className="mb-3 text-xs font-semibold text-cream-65">Volume Trend (30d)</h3>
      <div className="flex items-end gap-0.5" style={{ height: 64 }}>
        {data.map((d, i) => (
          <div key={`${d.date}-${i}`}
            className="flex-1 rounded-t-sm bg-success/40 transition-all hover:bg-success/60"
            style={{ height: `${Math.max((d.volumeUsd / maxVol) * 100, 2)}%` }}
            title={`${d.date}: ${formatUsd(d.volumeUsd)} (${d.tradeCount} trades)`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[8px] text-cream-35">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  PUBLIC ANALYTICS DASHBOARD
//  User-facing: protocol performance, best routes, activity
// ══════════════════════════════════════════════════════════

export default function AnalyticsDashboard() {
  const { dashboard, loading } = useAnalytics()
  const [period, setPeriod] = useState<Period>('all')

  const metrics = useMemo(
    () => dashboard ? periodMetrics(dashboard, period) : null,
    [dashboard, period],
  )

  if (loading && !dashboard) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-cream-35">Loading analytics...</div>
      </div>
    )
  }

  if (!dashboard) return null

  return (
    <div className="space-y-4">
      {/* Period Selector */}
      <div className="flex items-center gap-1.5">
        {(['all', '24h', '7d', '30d'] as Period[]).map((p) => (
          <button key={p} onClick={() => setPeriod(p)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              period === p
                ? 'bg-cream/10 text-cream'
                : 'text-cream-35 hover:bg-cream-08 hover:text-cream-65'
            }`}
          >
            {p === 'all' ? 'All Time' : p.toUpperCase()}
          </button>
        ))}
      </div>

      {/* KPI Cards — user-relevant only */}
      {metrics && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard
            label="Protocol Volume"
            value={formatUsd(metrics.totalVolume)}
            sub={`${metrics.tradeCount} trades`}
          />
          <StatCard
            label="Users"
            value={metrics.uniqueWallets.toString()}
            sub="unique wallets"
          />
          <StatCard
            label="Avg Trade"
            value={metrics.tradeCount > 0 ? formatUsd(metrics.totalVolume / metrics.tradeCount) : '$0'}
          />
        </div>
      )}

      {/* Best Sources + Popular Pairs */}
      <div className="grid gap-3 md:grid-cols-2">
        <BestSources data={dashboard.bySource} />
        <PopularPairs data={dashboard.topPairs} />
      </div>

      {/* Volume Trend */}
      <DailyVolumeChart data={dashboard.dailyVolume} />

      {/* Recent Activity */}
      <ActivityFeed trades={dashboard.recentTrades} />
    </div>
  )
}
