'use client'

import { useState, useMemo, useCallback } from 'react'
import { useAnalytics } from '@/hooks/useAnalytics'
import { AGGREGATOR_META, type AggregatorName } from '@/lib/constants'
import { scoreAllWallets, detectWalletClusters } from '@/lib/sybil-detector'
import { seedDemoData, clearAnalytics } from '@/lib/analytics-tracker'
import type { SybilScore, WalletCluster } from '@/lib/sybil-detector'
import type { DashboardData, PeriodMetrics, TradeEvent } from '@/lib/analytics-types'

// ══════════════════════════════════════════════════════════
//  ADMIN MONITOR v2 — Blockscout-inspired stats dashboard
//  Access: /admin?key=SECRET
// ══════════════════════════════════════════════════════════

// ── Helpers ──

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function sourceLabel(s: AggregatorName): string {
  return AGGREGATOR_META[s]?.label || s
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

type Period = 'all' | '24h' | '7d' | '30d'
type Tab = 'overview' | 'revenue' | 'sybil' | 'wallets' | 'activity' | 'tools'

/** Cutoff timestamp for the selected period */
function periodCutoff(p: Period): number {
  if (p === '24h') return Date.now() - 24 * 3600_000
  if (p === '7d') return Date.now() - 7 * 86400_000
  if (p === '30d') return Date.now() - 30 * 86400_000
  return 0 // 'all' → no filter
}

/** Filter trades by period */
function filterByPeriod(trades: TradeEvent[], p: Period): TradeEvent[] {
  if (p === 'all') return trades
  const cutoff = periodCutoff(p)
  return trades.filter(t => t.timestamp >= cutoff)
}

function periodMetrics(d: DashboardData, p: Period): PeriodMetrics {
  switch (p) {
    case '24h': return d.last24h
    case '7d': return d.last7d
    case '30d': return d.last30d
    default: return d.allTime
  }
}

// ══════════════════════════════════════════════════════════
//  REUSABLE COMPONENTS
// ══════════════════════════════════════════════════════════

// ── Stat Card (Blockscout-style) ──
function StatCard({ label, value, sub, color = '#4fc3f7', chart }: {
  label: string
  value: string
  sub?: string
  color?: string
  chart?: React.ReactNode
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-[#1a2332] bg-[#0c1018] p-4 transition-all hover:border-[#2a3a50]">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[#556677]">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums" style={{ color }}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-[#445566]">{sub}</div>}
      {chart && <div className="mt-3">{chart}</div>}
    </div>
  )
}

// ── Mini Sparkline (SVG) ──
function Sparkline({ data, color = '#4fc3f7', height = 32, fill = false }: {
  data: number[]
  color?: string
  height?: number
  fill?: boolean
}) {
  if (data.length < 2) return null
  const max = Math.max(...data, 1)
  const w = 100
  const points = data.map((v, i) => ({
    x: (i / (data.length - 1)) * w,
    y: height - (v / max) * (height - 4) - 2,
  }))
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const fillD = `${pathD} L${w},${height} L0,${height} Z`

  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
      {fill && <path d={fillD} fill={`${color}15`} />}
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Mini Bar Chart (SVG) ──
function MiniBarChart({ data, color = '#4fc3f7', height = 40, labels }: {
  data: number[]
  color?: string
  height?: number
  labels?: string[]
}) {
  if (data.length === 0) return null
  const max = Math.max(...data, 1)
  const gap = 1
  const barW = (100 - gap * (data.length - 1)) / data.length

  return (
    <div>
      <svg viewBox={`0 0 100 ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
        {data.map((v, i) => {
          const h = Math.max((v / max) * (height - 2), 1)
          return (
            <rect
              key={i}
              x={i * (barW + gap)}
              y={height - h}
              width={barW}
              height={h}
              rx={1}
              fill={color}
              opacity={0.7 + (v / max) * 0.3}
            />
          )
        })}
      </svg>
      {labels && (
        <div className="mt-1 flex justify-between text-[7px] tabular-nums text-[#445566]">
          <span>{labels[0]}</span>
          <span>{labels[labels.length - 1]}</span>
        </div>
      )}
    </div>
  )
}

// ── Donut Chart (SVG) ──
function DonutChart({ segments, size = 80 }: {
  segments: Array<{ value: number; color: string; label: string }>
  size?: number
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (total === 0) return null
  const r = 30
  const cx = size / 2
  const cy = size / 2
  let cumAngle = -90

  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {segments.map((seg, i) => {
          const pct = seg.value / total
          const angle = pct * 360
          const start = cumAngle
          cumAngle += angle
          const end = cumAngle
          const largeArc = angle > 180 ? 1 : 0
          const rad = (deg: number) => (deg * Math.PI) / 180
          const x1 = cx + r * Math.cos(rad(start))
          const y1 = cy + r * Math.sin(rad(start))
          const x2 = cx + r * Math.cos(rad(end))
          const y2 = cy + r * Math.sin(rad(end))
          const d = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z`
          return <path key={i} d={d} fill={seg.color} opacity={0.85} />
        })}
        <circle cx={cx} cy={cy} r={18} fill="#0c1018" />
      </svg>
      <div className="space-y-1">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[9px]">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: seg.color }} />
            <span className="text-[#778899]">{seg.label}</span>
            <span className="font-bold tabular-nums" style={{ color: seg.color }}>{((seg.value / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Heatmap Grid (small squares, horizontal) ──
function HeatmapGrid({ data, title }: {
  data: Array<{ label: string; value: number; tooltip?: string }>
  title: string
}) {
  const maxVal = Math.max(...data.map(d => d.value), 1)

  return (
    <div>
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[#556677]">{title}</div>
      <div className="flex flex-wrap gap-[3px]">
        {data.map((d, i) => {
          const intensity = d.value / maxVal
          return (
            <div
              key={i}
              className="group relative"
              title={d.tooltip || `${d.label}: ${d.value}`}
            >
              <div
                className="h-[18px] w-[18px] rounded-[3px] transition-transform hover:scale-125"
                style={{
                  backgroundColor: intensity > 0
                    ? `rgba(74, 222, 128, ${0.1 + intensity * 0.85})`
                    : 'rgba(26, 35, 50, 0.5)',
                }}
              />
              <span className="pointer-events-none absolute -top-6 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-[#1a2332] px-1.5 py-0.5 text-[8px] text-cream-50 shadow-lg group-hover:block">
                {d.label}: {typeof d.value === 'number' && d.value > 100 ? formatUsd(d.value) : d.value}
              </span>
            </div>
          )
        })}
      </div>
      {/* Legend */}
      <div className="mt-2 flex items-center gap-1 text-[8px] text-[#445566]">
        <span>Less</span>
        {[0.1, 0.3, 0.5, 0.7, 0.9].map(o => (
          <div key={o} className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: `rgba(74, 222, 128, ${o})` }} />
        ))}
        <span>More</span>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  TAB CONTENT VIEWS
// ══════════════════════════════════════════════════════════

// ── Overview Tab ──
function OverviewTab({ dashboard, metrics, period, allTrades }: {
  dashboard: DashboardData
  metrics: PeriodMetrics
  period: Period
  allTrades: TradeEvent[]
}) {
  const dailyData = useMemo(() => dashboard.dailyVolume.slice(-30), [dashboard.dailyVolume])
  const dailyVolumes = dailyData.map(d => d.volumeUsd)
  const dailyCounts = dailyData.map(d => d.tradeCount)

  // Daily fees
  const dailyFees = useMemo(() => {
    const feeMap = new Map<string, number>()
    for (const t of allTrades) {
      const day = new Date(t.timestamp).toISOString().slice(0, 10)
      feeMap.set(day, (feeMap.get(day) || 0) + t.feeUsd)
    }
    return [...feeMap.entries()].sort().slice(-30).map(([, v]) => v)
  }, [allTrades])

  // Daily unique wallets
  const dailyWallets = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const t of allTrades) {
      const day = new Date(t.timestamp).toISOString().slice(0, 10)
      if (!map.has(day)) map.set(day, new Set())
      map.get(day)!.add(t.wallet)
    }
    return [...map.entries()].sort().slice(-30).map(([, s]) => s.size)
  }, [allTrades])

  const avgTradeSize = metrics.tradeCount > 0 ? metrics.totalVolume / metrics.tradeCount : 0
  const feePerTrade = metrics.tradeCount > 0 ? metrics.totalFees / metrics.tradeCount : 0

  // Source donut
  const topSources = dashboard.bySource
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, 5)
  const sourceColors = ['#4fc3f7', '#4ADE80', '#FBBF24', '#A78BFA', '#F472B6']

  // Heatmap data
  const heatmapData = dashboard.byHour.map(h => ({
    label: `${h.hour}:00`,
    value: h.volumeUsd,
    tooltip: `${h.hour}:00 UTC — ${formatUsd(h.volumeUsd)} (${h.tradeCount} trades)`,
  }))

  return (
    <div className="space-y-5">
      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Total Volume" value={formatUsd(metrics.totalVolume)} color="#4ADE80"
          sub={period !== 'all' ? period : undefined} />
        <StatCard label="Total Fees" value={formatUsd(metrics.totalFees)} color="#FBBF24" />
        <StatCard label="Total Trades" value={metrics.tradeCount.toLocaleString()} color="#4fc3f7" />
        <StatCard label="Unique Wallets" value={metrics.uniqueWallets.toLocaleString()} color="#A78BFA" />
        <StatCard label="Avg Trade Size" value={formatUsd(avgTradeSize)} color="#F472B6" />
        <StatCard label="Fee / Trade" value={formatUsd(feePerTrade)} color="#FB923C" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <StatCard label="Daily Volume (30d)" value={formatUsd(metrics.totalVolume)} color="#4ADE80"
          chart={<MiniBarChart data={dailyVolumes} color="#4ADE80" height={60}
            labels={dailyData.length > 0 ? [dailyData[0].date.slice(5), dailyData[dailyData.length - 1].date.slice(5)] : undefined} />}
        />
        <StatCard label="Daily Trades (30d)" value={metrics.tradeCount.toLocaleString()} color="#4fc3f7"
          chart={<Sparkline data={dailyCounts} color="#4fc3f7" height={60} fill />}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <StatCard label="Daily Fees (30d)" value={formatUsd(metrics.totalFees)} color="#FBBF24"
          chart={<MiniBarChart data={dailyFees} color="#FBBF24" height={60} />}
        />
        <StatCard label="Active Wallets / Day" value={metrics.uniqueWallets.toLocaleString()} color="#A78BFA"
          chart={<Sparkline data={dailyWallets} color="#A78BFA" height={60} fill />}
        />
      </div>

      {/* Bottom Row: Source Distribution + Heatmap */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Volume by Source</div>
          <DonutChart
            segments={topSources.map((s, i) => ({
              value: s.volumeUsd,
              color: sourceColors[i] || '#556677',
              label: sourceLabel(s.source),
            }))}
          />
        </div>
        <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
          <HeatmapGrid data={heatmapData} title="Hourly Volume Heatmap (UTC)" />
        </div>
      </div>
    </div>
  )
}

// ── Revenue Tab ──
function RevenueTab({ dashboard, allTrades, period }: { dashboard: DashboardData; allTrades: TradeEvent[]; period: Period }) {
  // Compute totals from filtered trades
  const totalFees = useMemo(() => allTrades.reduce((s, t) => s + t.feeUsd, 0), [allTrades])
  const totalVolume = useMemo(() => allTrades.reduce((s, t) => s + t.volumeUsd, 0), [allTrades])
  const avgFeePerTrade = allTrades.length > 0 ? totalFees / allTrades.length : 0
  const feeRate = totalVolume > 0 ? (totalFees / totalVolume) * 100 : 0

  // Daily fees
  const dailyFees = useMemo(() => {
    const feeMap = new Map<string, number>()
    for (const t of allTrades) {
      const day = new Date(t.timestamp).toISOString().slice(0, 10)
      feeMap.set(day, (feeMap.get(day) || 0) + t.feeUsd)
    }
    return [...feeMap.entries()].sort().slice(-30)
  }, [allTrades])

  // Revenue by source
  const revenueBySource = useMemo(() => {
    const map = new Map<AggregatorName, number>()
    for (const t of allTrades) {
      map.set(t.source, (map.get(t.source) || 0) + t.feeUsd)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [allTrades])

  // Revenue by pair
  const revenueByPair = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of allTrades) {
      const pair = `${t.tokenIn}/${t.tokenOut}`
      map.set(pair, (map.get(pair) || 0) + t.feeUsd)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [allTrades])

  // Source economics from filtered trades
  const filteredBySource = useMemo(() => {
    const map = new Map<AggregatorName, { tradeCount: number; volumeUsd: number; feeUsd: number; wins: number }>()
    for (const t of allTrades) {
      const entry = map.get(t.source) || { tradeCount: 0, volumeUsd: 0, feeUsd: 0, wins: 0 }
      entry.tradeCount++
      entry.volumeUsd += t.volumeUsd
      entry.feeUsd += t.feeUsd
      entry.wins++
      map.set(t.source, entry)
    }
    return [...map.entries()]
      .map(([source, data]) => ({ source, ...data, winRate: allTrades.length > 0 ? (data.wins / allTrades.length) * 100 : 0 }))
      .sort((a, b) => b.volumeUsd - a.volumeUsd)
  }, [allTrades])

  const maxSourceFee = Math.max(...revenueBySource.map(([, v]) => v), 1)
  const maxPairFee = Math.max(...revenueByPair.map(([, v]) => v), 1)
  const periodLabel = period === 'all' ? 'All-time' : period.toUpperCase()

  return (
    <div className="space-y-5">
      {/* Period KPIs — dynamically from filtered trades */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={`Total Fees (${periodLabel})`} value={formatUsd(totalFees)} color="#FBBF24" />
        <StatCard label={`Volume (${periodLabel})`} value={formatUsd(totalVolume)} color="#4ADE80" />
        <StatCard label="Avg Fee / Trade" value={formatUsd(avgFeePerTrade)} color="#FB923C" />
        <StatCard label="Fee Rate" value={`${feeRate.toFixed(3)}%`} color="#A78BFA" sub={`${allTrades.length} trades`} />
      </div>

      {/* Daily Fees Chart */}
      <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
        <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Daily Revenue (30d)</div>
        <MiniBarChart
          data={dailyFees.map(([, v]) => v)}
          color="#FBBF24"
          height={80}
          labels={dailyFees.length > 0 ? [dailyFees[0][0].slice(5), dailyFees[dailyFees.length - 1][0].slice(5)] : undefined}
        />
      </div>

      {/* Revenue by Source + by Pair */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Revenue by Aggregator</div>
          <div className="space-y-2">
            {revenueBySource.map(([src, fee]) => (
              <div key={src}>
                <div className="mb-1 flex items-center justify-between text-[10px]">
                  <span className="text-cream-65">{sourceLabel(src)}</span>
                  <span className="font-bold text-[#FBBF24]">{formatUsd(fee)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#1a2332]">
                  <div className="h-full rounded-full bg-[#FBBF24] transition-all" style={{ width: `${(fee / maxSourceFee) * 100}%`, opacity: 0.7 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Revenue by Pair</div>
          <div className="space-y-2">
            {revenueByPair.map(([pair, fee]) => (
              <div key={pair}>
                <div className="mb-1 flex items-center justify-between text-[10px]">
                  <span className="text-cream-65">{pair}</span>
                  <span className="font-bold text-[#FBBF24]">{formatUsd(fee)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#1a2332]">
                  <div className="h-full rounded-full bg-[#FB923C] transition-all" style={{ width: `${(fee / maxPairFee) * 100}%`, opacity: 0.7 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Source Economics Table */}
      <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
        <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Source Economics</div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[10px]">
            <thead>
              <tr className="border-b border-[#1a2332] text-[9px] font-bold uppercase tracking-widest text-[#445566]">
                <th className="pb-2">Source</th>
                <th className="pb-2 text-right">Volume</th>
                <th className="pb-2 text-right">Trades</th>
                <th className="pb-2 text-right">Win Rate</th>
                <th className="pb-2 text-right">Avg/Trade</th>
                <th className="pb-2 text-right">Fees</th>
              </tr>
            </thead>
            <tbody>
              {filteredBySource.map(s => (
                <tr key={s.source} className="border-b border-[#0f1520] tabular-nums">
                  <td className="py-1.5 font-medium text-cream-65">{sourceLabel(s.source)}</td>
                  <td className="py-1.5 text-right text-[#4ADE80]">{formatUsd(s.volumeUsd)}</td>
                  <td className="py-1.5 text-right text-[#4fc3f7]">{s.tradeCount}</td>
                  <td className="py-1.5 text-right text-[#A78BFA]">{s.winRate.toFixed(0)}%</td>
                  <td className="py-1.5 text-right text-cream-50">{s.tradeCount > 0 ? formatUsd(s.volumeUsd / s.tradeCount) : '-'}</td>
                  <td className="py-1.5 text-right font-bold text-[#FBBF24]">
                    {formatUsd(s.feeUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Sybil Tab ──
function SybilTab({ scores, clusters }: { scores: SybilScore[]; clusters: WalletCluster[] }) {
  const sybils = scores.filter(s => s.verdict === 'likely_sybil')
  const suspicious = scores.filter(s => s.verdict === 'suspicious')
  const clean = scores.filter(s => s.verdict === 'clean')
  const verdictColor = { clean: '#4ADE80', suspicious: '#FBBF24', likely_sybil: '#EF4444' }

  return (
    <div className="space-y-5">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total Wallets" value={scores.length.toString()} color="#4fc3f7" />
        <StatCard label="Clean" value={clean.length.toString()} color="#4ADE80"
          sub={`${scores.length > 0 ? ((clean.length / scores.length) * 100).toFixed(0) : 0}%`} />
        <StatCard label="Suspicious" value={suspicious.length.toString()} color="#FBBF24"
          sub={`${scores.length > 0 ? ((suspicious.length / scores.length) * 100).toFixed(0) : 0}%`} />
        <StatCard label="Likely Sybil" value={sybils.length.toString()} color="#EF4444"
          sub={`${scores.length > 0 ? ((sybils.length / scores.length) * 100).toFixed(0) : 0}%`} />
      </div>

      {/* Distribution Donut */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Wallet Distribution</div>
          <DonutChart segments={[
            { value: clean.length, color: '#4ADE80', label: 'Clean' },
            { value: suspicious.length, color: '#FBBF24', label: 'Suspicious' },
            { value: sybils.length, color: '#EF4444', label: 'Likely Sybil' },
          ]} />
        </div>

        {/* Score Distribution Heatmap */}
        <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
          <HeatmapGrid
            data={scores.slice(0, 50).map(s => ({
              label: shortAddr(s.address),
              value: s.score,
              tooltip: `${shortAddr(s.address)}: Score ${s.score} (${s.verdict.replace('_', ' ')})`,
            }))}
            title="Sybil Score Heatmap (Top 50 Wallets)"
          />
        </div>
      </div>

      {/* Flagged Wallets Table */}
      <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
        <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Flagged Wallets</div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[10px]">
            <thead>
              <tr className="border-b border-[#1a2332] text-[9px] font-bold uppercase tracking-widest text-[#445566]">
                <th className="pb-2">Wallet</th>
                <th className="pb-2 text-right">Score</th>
                <th className="pb-2 text-right">Trades</th>
                <th className="pb-2 text-right">Volume</th>
                <th className="pb-2 text-right">Verdict</th>
                <th className="pb-2 text-right">Flags</th>
              </tr>
            </thead>
            <tbody>
              {scores.slice(0, 20).map(s => (
                <tr key={s.address} className="border-b border-[#0f1520] tabular-nums">
                  <td className="py-1.5 font-mono text-cream-50">{shortAddr(s.address)}</td>
                  <td className="py-1.5 text-right font-bold" style={{ color: verdictColor[s.verdict] }}>{s.score}</td>
                  <td className="py-1.5 text-right text-cream-50">{s.tradeCount}</td>
                  <td className="py-1.5 text-right text-cream-50">{formatUsd(s.totalVolumeUsd)}</td>
                  <td className="py-1.5 text-right">
                    <span className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase" style={{
                      color: verdictColor[s.verdict],
                      backgroundColor: `${verdictColor[s.verdict]}15`,
                    }}>
                      {s.verdict.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="py-1.5 text-right text-[#556677]">{s.flags.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Flag Details for Suspects */}
      {scores.filter(s => s.score > 0).slice(0, 5).map(s => (
        <div key={`flags-${s.address}`} className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-mono text-[11px] font-bold text-[#4fc3f7]">{shortAddr(s.address)}</span>
            <span className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase" style={{
              color: verdictColor[s.verdict],
              backgroundColor: `${verdictColor[s.verdict]}15`,
            }}>
              Score: {s.score}
            </span>
          </div>
          <div className="space-y-1">
            {s.flags.map((f, i) => (
              <div key={i} className="flex items-start gap-2 text-[10px]">
                <span className="mt-0.5 text-[#FBBF24]">▸</span>
                <span className="font-bold text-[#FBBF24]">{f.rule}</span>
                <span className="text-cream-50">— {f.details || f.description}</span>
                <span className="text-[#445566]">(+{f.weight.toFixed(0)})</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Wallet Clusters */}
      {clusters.length > 0 && (
        <div className="rounded-xl border border-[#EF4444]/20 bg-[#0c1018] p-4">
          <div className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#EF4444]">
            Wallet Clusters (Possible Same Entity)
          </div>
          <div className="space-y-2">
            {clusters.slice(0, 10).map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-[10px]">
                <span className="rounded bg-[#EF4444]/10 px-1.5 py-0.5 text-[8px] font-bold text-[#EF4444]">
                  {(c.confidence * 100).toFixed(0)}%
                </span>
                <span className="font-mono text-cream-50">
                  {c.wallets.map(w => shortAddr(w)).join(' ↔ ')}
                </span>
                <span className="text-[#445566]">— {c.sharedTimestamps} co-occurrences</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Wallets Tab ──
function WalletsTab({ dashboard, allTrades, period }: { dashboard: DashboardData; allTrades: TradeEvent[]; period: Period }) {
  // Wallet cohorts
  const cohorts = useMemo(() => {
    const map = new Map<string, { count: number; retained: number }>()
    const weekAgo = Date.now() - 7 * 86400_000
    for (const w of dashboard.wallets) {
      const day = new Date(w.firstSeen).toISOString().slice(0, 10)
      const entry = map.get(day) || { count: 0, retained: 0 }
      entry.count++
      if (w.lastSeen > weekAgo) entry.retained++
      map.set(day, entry)
    }
    return [...map.entries()].sort().slice(-14)
  }, [dashboard.wallets])

  // Top wallets by volume
  const topWallets = [...dashboard.wallets]
    .sort((a, b) => b.totalVolumeUsd - a.totalVolumeUsd)
    .slice(0, 15)

  const maxVol = Math.max(...topWallets.map(w => w.totalVolumeUsd), 1)

  // Computed from filtered trades
  const whaleCount = allTrades.filter(t => t.volumeUsd >= 10_000).length
  const uniqueWallets = useMemo(() => new Set(allTrades.map(t => t.wallet)).size, [allTrades])
  const totalVol = useMemo(() => allTrades.reduce((s, t) => s + t.volumeUsd, 0), [allTrades])
  const periodLabel = period === 'all' ? 'All-time' : period.toUpperCase()

  return (
    <div className="space-y-5">
      {/* Wallet KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={`Wallets (${periodLabel})`} value={uniqueWallets.toLocaleString()} color="#A78BFA" />
        <StatCard label={`Trades (${periodLabel})`} value={allTrades.length.toLocaleString()} color="#4fc3f7" />
        <StatCard label={`Volume (${periodLabel})`} value={formatUsd(totalVol)} color="#4ADE80" />
        <StatCard label="Whale Trades" value={whaleCount.toLocaleString()} color="#FBBF24" sub=">$10k" />
      </div>

      {/* Top Wallets + Cohorts */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* Top Wallets by Volume */}
        <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Top Wallets by Volume</div>
          <div className="space-y-2">
            {topWallets.map(w => (
              <div key={w.address}>
                <div className="mb-1 flex items-center justify-between text-[10px]">
                  <span className="font-mono text-cream-65">{shortAddr(w.address)}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-[#445566]">{w.tradeCount} trades</span>
                    <span className="font-bold text-[#4ADE80]">{formatUsd(w.totalVolumeUsd)}</span>
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-[#1a2332]">
                  <div className="h-full rounded-full bg-[#A78BFA]" style={{ width: `${(w.totalVolumeUsd / maxVol) * 100}%`, opacity: 0.7 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Wallet Cohorts */}
        <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Wallet Cohorts (First Seen)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[10px]">
              <thead>
                <tr className="border-b border-[#1a2332] text-[9px] font-bold uppercase tracking-widest text-[#445566]">
                  <th className="pb-2">Date</th>
                  <th className="pb-2 text-right">New</th>
                  <th className="pb-2 text-right">Active 7d</th>
                  <th className="pb-2 text-right">Retention</th>
                </tr>
              </thead>
              <tbody>
                {cohorts.map(([date, data]) => {
                  const retention = data.count > 0 ? (data.retained / data.count) * 100 : 0
                  return (
                    <tr key={date} className="border-b border-[#0f1520] tabular-nums">
                      <td className="py-1.5 text-cream-50">{date.slice(5)}</td>
                      <td className="py-1.5 text-right text-[#4fc3f7]">{data.count}</td>
                      <td className="py-1.5 text-right text-[#4ADE80]">{data.retained}</td>
                      <td className="py-1.5 text-right font-bold" style={{
                        color: retention >= 50 ? '#4ADE80' : retention >= 25 ? '#FBBF24' : '#EF4444',
                      }}>
                        {retention.toFixed(0)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Cohort sparkline */}
          <div className="mt-3">
            <Sparkline data={cohorts.map(([, d]) => d.count)} color="#4fc3f7" height={40} fill />
          </div>
        </div>
      </div>

      {/* Whale Alerts */}
      <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-[#556677]">Whale Alerts</div>
          <span className="rounded bg-[#FBBF24]/10 px-1.5 py-0.5 text-[8px] font-bold text-[#FBBF24]">&gt;$10k</span>
        </div>
        <div className="max-h-[240px] space-y-1 overflow-y-auto">
          {allTrades
            .filter(t => t.volumeUsd >= 10_000)
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 15)
            .map(t => (
              <div key={t.id} className="flex items-center justify-between text-[10px]">
                <span className="flex items-center gap-2">
                  <span className="text-[#FBBF24]">🐋</span>
                  <span className="font-mono text-cream-50">{shortAddr(t.wallet)}</span>
                  <span className="text-cream-50">{t.tokenIn}→{t.tokenOut}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-bold text-[#4ADE80]">{formatUsd(t.volumeUsd)}</span>
                  <span className="text-[#445566]">{timeAgo(t.timestamp)}</span>
                </span>
              </div>
            ))}
          {whaleCount === 0 && <div className="py-4 text-center text-[10px] text-[#445566]">No whale trades yet</div>}
        </div>
      </div>

      {/* Popular Pairs */}
      <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
        <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Top Pairs</div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {dashboard.topPairs.slice(0, 8).map(p => (
            <div key={p.pair} className="rounded-lg border border-[#1a2332] bg-[#080d14] p-2">
              <div className="text-[11px] font-bold text-cream-65">{p.pair}</div>
              <div className="mt-0.5 text-[10px] tabular-nums text-[#4fc3f7]">{p.tradeCount} trades</div>
              <div className="text-[9px] text-[#445566]">{formatUsd(p.volumeUsd)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Activity Tab ──
function ActivityTab({ trades, period }: { trades: TradeEvent[]; period: Period }) {
  const typeColor: Record<string, string> = {
    swap: '#4fc3f7', dca_buy: '#60A5FA', limit_fill: '#A78BFA', sltp_trigger: '#FB923C',
  }
  const typeLabel: Record<string, string> = {
    swap: 'SWAP', dca_buy: 'DCA', limit_fill: 'LIMIT', sltp_trigger: 'SL/TP',
  }

  return (
    <div className="space-y-5">
      {/* Trade type distribution */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Object.entries(typeLabel).map(([type, label]) => {
          const count = trades.filter(t => t.type === type).length
          const vol = trades.filter(t => t.type === type).reduce((s, t) => s + t.volumeUsd, 0)
          return (
            <StatCard
              key={type}
              label={label}
              value={count.toLocaleString()}
              sub={formatUsd(vol)}
              color={typeColor[type] || '#4fc3f7'}
            />
          )
        })}
      </div>

      {/* Live Feed */}
      <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-[#556677]">Trade Feed</div>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#4ADE80]" />
          <span className="text-[9px] text-[#445566]">Last 50</span>
        </div>
        <div className="max-h-[500px] space-y-0.5 overflow-y-auto">
          {trades.slice(0, 50).map(t => (
            <div key={t.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-[10px] transition-colors hover:bg-[#0f1520]">
              <span className="flex items-center gap-2">
                <span className="w-10 rounded px-1 py-0.5 text-center text-[8px] font-bold uppercase" style={{
                  color: typeColor[t.type] || '#4fc3f7',
                  backgroundColor: `${typeColor[t.type] || '#4fc3f7'}15`,
                }}>
                  {typeLabel[t.type] || t.type}
                </span>
                <span className="font-mono text-cream-50">{shortAddr(t.wallet)}</span>
                <span className="text-cream-65">{t.tokenIn || '?'} → {t.tokenOut || '?'}</span>
              </span>
              <span className="flex items-center gap-3">
                <span className="font-bold text-[#4ADE80]">{formatUsd(t.volumeUsd)}</span>
                <span className="text-[#556677]">{sourceLabel(t.source)}</span>
                <span className="w-8 text-right text-[#445566]">{timeAgo(t.timestamp)}</span>
                {t.txHash && (
                  <a href={`https://etherscan.io/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer"
                    className="text-[#334455] hover:text-[#4fc3f7]">↗</a>
                )}
              </span>
            </div>
          ))}
          {trades.length === 0 && <div className="py-8 text-center text-[10px] text-[#445566]">Waiting for trades...</div>}
        </div>
      </div>
    </div>
  )
}

// ── Tools Tab ──
function ToolsTab({ dashboard, sybilScores, exportSnapshot, onRefresh }: {
  dashboard: DashboardData
  sybilScores: SybilScore[]
  exportSnapshot: () => Array<{ address: string; tradeCount: number; totalVolumeUsd: number; firstSeen: string; lastSeen: string }>
  onRefresh: () => void
}) {
  const [seedStatus, setSeedStatus] = useState('')

  const downloadJson = useCallback((data: unknown, filename: string) => {
    const json = JSON.stringify(data, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const handleSeed = useCallback(() => {
    const count = seedDemoData(350)
    setSeedStatus(`Seeded ${count} trades`)
    onRefresh()
    setTimeout(() => setSeedStatus(''), 3000)
  }, [onRefresh])

  const handleClear = useCallback(() => {
    clearAnalytics()
    setSeedStatus('Data cleared')
    onRefresh()
    setTimeout(() => setSeedStatus(''), 3000)
  }, [onRefresh])

  return (
    <div className="space-y-5">
      {/* Demo Data — only visible in development */}
      {process.env.NODE_ENV === 'development' && (
      <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
        <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Demo Data</div>
        <div className="flex items-center gap-3">
          <button onClick={handleSeed}
            className="rounded-lg bg-[#FBBF24]/10 px-4 py-2 text-[11px] font-bold text-[#FBBF24] transition hover:bg-[#FBBF24]/20">
            Seed Demo Data (350 trades)
          </button>
          <button onClick={handleClear}
            className="rounded-lg bg-[#EF4444]/10 px-4 py-2 text-[11px] font-bold text-[#EF4444] transition hover:bg-[#EF4444]/20">
            Clear All Data
          </button>
          {seedStatus && <span className="text-[11px] font-bold text-[#4ADE80]">{seedStatus}</span>}
        </div>
      </div>
      )}

      {/* Export */}
      <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
        <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">Export Data</div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <button onClick={() => downloadJson(exportSnapshot(), `wallets-${Date.now()}.json`)}
            className="rounded-lg border border-[#4fc3f7]/20 bg-[#4fc3f7]/5 px-4 py-3 text-left transition hover:bg-[#4fc3f7]/10">
            <div className="text-[11px] font-bold text-[#4fc3f7]">Wallet Snapshot</div>
            <div className="mt-0.5 text-[9px] text-[#556677]">All wallets for airdrop</div>
          </button>
          <button onClick={() => {
            const clean = sybilScores.filter(s => s.verdict === 'clean').map(s => s.address)
            downloadJson(clean, `airdrop-eligible-${Date.now()}.json`)
          }}
            className="rounded-lg border border-[#4ADE80]/20 bg-[#4ADE80]/5 px-4 py-3 text-left transition hover:bg-[#4ADE80]/10">
            <div className="text-[11px] font-bold text-[#4ADE80]">Airdrop Eligible</div>
            <div className="mt-0.5 text-[9px] text-[#556677]">Only clean wallets</div>
          </button>
          <button onClick={() => downloadJson(sybilScores.filter(s => s.score > 0), `sybil-report-${Date.now()}.json`)}
            className="rounded-lg border border-[#EF4444]/20 bg-[#EF4444]/5 px-4 py-3 text-left transition hover:bg-[#EF4444]/10">
            <div className="text-[11px] font-bold text-[#EF4444]">Sybil Report</div>
            <div className="mt-0.5 text-[9px] text-[#556677]">All flagged wallets</div>
          </button>
          <button onClick={() => downloadJson(dashboard, `full-dashboard-${Date.now()}.json`)}
            className="rounded-lg border border-[#A78BFA]/20 bg-[#A78BFA]/5 px-4 py-3 text-left transition hover:bg-[#A78BFA]/10">
            <div className="text-[11px] font-bold text-[#A78BFA]">Full Data Dump</div>
            <div className="mt-0.5 text-[9px] text-[#556677]">Complete dashboard JSON</div>
          </button>
        </div>
      </div>

      {/* System Info */}
      <div className="rounded-xl border border-[#1a2332] bg-[#0c1018] p-4">
        <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#556677]">System Info</div>
        <div className="grid grid-cols-2 gap-2 text-[10px] lg:grid-cols-4">
          <div>
            <span className="text-[#445566]">Storage: </span>
            <span className="text-cream-65">localStorage</span>
          </div>
          <div>
            <span className="text-[#445566]">Total Events: </span>
            <span className="text-cream-65">{dashboard.allTime.tradeCount}</span>
          </div>
          <div>
            <span className="text-[#445566]">Wallets Tracked: </span>
            <span className="text-cream-65">{dashboard.totalWallets}</span>
          </div>
          <div>
            <span className="text-[#445566]">Refresh: </span>
            <span className="text-cream-65">30s auto</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  MAIN ADMIN MONITOR
// ══════════════════════════════════════════════════════════

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: '◫' },
  { id: 'revenue', label: 'Revenue', icon: '$' },
  { id: 'sybil', label: 'Sybil', icon: '⚠' },
  { id: 'wallets', label: 'Wallets', icon: '◈' },
  { id: 'activity', label: 'Activity', icon: '⚡' },
  { id: 'tools', label: 'Tools', icon: '⚙' },
]

export default function AdminMonitor() {
  const { dashboard, loading, exportSnapshot, refresh } = useAnalytics()
  const [period, setPeriod] = useState<Period>('all')
  const [activeTab, setActiveTab] = useState<Tab>('overview')

  const allTrades = useMemo(() => {
    if (!dashboard) return []
    return dashboard.recentTrades
  }, [dashboard])

  // Filtered trades based on selected period
  const filteredTrades = useMemo(() => {
    return filterByPeriod(allTrades, period)
  }, [allTrades, period])

  const sybilScores = useMemo(() => {
    if (!dashboard) return []
    return scoreAllWallets(dashboard.wallets, filteredTrades)
  }, [dashboard, filteredTrades])

  const clusters = useMemo(() => {
    return detectWalletClusters(filteredTrades)
  }, [filteredTrades])

  const metrics = useMemo(
    () => dashboard ? periodMetrics(dashboard, period) : null,
    [dashboard, period],
  )

  if (loading && !dashboard) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#060a10]">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#4fc3f7] border-t-transparent" />
          <span className="text-sm text-[#445566]">Loading admin monitor...</span>
        </div>
      </div>
    )
  }

  if (!dashboard) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#060a10]">
        <div className="text-center">
          <div className="text-sm text-[#445566]">No analytics data available.</div>
          {process.env.NODE_ENV === 'development' && (
          <button onClick={() => { seedDemoData(350); refresh() }}
            className="mt-3 rounded-lg bg-[#4fc3f7]/10 px-4 py-2 text-[11px] font-bold text-[#4fc3f7] transition hover:bg-[#4fc3f7]/20">
            Seed Demo Data
          </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#060a10]">
      {/* ─── Header ─── */}
      <div className="sticky top-0 z-20 border-b border-[#1a2332] bg-[#060a10]/95 backdrop-blur-sm">
        <div className="mx-auto max-w-[1400px] px-4">
          <div className="flex h-12 items-center justify-between">
            {/* Brand */}
            <div className="flex items-center gap-3">
              <span className="text-sm font-bold text-[#4fc3f7]">TERASWAP</span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-[#445566]">Admin</span>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#4ADE80]" title="Live" />
            </div>

            {/* Period Selector */}
            <div className="flex items-center gap-1 rounded-lg border border-[#1a2332] bg-[#0a0e14] p-0.5">
              {(['all', '24h', '7d', '30d'] as Period[]).map(p => (
                <button key={p} onClick={() => setPeriod(p)}
                  className={`rounded-md px-3 py-1 text-[10px] font-bold uppercase transition ${
                    period === p
                      ? 'bg-[#4fc3f7]/15 text-[#4fc3f7]'
                      : 'text-[#556677] hover:text-[#4fc3f7]'
                  }`}
                >
                  {p === 'all' ? 'ALL' : p}
                </button>
              ))}
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="-mb-px flex gap-0">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-[11px] font-medium transition ${
                  activeTab === tab.id
                    ? 'border-[#4fc3f7] text-[#4fc3f7]'
                    : 'border-transparent text-[#556677] hover:border-[#2a3a50] hover:text-cream-65'
                }`}
              >
                <span className="text-xs">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Content ─── */}
      <div className="mx-auto max-w-[1400px] px-4 py-5">
        {activeTab === 'overview' && metrics && (
          <OverviewTab dashboard={dashboard} metrics={metrics} period={period} allTrades={filteredTrades} />
        )}
        {activeTab === 'revenue' && (
          <RevenueTab dashboard={dashboard} allTrades={filteredTrades} period={period} />
        )}
        {activeTab === 'sybil' && (
          <SybilTab scores={sybilScores} clusters={clusters} />
        )}
        {activeTab === 'wallets' && (
          <WalletsTab dashboard={dashboard} allTrades={filteredTrades} period={period} />
        )}
        {activeTab === 'activity' && (
          <ActivityTab trades={filteredTrades} period={period} />
        )}
        {activeTab === 'tools' && (
          <ToolsTab dashboard={dashboard} sybilScores={sybilScores} exportSnapshot={exportSnapshot} onRefresh={refresh} />
        )}
      </div>

      {/* ─── Footer ─── */}
      <div className="border-t border-[#1a2332] py-3 text-center text-[9px] text-[#334455]">
        TeraSwap Admin Monitor · {dashboard.totalWallets} wallets · {dashboard.allTime.tradeCount} trades · Auto-refresh 30s
      </div>
    </div>
  )
}
