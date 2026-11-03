'use client'

import { useMemo } from 'react'
import type { FillRow, OrderExecMeta } from '@/hooks/useOrderExecutions'
import { explorerTxUrl } from '@/lib/chains/tokens'
import { fmtDate } from '@/lib/format'
import { Skeleton } from '../primitives'
import { isFillSuccess } from '../dca/positions-model'
import { avgPrice, execAmount, execGas, execPrice, sumWei } from './orders-model'

/** The `order` columns `/api/orders/:id/executions` returns beside the rows (v1 ExecutionTimeline `OrderMeta`). */
export type ExecOrderMeta = OrderExecMeta & {
  tx_hash?: string | null
  amount_out?: string | null
  gas_used?: string | null
  executed_at?: string | null
  executed_price?: string | null
}

const CAPS = 'font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted'

/**
 * [B7 C2] v1 ExecutionTimeline as hairline rows (round7 42's EXECUTION HISTORY). The rows are the card's `useOrderExecutions` read — the
 * same `/api/orders/:id/executions` v1 fetches here a second time — with v1's fallback: an executed order without per-fill rows shows one
 * synthetic entry from the order's own tx / amount / gas. v1's aggregate line (DCA with ≥ 2 fills), "Fill #N", SUCCESS / FAILED, amounts
 * "@ price", the error, the tx on the ORDER's chain (v1 hard-codes chain 1 — owner rule), v1's gas note, and the time via format.ts.
 */
export function ExecutionHistory({
  executions, orderMeta, loading, chainId, tokenInSymbol, tokenOutSymbol, tokenInDecimals, tokenOutDecimals, dcaTotal, dcaExecuted,
}: {
  executions: FillRow[]
  orderMeta: ExecOrderMeta | null
  loading: boolean
  chainId: number
  tokenInSymbol: string
  tokenOutSymbol: string
  tokenInDecimals: number
  tokenOutDecimals: number
  dcaTotal?: number
  dcaExecuted?: number
}) {
  const rows: FillRow[] = useMemo(() => {
    if (executions.length > 0) return executions
    if (orderMeta && orderMeta.tx_hash) {
      return [{
        id: 'synthetic', execution_number: 1, tx_hash: orderMeta.tx_hash, amount_in: null, amount_out: orderMeta.amount_out ?? null,
        gas_used: orderMeta.gas_used ?? null, price_at_execution: orderMeta.executed_price ?? null, status: 'success', error: null, executed_at: orderMeta.executed_at ?? null,
      }]
    }
    return []
  }, [executions, orderMeta])

  const isDca = (dcaTotal ?? orderMeta?.dca_total ?? 0) > 1
  const showAggregate = isDca && rows.length >= 2
  const aggregate = useMemo(() => {
    if (!showAggregate) return null
    return {
      totalIn: execAmount(sumWei(rows.map((r) => r.amount_in)).toString(), tokenInDecimals, tokenInSymbol),
      totalOut: execAmount(sumWei(rows.map((r) => r.amount_out)).toString(), tokenOutDecimals, tokenOutSymbol),
      avgPriceLabel: execPrice(avgPrice(rows.map((r) => r.price_at_execution))),
      gasLabel: execGas(sumWei(rows.map((r) => r.gas_used ?? null)).toString()),
    }
  }, [showAggregate, rows, tokenInDecimals, tokenInSymbol, tokenOutDecimals, tokenOutSymbol])

  if (loading) {
    return (
      <div className="mt-4" aria-label="Loading execution history" aria-busy="true" data-testid="exec-loading">
        <Skeleton height={12} width="30%" />
        <div className="mt-3 flex flex-col gap-3">
          <Skeleton height={12} width="75%" />
          <Skeleton height={12} width="50%" />
        </div>
      </div>
    )
  }
  if (rows.length === 0) return null

  const completed = dcaExecuted ?? orderMeta?.dca_executed ?? rows.length
  const total = dcaTotal ?? orderMeta?.dca_total ?? rows.length

  return (
    <section className="ts-orders-exec" data-testid="execution-history" aria-label="Execution History">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className={CAPS}>Execution History</p>
        {showAggregate && aggregate && (
          <p className="flex flex-wrap gap-x-3 font-v2-mono text-[12px] text-v2-muted" data-testid="exec-aggregate">
            <span className="text-v2-text">{completed}/{total} fills</span>
            {aggregate.totalIn && aggregate.totalOut && <span>{aggregate.totalIn} → {aggregate.totalOut}</span>}
            {aggregate.avgPriceLabel && <span>Avg {aggregate.avgPriceLabel}</span>}
            {isDca ? <span><span aria-hidden="true">⛽ </span>gas paid by executor</span> : aggregate.gasLabel && <span><span aria-hidden="true">⛽ </span>{aggregate.gasLabel}</span>}
          </p>
        )}
      </div>
      <ul className="mt-2">
        {rows.map((exec, i) => {
          const ok = isFillSuccess(exec.status)
          const ts = exec.executed_at || exec.created_at
          const amountIn = execAmount(exec.amount_in, tokenInDecimals, tokenInSymbol)
          const amountOut = execAmount(exec.amount_out, tokenOutDecimals, tokenOutSymbol)
          const price = execPrice(exec.price_at_execution)
          const gas = execGas(exec.gas_used)
          return (
            <li key={exec.id || i} className="ts-orders-exec-row" data-testid="exec-row">
              <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${ok ? 'bg-v2-green' : 'bg-v2-red'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  {isDca && rows.length > 1 && <span className="text-[13px] font-semibold text-v2-text">Fill #{exec.execution_number}</span>}
                  <span className={`font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px] ${ok ? 'text-v2-green' : 'text-v2-red'}`}>{ok ? 'SUCCESS' : 'FAILED'}</span>
                </div>
                {(amountIn || amountOut) && (
                  <p className="mt-0.5 font-v2-mono text-[12px] tabular-nums text-v2-text/90">
                    {amountIn ?? '—'} → <span className="text-v2-text">{amountOut ?? '—'}</span>
                    {price && <span className="ml-1 text-v2-muted">@ {price}</span>}
                  </p>
                )}
                {exec.error && <p className="mt-0.5 line-clamp-1 text-[12px] text-v2-red">{exec.error}</p>}
                <div className="flex flex-wrap items-center gap-x-3">
                  {exec.tx_hash && (
                    <a href={explorerTxUrl(exec.tx_hash, chainId)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1 font-v2-mono text-[12px] text-v2-cream underline-offset-2 hover:underline">
                      <span>{exec.tx_hash.slice(0, 10)}...{exec.tx_hash.slice(-6)}</span>
                      <span>↗</span>
                    </a>
                  )}
                  {isDca ? (
                    <span className="text-[12px] text-v2-muted" data-testid="exec-gas-note"><span aria-hidden="true">⛽ </span>gas paid by executor</span>
                  ) : gas && <span className="text-[12px] text-v2-muted"><span aria-hidden="true">⛽ </span>{gas}</span>}
                </div>
              </div>
              {ts && <span className="shrink-0 font-v2-mono text-[11px] text-v2-muted">{fmtDate(ts)}</span>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
