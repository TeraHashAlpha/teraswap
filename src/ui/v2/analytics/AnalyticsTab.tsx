'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { fmtInt, fmtPct } from '@/lib/format'
import { useAnalytics } from '@/hooks/useAnalytics'
import { explorerTxUrl } from '@/lib/chains/tokens'
import type { DashboardData } from '@/lib/analytics-types'
import { Segmented } from '../primitives'
import {
  ACTIVITY_LABEL,
  ACTIVITY_TONE,
  PERIODS,
  barHeightPct,
  barTitle,
  formatUsd,
  periodLabel,
  periodMetrics,
  sourceLabel,
  timeAgo,
  type Period,
} from './analytics-model'
import { PersonalStats } from './PersonalStats'
import { PublicStats } from './PublicStats'
import { usePublicStats } from './use-public-stats'
import './analytics.css'

function Kpi({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div data-testid={testId}>
      <div className="ts-an-cap">{label}</div>
      <div className="ts-an-value">{value}</div>
      {sub && <div className="ts-an-sub mt-1">{sub}</div>}
    </div>
  )
}

/** v1 BestSources: the top three by win rate; the leader's bar is the highlighted one. */
function BestRoutes({ data }: { data: DashboardData['bySource'] }) {
  const top3 = data.slice(0, 3)
  if (top3.length === 0) return null
  return (
    <div data-testid="best-routes">
      <h3 className="ts-an-cap mb-2">Best Routes</h3>
      {top3.map((s, i) => (
        <div key={s.source} className="ts-an-rank">
          <span className="ts-an-rank-n">{i + 1}</span>
          <div className="ts-an-rank-main">
            <div className="ts-an-rank-line">
              <span className="ts-an-rank-label">{sourceLabel(s.source)}</span>
              <span className="ts-an-rank-fig">{fmtPct(s.winRate, 0)} win rate</span>
            </div>
            <div className="ts-an-track" aria-hidden="true">
              <div className="ts-an-fill" data-lead={i === 0 ? '' : undefined} style={{ width: `${s.winRate}%` }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** v1 PopularPairs: ranked (and cut to the top 6) by volume — it prints the volume it is ranked by; trades stay in the tooltip. */
function PopularPairs({ data }: { data: DashboardData['topPairs'] }) {
  if (data.length === 0) return null
  return (
    <div data-testid="popular-pairs">
      <h3 className="ts-an-cap mb-2">Popular Pairs</h3>
      {data.slice(0, 6).map((p, i) => (
        <div key={p.pair} className="ts-an-pairs" title={`${p.tradeCount} trades`}>
          <span className="flex items-baseline gap-3">
            <span className="ts-an-rank-n">{i + 1}</span>
            <span className="ts-an-rank-label">{p.pair}</span>
          </span>
          <span className="ts-an-rank-fig">{formatUsd(p.volumeUsd)}</span>
        </div>
      ))}
    </div>
  )
}

/** v1 DailyVolumeChart: one bar per day (oldest → newest), first and last date under it, v1's tooltip on each bar. */
function VolumeTrend({ data }: { data: DashboardData['dailyVolume'] }) {
  const maxVol = Math.max(...data.map((d) => d.volumeUsd), 1)
  if (data.length === 0) return null
  return (
    <div data-testid="volume-trend">
      <h3 className="ts-an-cap mb-3">Volume Trend (30d)</h3>
      <div className="ts-an-bars">
        {data.map((d, i) => (
          <div key={`${d.date}-${i}`} className="ts-an-bar" style={{ height: `${barHeightPct(d.volumeUsd, maxVol)}%` }} title={barTitle(d)} />
        ))}
      </div>
      <div className="ts-an-axis">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  )
}

/** v1 ActivityFeed: the latest ten, no wallet addresses; the type word, the pair (or "Trade executed"), the source, the age and the tx link. */
function RecentActivity({ trades, now }: { trades: DashboardData['recentTrades']; now: number }) {
  return (
    <div data-testid="recent-activity">
      <h3 className="ts-an-cap mb-2">Recent Activity</h3>
      {trades.slice(0, 10).map((t) => (
        <div key={t.id} className="ts-an-act" data-testid="activity-row">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <span className={`font-v2-mono text-[12px] font-semibold ${ACTIVITY_TONE[t.type] || 'text-v2-muted'}`}>{ACTIVITY_LABEL[t.type] || t.type}</span>
            {t.tokenIn && t.tokenOut ? (
              <span className="text-v2-text">{t.tokenIn} → {t.tokenOut}</span>
            ) : (
              <span className="text-v2-dim">Trade executed</span>
            )}
          </span>
          <span className="flex items-center gap-3 text-v2-muted">
            <span>{sourceLabel(t.source)}</span>
            <span>{timeAgo(t.timestamp, now)}</span>
            {t.txHash && (
              <a href={explorerTxUrl(t.txHash, t.chainId)} target="_blank" rel="noopener noreferrer" title="View transaction" aria-label="View transaction" className="ts-an-act-link" data-an-link="">↗</a>
            )}
          </span>
        </div>
      ))}
      {trades.length === 0 && (
        <div className="ts-an-empty text-[13px] text-v2-dim" data-testid="activity-empty">No trades recorded yet. Execute a swap to see activity here.</div>
      )}
    </div>
  )
}

/**
 * [ADR-025 / B9] The Analytics tab (round7 50) — v1's two Analytics surfaces on the one v2 `/analytics` page, in v1's order, every word and
 * figure from v1's reads (`useAnalytics` for the tab, `/api/stats` for Gasless Adoption and Protocol performance, `usePersonalAnalytics` for
 * My Analytics): period selector, the three KPIs, Gasless Adoption (once there is a gasless swap), Best Routes + Popular Pairs, Volume Trend,
 * Recent Activity — v1 `AnalyticsDashboard` — then Protocol performance and, for a connected wallet, My Analytics (v1's `/analytics` page).
 * Nothing here polls beyond v1: `useAnalytics` keeps its own 30 s refresh, the other two reads happen once.
 */
export function AnalyticsTab() {
  const { dashboard, loading } = useAnalytics()
  const [period, setPeriod] = useState<Period>('all')
  const stats = usePublicStats()
  const { isConnected } = useAccount()
  const metrics = useMemo(() => (dashboard ? periodMetrics(dashboard, period) : null), [dashboard, period])
  // "time ago" is measured from the instant the figures arrived (v1 reads Date.now() while rendering; its figures only change on a refresh too).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setTimeout(() => setNow(Date.now()), 0) // one tick after each refresh lands — a clock stamp, not a poll or a request
    return () => clearTimeout(id)
  }, [dashboard])
  const gasless = stats.payload?.gasless

  let tab: React.ReactNode = null
  if (loading && !dashboard) {
    tab = (
      <div className="flex items-center justify-center py-20" data-testid="analytics-loading">
        <div className="text-[14px] text-v2-muted">Loading analytics...</div>
      </div>
    )
  } else if (dashboard) {
    tab = (
      <>
        <div className="ts-an-section" data-testid="analytics-period">
          <Segmented
            label="Period"
            active={period}
            onSelect={(id) => setPeriod(id as Period)}
            tabs={PERIODS.map((p) => ({ id: p, label: periodLabel(p) }))}
          />
        </div>

        {metrics && (
          <div className="ts-an-section ts-an-kpis" data-testid="analytics-kpis">
            <Kpi label="Protocol Volume" value={formatUsd(metrics.totalVolume)} sub={`${metrics.tradeCount} trades`} />
            <Kpi label="Users" value={metrics.uniqueWallets.toString()} sub="unique wallets" />
            <Kpi label="Avg Trade" value={metrics.tradeCount > 0 ? formatUsd(metrics.totalVolume / metrics.tradeCount) : '$0'} />
          </div>
        )}

        {gasless && (gasless.totalGaslessSwaps ?? 0) > 0 && (
          <div className="ts-an-section" data-testid="gasless-adoption">
            <h3 className="mb-4 flex items-center gap-2 ts-an-cap">
              <span aria-hidden="true">&#9889;</span>
              Gasless Adoption
            </h3>
            <div className="ts-an-kpis ts-an-kpis--4">
              <Kpi label="Gasless Swaps" value={fmtInt(gasless.totalGaslessSwaps)} sub={`${fmtPct((gasless.gaslessRatio ?? 0) * 100, 1)} of all swaps`} />
              <Kpi label="Total Gas Saved" value={formatUsd(gasless.totalGasSavedUsd ?? 0)} />
              <Kpi label="Avg per Swap" value={formatUsd(gasless.avgGasSavingsPerSwap ?? 0)} />
              <Kpi label="Adoption" value={fmtPct((gasless.gaslessRatio ?? 0) * 100, 0)} sub="of completed swaps" />
            </div>
          </div>
        )}

        {(dashboard.bySource.length > 0 || dashboard.topPairs.length > 0) && (
          <div className="ts-an-section ts-an-cols">
            <BestRoutes data={dashboard.bySource} />
            <PopularPairs data={dashboard.topPairs} />
          </div>
        )}

        {dashboard.dailyVolume.length > 0 && (
          <div className="ts-an-section">
            <VolumeTrend data={dashboard.dailyVolume} />
          </div>
        )}

        <div className="ts-an-section">
          <RecentActivity trades={dashboard.recentTrades} now={now} />
        </div>
      </>
    )
  }

  return (
    <div className="ts-analytics" data-testid="analytics">
      {tab}
      <PublicStats {...stats} />
      {isConnected && <PersonalStats />}
    </div>
  )
}
