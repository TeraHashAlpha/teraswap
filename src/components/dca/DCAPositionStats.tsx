'use client'

/**
 * [CHORE-DCA-VISIBILITY-AND-STATS #3] Per-position DCA stats block — cost basis,
 * total invested / received, fills executed/planned, date range, % complete, and
 * P&L vs current spot. Everything realized is computed from the fills
 * (order_executions amounts) via the pure position-stats module; only the P&L
 * layer reaches out for a live price (/api/portfolio/prices, DefiLlama).
 *
 * Reuse without a double fetch: pass `fills` when the parent already loaded them
 * (MissionControlCard's useOrderExecutions) — the hook here then stays disabled.
 * Omit `fills` (OrderDashboard's completed card) and it fetches once itself.
 *
 * Non-alarmist by design: a loss is a calm neutral cue, never a red alert.
 */
import { useEffect, useMemo, useState } from 'react'
import { useOrderExecutions, type FillRow } from '@/hooks/useOrderExecutions'
import { isPortfolioSupportedChain } from '@/lib/portfolio-chains'
import {
  computePositionStats,
  computePositionPnl,
  type PositionPnl,
} from '@/lib/dca/position-stats'

interface DCAPositionStatsProps {
  orderId: string
  wallet: string
  tokenIn: string
  tokenOut: string
  tokenInSymbol: string
  tokenOutSymbol: string
  tokenInDecimals: number
  tokenOutDecimals: number
  chainId: number
  dcaTotal: number
  /** Fills already loaded by the parent — pass to skip a second fetch. */
  fills?: FillRow[]
  /** Whether the owning surface is visible/active (gates the self-fetch). */
  enabled?: boolean
}

// ── Formatters ─────────────────────────────────────────
const USD_FMT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function fmtToken(n: number): string {
  if (n === 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  if (n >= 1) return n.toFixed(4).replace(/\.?0+$/, '')
  if (n >= 0.0001) return n.toFixed(6).replace(/\.?0+$/, '')
  return n.toPrecision(2)
}

function fmtUsd(n: number): string {
  return `$${USD_FMT.format(n)}`
}

/** Realized rate (input per output) — usually a small number → keep precision. */
function fmtPrice(n: number): string {
  if (n >= 1) return n.toFixed(4).replace(/\.?0+$/, '')
  return n.toPrecision(4)
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function dateRange(first: string | null, last: string | null): string | null {
  if (!first || !last) return null
  const a = fmtDate(first)
  const b = fmtDate(last)
  return a === b ? a : `${a} – ${b}`
}

// ── Component ──────────────────────────────────────────
export default function DCAPositionStats({
  orderId,
  wallet,
  tokenIn,
  tokenOut,
  tokenInSymbol,
  tokenOutSymbol,
  tokenInDecimals,
  tokenOutDecimals,
  chainId,
  dcaTotal,
  fills,
  enabled = true,
}: DCAPositionStatsProps) {
  const self = useOrderExecutions(orderId, wallet, { enabled: fills === undefined && enabled })
  const rows: FillRow[] = fills ?? self.executions

  const stats = useMemo(
    () =>
      computePositionStats(rows, {
        dcaTotal,
        tokenInDecimals,
        tokenOutDecimals,
      }),
    [rows, dcaTotal, tokenInDecimals, tokenOutDecimals],
  )

  // P&L vs spot — one price fetch for the pair, only when there's something to
  // value and the chain is portfolio-priceable. Never blocks the realized stats.
  const [prices, setPrices] = useState<{ in: number | null; out: number | null }>({ in: null, out: null })
  useEffect(() => {
    if (stats.fillsExecuted === 0 || !tokenIn || !tokenOut || !isPortfolioSupportedChain(chainId)) return
    let cancelled = false
    fetch(`/api/portfolio/prices?tokens=${tokenIn},${tokenOut}&chainId=${chainId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.prices) return
        setPrices({
          in: j.prices[tokenIn.toLowerCase()] ?? null,
          out: j.prices[tokenOut.toLowerCase()] ?? null,
        })
      })
      .catch(() => {
        /* best-effort — no P&L is fine, stats still render */
      })
    return () => {
      cancelled = true
    }
  }, [stats.fillsExecuted, tokenIn, tokenOut, chainId])

  const pnl: PositionPnl | null = useMemo(
    () => computePositionPnl(stats, { priceIn: prices.in, priceOut: prices.out }),
    [stats, prices],
  )

  // Nothing filled yet → nothing to summarise (the card already shows N of M).
  if (stats.fillsExecuted === 0) return null

  const range = dateRange(stats.firstFillAt, stats.lastFillAt)

  const pnlTone =
    pnl?.direction === 'up'
      ? 'text-emerald-300'
      : pnl?.direction === 'down'
        ? 'text-cream-50'
        : 'text-cream-40'

  return (
    <div className="mb-3 rounded-xl border border-cream-08 bg-cream-04 px-3 py-2.5">
      <p className="mb-1.5 text-[11px] font-semibold text-cream-50">Position summary</p>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-3">
        <Stat label="Invested">
          {fmtToken(stats.totalInvested)} {tokenInSymbol}
        </Stat>
        <Stat label="Received">
          {fmtToken(stats.totalReceived)} {tokenOutSymbol}
        </Stat>
        <Stat label="Avg price">
          {stats.avgBuyPrice != null
            ? `${fmtPrice(stats.avgBuyPrice)} ${tokenInSymbol}/${tokenOutSymbol}`
            : '—'}
        </Stat>
        <Stat label="Fills">
          {stats.fillsExecuted}/{stats.fillsPlanned} ({stats.pctComplete}%)
        </Stat>
        {range && <Stat label="Range">{range}</Stat>}
        {pnl && (
          <Stat label="P&L vs spot">
            <span className={pnlTone} title="Value of what you received at today's price, vs what you spent">
              {pnl.pnlUsd >= 0 ? '+' : '−'}
              {fmtUsd(Math.abs(pnl.pnlUsd))}
              {pnl.pnlPct != null && (
                <span className="ml-1 text-cream-35">
                  ({pnl.pnlUsd >= 0 ? '+' : '−'}
                  {Math.abs(pnl.pnlPct).toFixed(1)}%)
                </span>
              )}
            </span>
          </Stat>
        )}
      </div>
    </div>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="block text-cream-35">{label}</span>
      <span className="block truncate font-medium text-cream-70">{children}</span>
    </div>
  )
}
