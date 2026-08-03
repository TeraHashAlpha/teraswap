'use client'

/**
 * [FEAT-DCA-SETTLEMENT-RECEIPT] The exact-costs receipt for a completed/cancelled DCA position —
 * the closing half of TeraSwap's "radical transparency" loop (upfront estimate -> exact realized).
 *
 * Every dollar/token figure here traces to on-chain data: fills come from Supabase (which tx hashes
 * exist, in order), but every amount/fee is re-decoded from each fill's `OrderExecuted` event by
 * `buildSettlementReceipt` — never trusted from (or recomputed against) Supabase's own copy. Copy
 * tone is plain numbers + tx links; no "free"/"gasless" claim anywhere, per the transparency brand.
 */

import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import type { AutonomousOrder } from '@/lib/order-engine'
import { getWhitelistedRouters } from '@/lib/order-engine'
import {
  buildSettlementReceipt,
  type SettlementReceipt,
  type SettlementStatus,
} from '@/lib/dca/settlement-receipt'

function fmtToken(raw: string, decimals: number, symbol: string): string {
  const num = Number(formatUnits(BigInt(raw), decimals))
  if (!Number.isFinite(num)) return '—'
  if (num === 0) return `0 ${symbol}`
  return `${num.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`
}

function fmtEth(wei: string): string {
  const num = Number(formatUnits(BigInt(wei), 18))
  if (!Number.isFinite(num) || num === 0) return '0 ETH'
  return num < 0.000001 ? '<0.000001 ETH' : `${num.toLocaleString(undefined, { maximumFractionDigits: 8 })} ETH`
}

function fmtPrice(price: number | null, tokenInSymbol: string, tokenOutSymbol: string): string {
  if (price == null) return '—'
  return `${price.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${tokenInSymbol} / ${tokenOutSymbol}`
}

function fmtBps(bps: number | null): string {
  if (bps == null) return '—'
  return `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
}

// [CHORE-DCA-AGGREGATION-VALUE] "Our route"'s label — resolved from the ORDER's own committed
// router address against the chain's whitelisted-router registry (no new column: the router is
// fixed per order at signing time, same value for every one of its fills). Falls back to a plain
// generic label rather than a blank when the address isn't in the registry (never fabricated).
function resolveBestRouteLabel(router: string | null | undefined, chainId: number): string {
  if (!router) return 'our route'
  const routers = getWhitelistedRouters(chainId)
  const match = Object.values(routers).find((r) => r.address.toLowerCase() === router.toLowerCase())
  return match?.label ?? 'our route'
}

function fmtTimestamp(ms: number | null): string {
  if (ms == null) return '—'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Plain-text export — the only "share" affordance this slice ships (no PDF/export libs). */
function receiptToText(receipt: SettlementReceipt, bestRouteLabel: string): string {
  const lines: string[] = []
  lines.push(`TeraSwap DCA settlement receipt — ${receipt.tokenInSymbol} -> ${receipt.tokenOutSymbol}`)
  lines.push(`Status: ${receipt.status}`)
  lines.push(`Order: ${receipt.orderHash}`)
  lines.push('')
  lines.push(`Invested: ${fmtToken(receipt.totals.totalInvestedRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}`)
  lines.push(`Received: ${fmtToken(receipt.totals.totalReceivedRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}`)
  lines.push(`Average price: ${fmtPrice(receipt.totals.avgPrice, receipt.tokenInSymbol, receipt.tokenOutSymbol)}`)
  lines.push(`Total protocol fee: ${fmtToken(receipt.totals.totalProtocolFeeRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}`)
  lines.push(`Total network cost: ${fmtEth(receipt.totals.totalNetworkCostWeiRaw)} (${receipt.networkCostLabel})`)
  lines.push(
    `Aggregation value: ${
      receipt.totals.totalAggregationValueRaw == null
        ? '—'
        : `+${fmtToken(receipt.totals.totalAggregationValueRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}`
    }`,
  )
  lines.push('')
  lines.push(`Your signed budget: ${fmtBps(receipt.estimate.maxSlippageBps)}`)
  lines.push(`Realized protocol-fee cost: ${fmtBps(receipt.estimate.realizedFeeBps)}`)
  lines.push('')
  lines.push('Fills:')
  for (const f of receipt.fills) {
    const agg =
      f.nextBestOutRaw == null
        ? 'Aggregation value: —'
        : `Best route: ${bestRouteLabel} -> ${fmtToken(f.amountOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}. Next-best: ${f.nextBestSource} -> ${fmtToken(f.nextBestOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}. Aggregation value: +${fmtToken(f.aggregationValueRaw ?? '0', receipt.tokenOutDecimals, receipt.tokenOutSymbol)}.`
    lines.push(
      `  #${f.executionNumber} ${fmtTimestamp(f.timestamp)} — ${fmtToken(f.amountInRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)} -> ${fmtToken(f.amountOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}, fee ${fmtToken(f.protocolFeeRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}, ${f.txUrl}`,
    )
    lines.push(`    ${agg}`)
  }
  return lines.join('\n')
}

interface FetchedFill {
  execution_number: number
  tx_hash: string | null
  created_at?: string | null
  // [CHORE-DCA-AGGREGATION-VALUE] Additive keeper telemetry — absent on any fill recorded before
  // this feature shipped, or when no runner-up existed that quote round.
  next_best_out?: string | null
  next_best_source?: string | null
}

interface Props {
  order: AutonomousOrder
  onClose: () => void
}

const TERMINAL_TO_SETTLEMENT_STATUS: Partial<Record<AutonomousOrder['status'], SettlementStatus>> = {
  filled: 'completed',
  cancelled: 'cancelled',
}

/** Whether a position is eligible for a settlement receipt at all — completed or cancelled only. */
export function isReceiptEligible(status: AutonomousOrder['status']): boolean {
  return status in TERMINAL_TO_SETTLEMENT_STATUS
}

export default function SettlementReceiptModal({ order, onClose }: Props) {
  const { address } = useAccount()
  const [receipt, setReceipt] = useState<SettlementReceipt | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const settlementStatus = TERMINAL_TO_SETTLEMENT_STATUS[order.status]

  useEffect(() => {
    let cancelled = false
    if (!settlementStatus || !address) {
      setLoading(false)
      setError(!settlementStatus ? 'This position is not yet settled.' : null)
      return
    }

    async function run() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/orders/${order.id}/executions?wallet=${address}`)
        if (!res.ok) throw new Error('Could not load fill history.')
        const data = await res.json()
        const fills: FetchedFill[] = Array.isArray(data.executions) ? data.executions : []

        const built = await buildSettlementReceipt({
          orderHash: order.orderHash,
          status: settlementStatus as SettlementStatus,
          chainId: order.chainId ?? 1,
          tokenInSymbol: order.tokenInSymbol,
          tokenOutSymbol: order.tokenOutSymbol,
          tokenInDecimals: order.tokenInDecimals,
          tokenOutDecimals: order.tokenOutDecimals,
          maxSlippageBps: order.order?.maxSlippageBps ?? null,
          fills: fills
            .filter((f) => !!f.tx_hash)
            .map((f) => ({
              executionNumber: f.execution_number,
              txHash: f.tx_hash as string,
              createdAt: f.created_at,
              nextBestOutRaw: f.next_best_out ?? null,
              nextBestSource: f.next_best_source ?? null,
            })),
        })
        if (!cancelled) setReceipt(built)
      } catch {
        if (!cancelled) setError('Could not build the settlement receipt — try again shortly.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [order, address, settlementStatus])

  // [CHORE-DCA-AGGREGATION-VALUE] Resolved once — same committed router for every fill in the order.
  const bestRouteLabel = useMemo(
    () => resolveBestRouteLabel(order.order?.router, order.chainId ?? 1),
    [order.order?.router, order.chainId],
  )
  const shareText = useMemo(() => (receipt ? receiptToText(receipt, bestRouteLabel) : ''), [receipt, bestRouteLabel])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shareText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable — non-fatal, no destructive fallback */
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="DCA settlement receipt">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative flex max-h-[85vh] w-full animate-slide-up flex-col overflow-hidden rounded-t-2xl border border-cream-08 bg-surface-secondary shadow-2xl shadow-black/40 sm:max-h-[85vh] sm:max-w-md sm:animate-fade-slide-in sm:rounded-2xl">
        <div className="mx-auto mt-3 mb-1 h-1 w-10 shrink-0 rounded-full bg-cream-15 sm:hidden" />

        <div className="shrink-0 border-b border-cream-08 px-5 py-4">
          <h2 className="text-base font-display font-semibold text-cream">Settlement receipt</h2>
          <p className="mt-0.5 text-xs text-cream-50">
            {order.tokenInSymbol} → {order.tokenOutSymbol} · {order.status === 'filled' ? 'Completed' : 'Cancelled'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4" data-testid="settlement-receipt-body">
          {loading && <p className="text-sm text-cream-50">Loading receipt…</p>}
          {!loading && error && <p className="text-sm text-red-400" data-testid="settlement-receipt-error">{error}</p>}

          {!loading && receipt && (
            <>
              {/* Totals */}
              <div className="rounded-xl border border-cream-08 bg-surface-primary p-3 space-y-1.5" data-testid="settlement-totals">
                <div className="flex justify-between text-[13px]">
                  <span className="text-cream-35">Invested</span>
                  <span className="text-cream">{fmtToken(receipt.totals.totalInvestedRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}</span>
                </div>
                <div className="flex justify-between text-[13px]">
                  <span className="text-cream-35">Received</span>
                  <span className="text-cream">{fmtToken(receipt.totals.totalReceivedRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}</span>
                </div>
                <div className="flex justify-between text-[13px]">
                  <span className="text-cream-35">Average price</span>
                  <span className="text-cream">{fmtPrice(receipt.totals.avgPrice, receipt.tokenInSymbol, receipt.tokenOutSymbol)}</span>
                </div>
                <div className="flex justify-between text-[13px]">
                  <span className="text-cream-35">Total protocol fee</span>
                  <span className="text-cream">{fmtToken(receipt.totals.totalProtocolFeeRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}</span>
                </div>
                <div className="flex justify-between text-[13px]">
                  <span className="text-cream-35" title={receipt.networkCostLabel}>Total network cost</span>
                  <span className="text-cream">{fmtEth(receipt.totals.totalNetworkCostWeiRaw)}</span>
                </div>
                <p className="pt-1 text-[11px] text-cream-35">{receipt.networkCostLabel}</p>
              </div>

              {/* [CHORE-DCA-AGGREGATION-VALUE] Total aggregation value — plain, non-alarmist,
                  traceable. "—" (never a fabricated number) when no fill in this position had a
                  runner-up to compare against. */}
              <div className="rounded-xl border border-cream-08 bg-surface-primary p-3" data-testid="settlement-aggregation-value-total">
                <div className="flex justify-between text-[13px]">
                  <span className="text-cream-35">Aggregation value</span>
                  <span className="text-cream">
                    {receipt.totals.totalAggregationValueRaw == null
                      ? '—'
                      : `+${fmtToken(receipt.totals.totalAggregationValueRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}`}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-cream-35">
                  What our routing delivered vs. the next-best quoted source, across every fill.
                </p>
              </div>

              {/* vs upfront estimate */}
              <div className="rounded-xl border border-cream-08 bg-surface-primary p-3" data-testid="settlement-estimate-comparison">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-cream-35">vs your upfront estimate</p>
                <div className="flex justify-between text-[13px]">
                  <span className="text-cream-35">You signed a budget of</span>
                  <span className="text-cream">{fmtBps(receipt.estimate.maxSlippageBps)}</span>
                </div>
                <div className="flex justify-between text-[13px]">
                  <span className="text-cream-35">Realized protocol-fee cost</span>
                  <span className="text-cream">{fmtBps(receipt.estimate.realizedFeeBps)}</span>
                </div>
              </div>

              {/* Per-fill table */}
              <div data-testid="settlement-fills-table">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-cream-35">Fills ({receipt.fills.length})</p>
                <div className="space-y-2">
                  {receipt.fills.length === 0 && (
                    <p className="text-[12px] text-cream-35">No fills executed before this position ended.</p>
                  )}
                  {receipt.fills.map((f) => (
                    <div key={f.txHash} className="rounded-lg border border-cream-08 bg-surface-primary p-2.5 text-[12px]">
                      <div className="flex justify-between text-cream-35">
                        <span>#{f.executionNumber}</span>
                        <span>{fmtTimestamp(f.timestamp)}</span>
                      </div>
                      <div className="mt-1 flex justify-between text-cream">
                        <span>{fmtToken(f.amountInRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}</span>
                        <span>→</span>
                        <span>{fmtToken(f.amountOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}</span>
                      </div>
                      <div className="mt-1 flex justify-between text-cream-35">
                        <span>Fee: {fmtToken(f.protocolFeeRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}</span>
                        <a href={f.txUrl} target="_blank" rel="noopener noreferrer" className="text-cream-gold hover:underline">
                          View tx ↗
                        </a>
                      </div>
                      {/* [CHORE-DCA-AGGREGATION-VALUE] "—" (no claim) when this fill has no
                          runner-up recorded — never a fabricated number. */}
                      <div className="mt-1 text-cream-35" data-testid="fill-aggregation-value">
                        {f.nextBestOutRaw == null ? (
                          <span>Aggregation value: —</span>
                        ) : (
                          <span>
                            Best route: {bestRouteLabel} → {fmtToken(f.amountOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}.{' '}
                            Next-best: {f.nextBestSource} → {fmtToken(f.nextBestOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}.{' '}
                            Aggregation value: +{fmtToken(f.aggregationValueRaw ?? '0', receipt.tokenOutDecimals, receipt.tokenOutSymbol)}.
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-cream-08 px-5 py-3 flex gap-2">
          {receipt && (
            <button
              onClick={handleCopy}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-cream-08 text-[13px] font-semibold text-cream-50 hover:text-cream transition-colors"
            >
              {copied ? 'Copied!' : 'Copy as text'}
            </button>
          )}
          <button
            onClick={onClose}
            className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-gold to-gold-light text-[13px] font-bold uppercase tracking-wider text-[#080B10]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
