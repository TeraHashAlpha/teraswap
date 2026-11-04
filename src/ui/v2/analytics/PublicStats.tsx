'use client'

import { fmtInt, fmtPct } from '@/lib/format'
import {
  countMetric,
  gaslessMetrics,
  listMetric,
  protocolStatsGate,
  type AvailableCount,
  type PublicStatsPayload,
  type UnavailableMetric,
} from '@/lib/public-stats-display'
import { formatUsd, sourceLabel } from './analytics-model'
import type { PublicStatsState } from './use-public-stats'

function Unavailable({ label, metric, testId }: { label?: string; metric: UnavailableMetric; testId: string }) {
  return (
    <div data-testid={testId}>
      {label && <div className="ts-an-cap">{label}</div>}
      <p className="mt-1 text-[14px] text-v2-muted">{metric.message}. {metric.reason}</p>
    </div>
  )
}

function Count({ label, metric, testId, format = (n: number) => fmtInt(n) }: { label: string; metric: UnavailableMetric | AvailableCount; testId: string; format?: (n: number) => string }) {
  if (!metric.available) return <Unavailable label={label} metric={metric} testId={`${testId}-unavailable`} />
  return (
    <div data-testid={testId}>
      <div className="ts-an-cap">{label}</div>
      <div className="ts-an-value ts-an-value--sm">{format(metric.value)}</div>
    </div>
  )
}

/** v1 RankedList: rank · source · count, with a bar scaled to the list's largest count. */
function Ranked({ title, rows, testId }: { title: string; rows: [string, number][]; testId: string }) {
  const max = Math.max(...rows.map(([, n]) => n))
  return (
    <div data-testid={testId}>
      <h3 className="ts-an-cap mb-2">{title}</h3>
      {rows.map(([source, count], i) => (
        <div key={source} className="ts-an-rank">
          <span className="ts-an-rank-n">{i + 1}</span>
          <div className="ts-an-rank-main">
            <div className="ts-an-rank-line">
              <span className="ts-an-rank-label">{sourceLabel(source)}</span>
              <span className="ts-an-rank-fig">{fmtInt(count)}</span>
            </div>
            <div className="ts-an-track" aria-hidden="true">
              <div className="ts-an-fill" style={{ width: `${(count / max) * 100}%` }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function Ready({ payload }: { payload: PublicStatsPayload }) {
  const totalSwaps = countMetric(payload.totalSwaps, 'No swaps recorded yet.')
  const totalQuotes = countMetric(payload.totalQuotes, 'No quotes recorded yet.')
  const sources = listMetric(payload.topSwapSources, 'No swap-source breakdown recorded yet.')
  const winners = listMetric(payload.topQuoteWinners, 'No quote-winner breakdown recorded yet.')
  const gasless = gaslessMetrics(payload.gasless)
  const anyGasless = gasless.totalGaslessSwaps.available || gasless.totalGasSavedUsd.available || gasless.gaslessRatio.available || gasless.avgGasSavingsPerSwap.available

  return (
    <>
      <div className="ts-an-cols mt-6">
        <Count label="Total swaps" metric={totalSwaps} testId="protocol-metric-totalSwaps" />
        <Count label="Total quotes" metric={totalQuotes} testId="protocol-metric-totalQuotes" />
      </div>
      <div className="ts-an-cols mt-8">
        {sources.available ? <Ranked title="Top swap sources" rows={sources.items} testId="protocol-chart-sources" /> : <Unavailable label="Top swap sources" metric={sources} testId="protocol-chart-sources-unavailable" />}
        {winners.available ? <Ranked title="Top quote winners" rows={winners.items} testId="protocol-chart-winners" /> : <Unavailable label="Top quote winners" metric={winners} testId="protocol-chart-winners-unavailable" />}
      </div>
      {anyGasless && (
        <div className="ts-an-kpis ts-an-kpis--4 mt-8">
          <Count label="Gasless swaps" metric={gasless.totalGaslessSwaps} testId="protocol-metric-gaslessSwaps" />
          <Count label="Gas saved" metric={gasless.totalGasSavedUsd} testId="protocol-metric-gasSaved" format={formatUsd} />
          <Count label="Gasless ratio" metric={gasless.gaslessRatio} testId="protocol-metric-gaslessRatio" format={(n) => fmtPct(n * 100, 1)} />
          <Count label="Avg gas saved" metric={gasless.avgGasSavingsPerSwap} testId="protocol-metric-avgGasSaved" format={formatUsd} />
        </div>
      )}
    </>
  )
}

/**
 * [B9] v1 `PublicProtocolStats` (the `/analytics` page's first block), same words and same states: the heading and its sub-line, "Loading
 * protocol stats…", "Protocol performance is not available yet. {reason}", then the two totals, the two source rankings and the
 * gasless row — each either its figure or v1's "not available yet" note.
 */
export function PublicStats({ payload, loading, failed }: PublicStatsState) {
  const gate = protocolStatsGate(payload, { loading, failed })
  return (
    <section aria-labelledby="ts-an-protocol-h" data-testid="public-protocol-stats" className="ts-an-section">
      <header>
        <h2 id="ts-an-protocol-h" className="ts-an-h2">Protocol performance</h2>
        <p className="ts-an-sub mt-2">Public totals from the protocol stats API — swap counts, quote counts, and source rankings.</p>
      </header>
      {gate.status === 'loading' && <p className="mt-4 text-[14px] text-v2-muted">Loading protocol stats…</p>}
      {gate.status === 'unavailable' && (
        <p className="mt-4 text-[14px] text-v2-muted" data-testid="protocol-stats-unavailable">Protocol performance is {gate.message}. {gate.reason}</p>
      )}
      {gate.status === 'ready' && payload && <Ready payload={payload} />}
    </section>
  )
}
