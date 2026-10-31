'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useOrderExecutions, type FillRow } from '@/hooks/useOrderExecutions'
import { isPortfolioSupportedChain } from '@/lib/portfolio-chains'
import { computePositionPnl, computePositionStats, type PositionPnl, type PositionStats } from '@/lib/dca/position-stats'
import { fmtPct, fmtToken, fmtUsd } from '@/lib/format'
import { statRange } from './positions-model'

export interface PositionStatsArgs {
  orderId: string
  wallet: string
  tokenIn: string
  tokenOut: string
  tokenInDecimals: number
  tokenOutDecimals: number
  chainId: number
  dcaTotal: number
  /** Fills the parent already loaded (v1 MissionControlCard passes its own `useOrderExecutions` rows) — skips a second fetch. */
  fills?: FillRow[]
  /** Gates the self-fetch (v1 OrderDashboard passes `enabled={expanded}`). */
  enabled?: boolean
}

/**
 * [B7] v1 DCAPositionStats' data path, unchanged: the fills (the parent's, else v1's `useOrderExecutions`), `computePositionStats`, one
 * `/api/portfolio/prices` read for the pair when something was filled on a portfolio-priced chain, `computePositionPnl`. The P&L is the
 * lib's number — the UI computes nothing of its own (owner rule). Returned for the render and for the equality test.
 */
export function usePositionStats(a: PositionStatsArgs): { stats: PositionStats; pnl: PositionPnl | null } {
  const self = useOrderExecutions(a.orderId, a.wallet, { enabled: a.fills === undefined && (a.enabled ?? true) })
  const rows: FillRow[] = a.fills ?? self.executions
  const stats = useMemo(
    () => computePositionStats(rows, { dcaTotal: a.dcaTotal, tokenInDecimals: a.tokenInDecimals, tokenOutDecimals: a.tokenOutDecimals }),
    [rows, a.dcaTotal, a.tokenInDecimals, a.tokenOutDecimals],
  )

  const [prices, setPrices] = useState<{ in: number | null; out: number | null }>({ in: null, out: null })
  const { tokenIn, tokenOut, chainId } = a
  useEffect(() => {
    if (stats.fillsExecuted === 0 || !tokenIn || !tokenOut || !isPortfolioSupportedChain(chainId)) return
    let cancelled = false
    fetch(`/api/portfolio/prices?tokens=${tokenIn},${tokenOut}&chainId=${chainId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.prices) return
        setPrices({ in: j.prices[tokenIn.toLowerCase()] ?? null, out: j.prices[tokenOut.toLowerCase()] ?? null })
      })
      .catch(() => {
        /* best-effort, as v1: no P&L is fine, the realized stats still render */
      })
    return () => {
      cancelled = true
    }
  }, [stats.fillsExecuted, tokenIn, tokenOut, chainId])

  const pnl = useMemo(() => computePositionPnl(stats, { priceIn: prices.in, priceOut: prices.out }), [stats, prices])
  return { stats, pnl }
}

const LABEL = 'block font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px] text-v2-muted'

function Stat({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className={LABEL}>{label}</dt>
      <dd className="mt-1 truncate font-v2-mono text-[13px] tabular-nums text-v2-text">{children}</dd>
    </div>
  )
}

/**
 * v1 DCAPositionStats' block, unboxed (round7 35 / 42): "Position summary", then Invested · Received · Avg price · Fills · Range · P&L vs
 * spot, v1's labels and v1's formatting. Nothing filled yet → nothing (v1: the card already shows N of M). A loss is v1's calm neutral
 * cue, never red (v1: "non-alarmist by design"; the frame's red-when-negative note is frame-only).
 */
export function PositionSummary({ tokenInSymbol, tokenOutSymbol, tokenInDecimals, tokenOutDecimals, ...args }: PositionStatsArgs & { tokenInSymbol: string; tokenOutSymbol: string }) {
  const { stats, pnl } = usePositionStats({ ...args, tokenInDecimals, tokenOutDecimals })
  if (stats.fillsExecuted === 0) return null
  const range = statRange(stats.firstFillAt, stats.lastFillAt)
  const pnlTone = pnl?.direction === 'up' ? 'text-v2-green' : pnl?.direction === 'down' ? 'text-v2-text' : 'text-v2-muted'
  return (
    <section className="ts-dca-summary-block" data-testid="position-summary" aria-label="Position summary">
      <p className={LABEL}>Position summary</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Stat label="Invested">{fmtToken(BigInt(stats.totalInvestedRaw), tokenInDecimals)} {tokenInSymbol}</Stat>
        <Stat label="Received">{fmtToken(BigInt(stats.totalReceivedRaw), tokenOutDecimals)} {tokenOutSymbol}</Stat>
        <Stat label="Avg price">{stats.avgBuyPrice != null ? `${fmtToken(stats.avgBuyPrice)} ${tokenInSymbol}/${tokenOutSymbol}` : '—'}</Stat>
        <Stat label="Fills">{stats.fillsExecuted}/{stats.fillsPlanned} ({stats.pctComplete}%)</Stat>
        {range && <Stat label="Range">{range}</Stat>}
        {pnl && (
          <Stat label="P&L vs spot" testId="position-pnl">
            <span className={pnlTone} title="Value of what you received at today's price, vs what you spent">
              {pnl.pnlUsd >= 0 ? '+' : '−'}
              {fmtUsd(Math.abs(pnl.pnlUsd))}
              {pnl.pnlPct != null && (
                <span className="ml-1 text-v2-muted">
                  ({pnl.pnlUsd >= 0 ? '+' : '−'}
                  {fmtPct(Math.abs(pnl.pnlPct), 1)})
                </span>
              )}
            </span>
          </Stat>
        )}
      </dl>
    </section>
  )
}
