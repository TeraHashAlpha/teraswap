'use client'

/**
 * [P99] Per-wallet swap analytics dashboard.
 *
 * Sister component to AnalyticsDashboard (which is protocol-wide); this
 * one shows ONLY the connected wallet's swaps and is rendered on
 * /analytics. The data hook caches at /api/analytics/personal so the
 * component can mount/unmount without re-running the aggregation.
 */

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import Link from 'next/link'
import { usePersonalAnalytics } from '@/hooks/usePersonalAnalytics'
import { AGGREGATOR_META, type AggregatorName } from '@/lib/constants'

// ── helpers ────────────────────────────────────────────

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function formatHourUtc(h: number): string {
  const suffix = h >= 12 ? 'pm' : 'am'
  const display = h % 12 === 0 ? 12 : h % 12
  return `${display}${suffix} UTC`
}

function sourceLabel(s: string): string {
  return AGGREGATOR_META[s as AggregatorName]?.label ?? s
}

// ── stat card ──────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-cream-35">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-cream">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-cream-35">{sub}</div>}
    </div>
  )
}

// ── source bar chart ───────────────────────────────────

function SourceWinRates({ rates }: { rates: Record<string, number> }) {
  const entries = Object.entries(rates)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  if (entries.length === 0) return null

  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
      <h3 className="mb-3 text-xs font-semibold text-cream-65">Your Top Sources</h3>
      <div className="space-y-2.5">
        {entries.map(([source, pct], i) => (
          <div key={source} className="flex items-center gap-3">
            <span className="w-4 text-right text-[10px] tabular-nums text-cream-35">{i + 1}</span>
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-cream-65">{sourceLabel(source)}</span>
                <span className="tabular-nums text-cream-50">{pct.toFixed(1)}%</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-cream-08">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${pct}%`,
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

// ── top pairs ──────────────────────────────────────────

function TopPairs({ pairs }: { pairs: { pair: string; count: number; volumeUsd: number }[] }) {
  if (pairs.length === 0) return null
  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
      <h3 className="mb-3 text-xs font-semibold text-cream-65">Most-Traded Pairs</h3>
      <div className="space-y-1.5">
        {pairs.map((p, i) => (
          <div key={p.pair} className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-2">
              <span className="w-4 text-right tabular-nums text-cream-35">{i + 1}</span>
              <span className="font-medium text-cream-65">{p.pair}</span>
            </span>
            <span className="flex gap-3 tabular-nums text-cream-50">
              <span>{p.count} swaps</span>
              <span className="text-cream-65">{formatUsd(p.volumeUsd)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── skeleton ───────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[88px] animate-pulse rounded-xl border border-cream-08 bg-cream-08/40" />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="h-[180px] animate-pulse rounded-xl border border-cream-08 bg-cream-08/40" />
        <div className="h-[180px] animate-pulse rounded-xl border border-cream-08 bg-cream-08/40" />
      </div>
    </div>
  )
}

// ── empty state ────────────────────────────────────────

function EmptyState() {
  return (
    <div className="rounded-2xl border border-cream-08 bg-surface-tertiary p-10 text-center">
      <p className="text-base font-semibold text-cream">No swaps yet</p>
      <p className="mt-2 text-sm text-cream-50">
        Make your first swap to see your personal analytics here.
      </p>
      <Link
        href="/"
        className="mt-4 inline-block rounded-full border border-cream-gold px-5 py-2 text-[12px] font-semibold uppercase tracking-wider text-cream transition hover:bg-cream-gold hover:text-[#080B10]"
      >
        Swap Now
      </Link>
    </div>
  )
}

// ── main ───────────────────────────────────────────────

export default function PersonalDashboard() {
  const { isConnected } = useAccount()
  const { data, isLoading, error } = usePersonalAnalytics()

  if (!isConnected) {
    return (
      <div className="rounded-2xl border border-cream-08 bg-surface-tertiary p-10 text-center">
        <p className="text-base font-semibold text-cream">Connect a wallet to see your analytics</p>
        <p className="mt-2 mb-5 text-sm text-cream-50">
          Your personal dashboard shows your total volume, gas saved, and best routes.
        </p>
        <ConnectButton />
      </div>
    )
  }

  if (isLoading && !data) return <DashboardSkeleton />

  if (error) {
    return (
      <div className="rounded-2xl border border-danger/30 bg-danger/10 p-6 text-sm text-danger">
        Failed to load analytics: {error}
      </div>
    )
  }

  if (!data || data.totalSwaps === 0) return <EmptyState />

  const showTiming = data.totalSwaps >= 10 && data.bestHour !== null && data.bestDayOfWeek !== null

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold text-cream">My Analytics</h1>
          <p className="text-xs text-cream-35">
            Aggregated across {data.totalSwaps} swap{data.totalSwaps === 1 ? '' : 's'}
            {data.periodStart ? ` since ${data.periodStart.slice(0, 10)}` : ''}
          </p>
        </div>
        <a
          href={`/api/analytics/export?wallet=${data.wallet}&format=csv`}
          className="rounded-lg border border-cream-15 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-cream-65 transition hover:border-cream-35 hover:text-cream"
        >
          Export CSV
        </a>
      </header>

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Swaps" value={data.totalSwaps.toLocaleString()} />
        <StatCard label="Total Volume" value={formatUsd(data.totalVolumeUsd)} />
        <StatCard
          label="Gas Saved"
          value={formatUsd(data.totalGasSavedUsd)}
          sub={`${data.gaslessSwapCount} gasless swap${data.gaslessSwapCount === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Gasless Ratio"
          value={`${(data.gaslessRatio * 100).toFixed(1)}%`}
          sub={`${data.gaslessSwapCount} / ${data.totalSwaps}`}
        />
      </div>

      {/* Source win rates + top pairs */}
      <div className="grid gap-3 md:grid-cols-2">
        <SourceWinRates rates={data.sourceWinRates} />
        <TopPairs pairs={data.topPairs} />
      </div>

      {/* Timing insight — only with enough data */}
      {showTiming && (
        <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
          <h3 className="mb-2 text-xs font-semibold text-cream-65">When you trade</h3>
          <p className="text-sm text-cream-65">
            You trade most on{' '}
            <span className="font-semibold text-cream">
              {DAY_LABELS[data.bestDayOfWeek!]}s
            </span>{' '}
            around{' '}
            <span className="font-semibold text-cream">
              {formatHourUtc(data.bestHour!)}
            </span>
            .
          </p>
        </div>
      )}
    </div>
  )
}
