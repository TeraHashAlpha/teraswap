'use client'

/**
 * Public protocol stats view. Renders only fields from GET /api/stats —
 * never invents volume, pairs, or other figures the route does not return.
 */

import { AGGREGATOR_META, type AggregatorName } from '@/lib/constants'

export type PublicStatsGasless = {
  totalGaslessSwaps?: number
  totalGasSavedUsd?: number
  gaslessRatio?: number
  avgGasSavingsPerSwap?: number
}

export type PublicStatsPayload = {
  enabled?: boolean
  error?: string
  totalSwaps?: number
  totalQuotes?: number
  topSwapSources?: [string, number][]
  topQuoteWinners?: [string, number][]
  gasless?: PublicStatsGasless
}

function sourceLabel(s: string): string {
  return AGGREGATOR_META[s as AggregatorName]?.label ?? s
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-cream-35">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-cream">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-cream-35">{sub}</div>}
    </div>
  )
}

function RankedList({
  title,
  rows,
}: {
  title: string
  rows: [string, number][]
}) {
  if (rows.length === 0) return null
  const max = Math.max(...rows.map(([, n]) => n), 1)
  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-4">
      <h3 className="mb-3 text-xs font-semibold text-cream-65">{title}</h3>
      <div className="space-y-2.5">
        {rows.map(([source, count], i) => (
          <div key={source} className="flex items-center gap-3">
            <span className="w-4 text-right text-[10px] tabular-nums text-cream-35">{i + 1}</span>
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-cream-65">{sourceLabel(source)}</span>
                <span className="tabular-nums text-cream-50">{count.toLocaleString()}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-cream-08">
                <div
                  className="h-full rounded-full bg-cream-35"
                  style={{ width: `${Math.max((count / max) * 100, 2)}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function PublicProtocolStats({
  payload,
  loading,
  failed,
}: {
  payload: PublicStatsPayload | null
  loading: boolean
  failed: boolean
}) {
  const enabled = payload?.enabled !== false && payload != null

  return (
    <section
      aria-labelledby="protocol-stats-heading"
      data-testid="public-protocol-stats"
      className="space-y-4"
    >
      <header>
        <h1 id="protocol-stats-heading" className="text-xl font-bold text-cream">
          Protocol performance
        </h1>
        <p className="text-xs text-cream-35">
          Public totals from the protocol stats API — swap counts, quote counts, and source rankings.
        </p>
      </header>

      {loading && (
        <p className="text-sm text-cream-35">Loading protocol stats…</p>
      )}

      {failed && (
        <p className="text-sm text-cream-50">Could not load protocol stats.</p>
      )}

      {!loading && !failed && payload && payload.enabled === false && (
        <p className="text-sm text-cream-50">Protocol stats are disabled.</p>
      )}

      {enabled && payload && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {typeof payload.totalSwaps === 'number' && (
              <StatCard label="Total swaps" value={payload.totalSwaps.toLocaleString()} />
            )}
            {typeof payload.totalQuotes === 'number' && (
              <StatCard label="Total quotes" value={payload.totalQuotes.toLocaleString()} />
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <RankedList title="Top swap sources" rows={payload.topSwapSources ?? []} />
            <RankedList title="Top quote winners" rows={payload.topQuoteWinners ?? []} />
          </div>

          {payload.gasless && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {typeof payload.gasless.totalGaslessSwaps === 'number' && (
                <StatCard
                  label="Gasless swaps"
                  value={payload.gasless.totalGaslessSwaps.toLocaleString()}
                />
              )}
              {typeof payload.gasless.totalGasSavedUsd === 'number' && (
                <StatCard
                  label="Gas saved"
                  value={formatUsd(payload.gasless.totalGasSavedUsd)}
                />
              )}
              {typeof payload.gasless.gaslessRatio === 'number' && (
                <StatCard
                  label="Gasless ratio"
                  value={`${(payload.gasless.gaslessRatio * 100).toFixed(1)}%`}
                />
              )}
              {typeof payload.gasless.avgGasSavingsPerSwap === 'number' && (
                <StatCard
                  label="Avg gas saved"
                  value={formatUsd(payload.gasless.avgGasSavingsPerSwap)}
                />
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
