'use client'

/**
 * Public protocol stats view. Renders only fields from GET /api/stats —
 * never invents volume, pairs, or other figures the route does not return.
 * Disabled and empty metrics say "not available yet" with a reason.
 */

import { AGGREGATOR_META, type AggregatorName } from '@/lib/constants'
import {
  protocolStatsGate,
  countMetric,
  listMetric,
  gaslessMetrics,
  type PublicStatsPayload,
  type UnavailableMetric,
  type AvailableCount,
} from '@/lib/public-stats-display'

export type { PublicStatsPayload }

function sourceLabel(s: string): string {
  return AGGREGATOR_META[s as AggregatorName]?.label ?? s
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function UnavailableNote({
  label,
  metric,
  testId,
}: {
  label?: string
  metric: UnavailableMetric
  testId?: string
}) {
  return (
    <div
      className="rounded-xl border border-cream-08 bg-surface-tertiary p-4"
      data-testid={testId}
    >
      {label && (
        <div className="text-[11px] font-medium uppercase tracking-wider text-cream-35">
          {label}
        </div>
      )}
      <p className="mt-1 text-sm text-cream-50">
        {metric.message}. {metric.reason}
      </p>
    </div>
  )
}

function StatCard({
  label,
  value,
  testId,
}: {
  label: string
  value: string
  testId: string
}) {
  return (
    <div
      className="rounded-xl border border-cream-08 bg-surface-tertiary p-4"
      data-testid={testId}
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-cream-35">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-cream">{value}</div>
    </div>
  )
}

function CountCard({
  label,
  metric,
  testId,
  format = (n: number) => n.toLocaleString(),
}: {
  label: string
  metric: UnavailableMetric | AvailableCount
  testId: string
  format?: (n: number) => string
}) {
  if (!metric.available) {
    return <UnavailableNote label={label} metric={metric} testId={`${testId}-unavailable`} />
  }
  return <StatCard label={label} value={format(metric.value)} testId={testId} />
}

function RankedList({
  title,
  rows,
  testId,
}: {
  title: string
  rows: [string, number][]
  testId: string
}) {
  const max = Math.max(...rows.map(([, n]) => n))
  return (
    <div
      className="rounded-xl border border-cream-08 bg-surface-tertiary p-4"
      data-testid={testId}
    >
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
                  style={{ width: `${(count / max) * 100}%` }}
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
  const gate = protocolStatsGate(payload, { loading, failed })

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

      {gate.status === 'loading' && (
        <p className="text-sm text-cream-35">Loading protocol stats…</p>
      )}

      {gate.status === 'unavailable' && (
        <p className="text-sm text-cream-50" data-testid="protocol-stats-unavailable">
          Protocol performance is {gate.message}. {gate.reason}
        </p>
      )}

      {gate.status === 'ready' && payload && (
        <ReadyStats payload={payload} />
      )}
    </section>
  )
}

function ReadyStats({ payload }: { payload: PublicStatsPayload }) {
  const totalSwaps = countMetric(payload.totalSwaps, 'No swaps recorded yet.')
  const totalQuotes = countMetric(payload.totalQuotes, 'No quotes recorded yet.')
  const sources = listMetric(
    payload.topSwapSources,
    'No swap-source breakdown recorded yet.',
  )
  const winners = listMetric(
    payload.topQuoteWinners,
    'No quote-winner breakdown recorded yet.',
  )
  const gasless = gaslessMetrics(payload.gasless)
  const anyGasless =
    gasless.totalGaslessSwaps.available
    || gasless.totalGasSavedUsd.available
    || gasless.gaslessRatio.available
    || gasless.avgGasSavingsPerSwap.available

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CountCard label="Total swaps" metric={totalSwaps} testId="protocol-metric-totalSwaps" />
        <CountCard label="Total quotes" metric={totalQuotes} testId="protocol-metric-totalQuotes" />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {sources.available ? (
          <RankedList
            title="Top swap sources"
            rows={sources.items}
            testId="protocol-chart-sources"
          />
        ) : (
          <UnavailableNote
            label="Top swap sources"
            metric={sources}
            testId="protocol-chart-sources-unavailable"
          />
        )}
        {winners.available ? (
          <RankedList
            title="Top quote winners"
            rows={winners.items}
            testId="protocol-chart-winners"
          />
        ) : (
          <UnavailableNote
            label="Top quote winners"
            metric={winners}
            testId="protocol-chart-winners-unavailable"
          />
        )}
      </div>

      {anyGasless && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <CountCard
            label="Gasless swaps"
            metric={gasless.totalGaslessSwaps}
            testId="protocol-metric-gaslessSwaps"
          />
          <CountCard
            label="Gas saved"
            metric={gasless.totalGasSavedUsd}
            testId="protocol-metric-gasSaved"
            format={formatUsd}
          />
          <CountCard
            label="Gasless ratio"
            metric={gasless.gaslessRatio}
            testId="protocol-metric-gaslessRatio"
            format={(n) => `${(n * 100).toFixed(1)}%`}
          />
          <CountCard
            label="Avg gas saved"
            metric={gasless.avgGasSavingsPerSwap}
            testId="protocol-metric-avgGasSaved"
            format={formatUsd}
          />
        </div>
      )}
    </>
  )
}
