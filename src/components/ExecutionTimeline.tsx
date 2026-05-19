'use client'

import { useState, useEffect, useMemo } from 'react'
import { formatUnits } from 'viem'

/** Raw row shape returned by GET /api/orders/:id/executions. */
interface Execution {
  id: string
  execution_number: number
  tx_hash: string | null
  amount_in: string | null
  amount_out: string | null
  fee_amount?: string | null
  gas_used: string | null
  price_at_execution?: string | null
  status: string
  error?: string | null
  executed_at?: string | null
  created_at?: string | null
}

/** Subset of order columns returned alongside executions. */
interface OrderMeta {
  token_in_symbol: string | null
  token_out_symbol: string | null
  token_in_decimals: number | null
  token_out_decimals: number | null
  dca_total: number | null
  dca_executed: number | null
  tx_hash: string | null
  amount_out: string | null
  gas_used: string | null
  executed_at: string | null
  executed_price: string | null
}

interface ExecutionTimelineProps {
  orderId: string
  wallet: string
  tokenInSymbol: string
  tokenOutSymbol: string
  tokenInDecimals: number
  tokenOutDecimals: number
  dcaTotal?: number
  dcaExecuted?: number
}

// ── Formatters ─────────────────────────────────────────

const AMOUNT_FMT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })
const PRICE_FMT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
const GAS_FMT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })

/** Format a raw wei integer string with the given decimals + symbol. */
function formatAmount(raw: string | null | undefined, decimals: number, symbol: string): string | null {
  if (raw == null || raw === '') return null
  try {
    const v = formatUnits(BigInt(raw), decimals)
    const num = Number(v)
    if (!Number.isFinite(num)) return `${v} ${symbol}`
    return `${AMOUNT_FMT.format(num)} ${symbol}`
  } catch {
    return null
  }
}

/** Format Chainlink price (8 decimals) as "$1,234.56". */
function formatPrice(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null
  try {
    const v = formatUnits(BigInt(raw), 8)
    const num = Number(v)
    if (!Number.isFinite(num) || num === 0) return null
    return `$${PRICE_FMT.format(num)}`
  } catch {
    return null
  }
}

/** Format gas cost (raw wei) as "0.0023 ETH". */
function formatGasEth(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null
  try {
    const v = formatUnits(BigInt(raw), 18)
    const num = Number(v)
    if (!Number.isFinite(num) || num === 0) return null
    return `${GAS_FMT.format(num)} ETH`
  } catch {
    return null
  }
}

/** Sum a list of decimal-integer wei strings safely. Null inputs are skipped. */
function sumWei(values: Array<string | null | undefined>): bigint {
  let total = 0n
  for (const v of values) {
    if (v == null || v === '') continue
    try { total += BigInt(v) } catch { /* skip non-integer */ }
  }
  return total
}

/** Average of Chainlink-format prices (8 decimals), preserving precision. */
function avgPrice(prices: Array<string | null | undefined>): string | null {
  const valid: bigint[] = []
  for (const p of prices) {
    if (p == null || p === '') continue
    try { valid.push(BigInt(p)) } catch { /* skip */ }
  }
  if (valid.length === 0) return null
  const total = valid.reduce((a, b) => a + b, 0n)
  return (total / BigInt(valid.length)).toString()
}

// ── Skeleton ───────────────────────────────────────────

function TimelineSkeleton() {
  return (
    <div className="mb-3" aria-label="Loading execution history" aria-busy="true">
      <div className="mb-2 h-3 w-32 animate-pulse rounded bg-cream-08" />
      <div className="ml-2 space-y-3 border-l border-cream-08 pl-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="space-y-1.5">
            <div className="h-3 w-3/4 animate-pulse rounded bg-cream-08" />
            <div className="h-2 w-1/2 animate-pulse rounded bg-cream-08/60" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────

/**
 * Timeline of executions for an order. Works for all order types:
 *  - DCA with ≥2 fills → aggregate stats bar + one row per fill (numbered).
 *  - Single-fill (Limit/SL/TP, or DCA with 1 fill) → one row without "Fill #N".
 *  - Legacy executed order without order_executions rows → synthetic entry
 *    built from the parent order's tx_hash / amount_out / gas_used.
 */
export default function ExecutionTimeline({
  orderId,
  wallet,
  tokenInSymbol,
  tokenOutSymbol,
  tokenInDecimals,
  tokenOutDecimals,
  dcaTotal,
  dcaExecuted,
}: ExecutionTimelineProps) {
  const [executions, setExecutions] = useState<Execution[]>([])
  const [orderMeta, setOrderMeta] = useState<OrderMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!orderId || !wallet) return

    setLoading(true)
    fetch(`/api/orders/${orderId}/executions?wallet=${wallet}`)
      .then(res => res.json())
      .then(data => {
        setExecutions(Array.isArray(data.executions) ? data.executions : [])
        setOrderMeta(data.order ?? null)
        setError(data.error || null)
      })
      .catch(() => setError('Failed to load executions'))
      .finally(() => setLoading(false))
  }, [orderId, wallet])

  // Resolve the rows to render: real executions OR a single synthetic entry
  // if the order has been executed but no per-fill rows exist (legacy data).
  const rows: Execution[] = useMemo(() => {
    if (executions.length > 0) return executions
    if (orderMeta && orderMeta.tx_hash) {
      return [{
        id: 'synthetic',
        execution_number: 1,
        tx_hash: orderMeta.tx_hash,
        amount_in: null,
        amount_out: orderMeta.amount_out,
        gas_used: orderMeta.gas_used,
        price_at_execution: orderMeta.executed_price,
        status: 'success',
        error: null,
        executed_at: orderMeta.executed_at,
      }]
    }
    return []
  }, [executions, orderMeta])

  const isDca = (dcaTotal ?? orderMeta?.dca_total ?? 0) > 1
  const showAggregateStats = isDca && rows.length >= 2

  // Aggregate stats (only computed when needed; safe to call always — cheap).
  const aggregate = useMemo(() => {
    if (!showAggregateStats) return null
    const totalIn = sumWei(rows.map(r => r.amount_in))
    const totalOut = sumWei(rows.map(r => r.amount_out))
    const totalGas = sumWei(rows.map(r => r.gas_used))
    const avg = avgPrice(rows.map(r => r.price_at_execution))
    return {
      totalIn: formatAmount(totalIn.toString(), tokenInDecimals, tokenInSymbol),
      totalOut: formatAmount(totalOut.toString(), tokenOutDecimals, tokenOutSymbol),
      avgPriceLabel: formatPrice(avg),
      gasLabel: formatGasEth(totalGas.toString()),
    }
  }, [showAggregateStats, rows, tokenInDecimals, tokenInSymbol, tokenOutDecimals, tokenOutSymbol])

  if (loading) return <TimelineSkeleton />

  if (error || rows.length === 0) return null

  const dcaCompleted = dcaExecuted ?? orderMeta?.dca_executed ?? rows.length
  const dcaTotalResolved = dcaTotal ?? orderMeta?.dca_total ?? rows.length

  return (
    <div className="mb-3">
      <p className="mb-2 text-[11px] font-semibold text-cream-50">Execution History</p>

      {/* Aggregate stats — DCA orders with ≥2 fills only */}
      {showAggregateStats && aggregate && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-cream-08 bg-cream-04 px-3 py-2 text-[11px] text-cream-50">
          <span className="font-semibold text-cream">{dcaCompleted}/{dcaTotalResolved} fills</span>
          {aggregate.totalIn && aggregate.totalOut && (
            <span>{aggregate.totalIn} → {aggregate.totalOut}</span>
          )}
          {aggregate.avgPriceLabel && (
            <span>Avg {aggregate.avgPriceLabel}</span>
          )}
          {aggregate.gasLabel && (
            <span>⛽ {aggregate.gasLabel}</span>
          )}
        </div>
      )}

      <div className="relative ml-2 border-l border-cream-08 pl-4">
        {rows.map((exec, i) => {
          const isSuccess = exec.status === 'success' || exec.status === 'executed' || exec.status === 'confirmed'
          const isLast = i === rows.length - 1
          const tsRaw = exec.executed_at || exec.created_at
          const time = tsRaw ? new Date(tsRaw) : null

          const amountIn = formatAmount(exec.amount_in, tokenInDecimals, tokenInSymbol)
          const amountOut = formatAmount(exec.amount_out, tokenOutDecimals, tokenOutSymbol)
          const priceLabel = formatPrice(exec.price_at_execution)
          const gasLabel = formatGasEth(exec.gas_used)

          return (
            <div key={exec.id || i} className={`relative pb-3 ${isLast ? 'pb-0' : ''}`}>
              {/* Timeline dot */}
              <div className={`absolute -left-[calc(1rem+3px)] top-1 h-1.5 w-1.5 rounded-full ${
                isSuccess ? 'bg-emerald-400' : 'bg-red-400'
              }`} />

              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[11px]">
                    {/* Single-fill orders omit the "Fill #N" label. */}
                    {isDca && rows.length > 1 && (
                      <span className="font-semibold text-cream">Fill #{exec.execution_number}</span>
                    )}
                    <span className={`rounded px-1 py-0.5 text-[9px] font-bold ${
                      isSuccess
                        ? 'bg-emerald-400/10 text-emerald-300'
                        : 'bg-red-400/10 text-red-400'
                    }`}>
                      {isSuccess ? 'SUCCESS' : 'FAILED'}
                    </span>
                  </div>

                  {(amountIn || amountOut) && (
                    <p className="mt-0.5 text-[11px] text-cream-65">
                      {amountIn ?? '—'} → <span className="text-cream">{amountOut ?? '—'}</span>
                      {priceLabel && (
                        <span className="ml-1 text-cream-40">@ {priceLabel}</span>
                      )}
                    </p>
                  )}

                  {exec.error && (
                    <p className="mt-0.5 text-[10px] text-red-400/80 line-clamp-1">{exec.error}</p>
                  )}

                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {exec.tx_hash && (
                      <a
                        href={`https://etherscan.io/tx/${exec.tx_hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-0.5 text-[10px] text-cream-30 hover:text-cream transition-colors"
                      >
                        <span className="font-mono">{exec.tx_hash.slice(0, 10)}...{exec.tx_hash.slice(-6)}</span>
                        <span>↗</span>
                      </a>
                    )}
                    {gasLabel && (
                      <span className="text-[10px] text-cream-30">⛽ {gasLabel}</span>
                    )}
                  </div>
                </div>

                {time && (
                  <span className="shrink-0 text-[10px] text-cream-30">
                    {time.toLocaleDateString([], { month: 'short', day: 'numeric' })}{' '}
                    {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
