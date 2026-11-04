'use client'

import Link from 'next/link'
import { fmtInt, fmtPct } from '@/lib/format'
import { usePersonalAnalytics } from '@/hooks/usePersonalAnalytics'
import { Skeleton } from '../primitives'
import { DAY_LABELS, formatHourUtc, formatUsd, sourceLabel } from './analytics-model'

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="ts-an-cap">{label}</div>
      <div className="ts-an-value ts-an-value--sm">{value}</div>
      {sub && <div className="ts-an-sub mt-1">{sub}</div>}
    </div>
  )
}

/** v1 `SourceWinRates`: the five best sources by share of confirmed swaps; the leader is the highlighted bar. */
function SourceWinRates({ rates }: { rates: Record<string, number> }) {
  const entries = Object.entries(rates).sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (entries.length === 0) return null
  return (
    <div>
      <h3 className="ts-an-cap mb-2">Your Top Sources</h3>
      {entries.map(([source, pct], i) => (
        <div key={source} className="ts-an-rank">
          <span className="ts-an-rank-n">{i + 1}</span>
          <div className="ts-an-rank-main">
            <div className="ts-an-rank-line">
              <span className="ts-an-rank-label">{sourceLabel(source)}</span>
              <span className="ts-an-rank-fig">{fmtPct(pct, 1)}</span>
            </div>
            <div className="ts-an-track" aria-hidden="true">
              <div className="ts-an-fill" data-lead={i === 0 ? '' : undefined} style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function TopPairs({ pairs }: { pairs: { pair: string; count: number; volumeUsd: number }[] }) {
  if (pairs.length === 0) return null
  return (
    <div>
      <h3 className="ts-an-cap mb-2">Most-Traded Pairs</h3>
      {pairs.map((p, i) => (
        <div key={p.pair} className="ts-an-pairs">
          <span className="flex items-baseline gap-3">
            <span className="ts-an-rank-n">{i + 1}</span>
            <span className="ts-an-rank-label">{p.pair}</span>
          </span>
          <span className="ts-an-rank-fig flex gap-4">
            <span>{p.count} swaps</span>
            <span className="text-v2-text">{formatUsd(p.volumeUsd)}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * [B9] v1 `PersonalDashboard` (the `/analytics` page's second block, only for a connected wallet — the page gates it, so the "Connect a
 * wallet" card inside v1's component is never reached there and the shell's own Connect button owns that). The read is v1's
 * `usePersonalAnalytics` (the wallet's `/api/analytics/personal`, no polling); the states are v1's, word for word: skeleton, "Failed to
 * load analytics: …", "No swaps yet", then My Analytics with its four figures, Your Top Sources, Most-Traded Pairs and — from 10
 * swaps — "When you trade".
 */
export function PersonalStats() {
  const { data, isLoading, error } = usePersonalAnalytics()

  if (isLoading && !data) {
    return (
      <section aria-label="My Analytics" aria-busy="true" data-testid="personal-loading" className="ts-an-section">
        <div className="ts-an-kpis ts-an-kpis--4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={88} />)}</div>
        <div className="ts-an-cols mt-8">
          <Skeleton height={180} />
          <Skeleton height={180} />
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <section aria-label="My Analytics" className="ts-an-section">
        <p className="ts-an-error" role="alert" data-testid="personal-error">Failed to load analytics: {error}</p>
      </section>
    )
  }

  if (!data || data.totalSwaps === 0) {
    return (
      <section aria-label="My Analytics" className="ts-an-section" data-testid="personal-empty">
        <div className="ts-an-empty">
          <p className="text-[18px] font-semibold text-v2-text">No swaps yet</p>
          <p className="mt-2 text-[14px] text-v2-muted">Make your first swap to see your personal analytics here.</p>
          <Link
            href="/"
            className="mt-5 inline-flex min-h-[46px] items-center bg-v2-cream px-5 font-v2-mono text-[13px] font-bold uppercase tracking-[1.5px] text-v2-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
          >
            Swap Now
          </Link>
        </div>
      </section>
    )
  }

  const showTiming = data.totalSwaps >= 10 && data.bestHour !== null && data.bestDayOfWeek !== null

  return (
    <section aria-labelledby="ts-an-personal-h" className="ts-an-section" data-testid="personal">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="ts-an-personal-h" className="font-v2-display text-[34px] font-bold uppercase leading-none tracking-[0.5px] text-v2-text">My Analytics</h2>
          <p className="ts-an-sub mt-2">
            Aggregated across {data.totalSwaps} swap{data.totalSwaps === 1 ? '' : 's'}
            {data.periodStart ? ` since ${data.periodStart.slice(0, 10)}` : ''}
          </p>
        </div>
        <a href={`/api/analytics/export?wallet=${data.wallet}&format=csv`} className="ts-an-action text-v2-text" data-testid="personal-export">Export CSV</a>
      </header>

      <div className="ts-an-kpis ts-an-kpis--4 mt-6">
        <Kpi label="Total Swaps" value={fmtInt(data.totalSwaps)} />
        <Kpi label="Total Volume" value={formatUsd(data.totalVolumeUsd)} />
        <Kpi label="Gas Saved" value={formatUsd(data.totalGasSavedUsd)} sub={`${data.gaslessSwapCount} gasless swap${data.gaslessSwapCount === 1 ? '' : 's'}`} />
        <Kpi label="Gasless Ratio" value={fmtPct(data.gaslessRatio * 100, 1)} sub={`${data.gaslessSwapCount} / ${data.totalSwaps}`} />
      </div>

      <div className="ts-an-cols mt-8">
        <SourceWinRates rates={data.sourceWinRates} />
        <TopPairs pairs={data.topPairs} />
      </div>

      {showTiming && (
        <div className="mt-8">
          <h3 className="ts-an-cap mb-2">When you trade</h3>
          <p className="text-[15px] text-v2-muted">
            You trade most on <span className="font-semibold text-v2-text">{DAY_LABELS[data.bestDayOfWeek!]}s</span> around{' '}
            <span className="font-semibold text-v2-text">{formatHourUtc(data.bestHour!)}</span>.
          </p>
        </div>
      )}
    </section>
  )
}
