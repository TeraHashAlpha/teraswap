'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import { getWhitelistedRouters, type AutonomousOrder } from '@/lib/order-engine'
import { buildSettlementReceipt, type SettlementReceipt, type SettlementStatus } from '@/lib/dca/settlement-receipt'
import { fmtDate, fmtGas, fmtPct, fmtToken as fmtTokenValue } from '@/lib/format'
import { Button } from '../primitives'
import { Sheet } from '../modals/Sheet'
import { ReviewRow } from '../modals/parts'

// v1 SettlementReceiptModal's formatters, verbatim (module-private there).
function fmtToken(raw: string, decimals: number, symbol: string): string {
  return `${fmtTokenValue(BigInt(raw), decimals)} ${symbol}`
}
function fmtEth(wei: string): string {
  const num = Number(formatUnits(BigInt(wei), 18))
  if (!Number.isFinite(num) || num === 0) return '0 ETH'
  return `${fmtGas(num)} ETH`
}
function fmtPrice(price: number | null, tokenInSymbol: string, tokenOutSymbol: string): string {
  if (price == null) return '—'
  return `${fmtTokenValue(price)} ${tokenInSymbol} / ${tokenOutSymbol}`
}
function fmtBps(bps: number | null): string {
  if (bps == null) return '—'
  return fmtPct(bps / 100)
}
function fmtTimestamp(ms: number | null): string {
  if (ms == null) return '—'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return fmtDate(d)
}

/** v1 `resolveBestRouteLabel`: the order's committed router against the chain's whitelist; never a fabricated name. */
export function bestRouteLabel(router: string | null | undefined, chainId: number): string {
  if (!router) return 'our route'
  const routers = getWhitelistedRouters(chainId)
  const match = Object.values(routers).find((r) => r.address.toLowerCase() === router.toLowerCase())
  return match?.label ?? 'our route'
}

/** v1 `receiptToText` — the "Copy as text" payload, line for line. */
export function receiptToText(receipt: SettlementReceipt, routeLabel: string): string {
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
        : `Best route: ${routeLabel} -> ${fmtToken(f.amountOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}. Next-best: ${f.nextBestSource} -> ${fmtToken(f.nextBestOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}. Aggregation value: +${fmtToken(f.aggregationValueRaw ?? '0', receipt.tokenOutDecimals, receipt.tokenOutSymbol)}.`
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
  next_best_out?: string | null
  next_best_source?: string | null
}

const TERMINAL_TO_SETTLEMENT_STATUS: Partial<Record<AutonomousOrder['status'], SettlementStatus>> = { filled: 'completed', cancelled: 'cancelled' }

/** v1 `isReceiptEligible`: completed or cancelled positions only. */
export function isReceiptEligible(status: AutonomousOrder['status']): boolean {
  return status in TERMINAL_TO_SETTLEMENT_STATUS
}

const SECTION = 'mt-4 border-t border-[color:var(--hairline)] pt-3'
const CAPS = 'font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted'

/**
 * [B7] v1 SettlementReceiptModal as a round-7 sheet: the same `/api/orders/:id/executions` read, the same `buildSettlementReceipt` (every
 * amount re-decoded from each fill's on-chain event — v1's lib, unchanged), v1's every label and line, v1's "Copy as text" payload. Close
 * is the sheet's one cream button; focus returns to "View receipt" (the Sheet's contract).
 */
export function ReceiptSheet({ order, onClose }: { order: AutonomousOrder; onClose: () => void }) {
  const { address } = useAccount()
  const [receipt, setReceipt] = useState<SettlementReceipt | null>(null)
  const [fetchLoading, setLoading] = useState(true)
  const [fetchError, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const settlementStatus = TERMINAL_TO_SETTLEMENT_STATUS[order.status]
  // v1 sets these two in its effect when there is nothing to fetch; derived here (same values, no effect-set).
  const blocked = !settlementStatus || !address
  const loading = blocked ? false : fetchLoading
  const error = blocked ? (!settlementStatus ? 'This position is not yet settled.' : null) : fetchError

  useEffect(() => {
    let cancelled = false
    if (blocked) return
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
  }, [order, address, settlementStatus, blocked])

  const routeLabel = useMemo(() => bestRouteLabel(order.order?.router, order.chainId ?? 1), [order.order?.router, order.chainId])
  const shareText = useMemo(() => (receipt ? receiptToText(receipt, routeLabel) : ''), [receipt, routeLabel])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shareText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable — non-fatal, as v1 */
    }
  }

  return (
    <Sheet
      name="dca-receipt"
      size="md"
      title="Settlement receipt"
      subtitle={`${order.tokenInSymbol} → ${order.tokenOutSymbol} · ${order.status === 'filled' ? 'Completed' : 'Cancelled'}`}
      onClose={onClose}
      initialFocusRef={closeRef}
    >
      <div className="mt-2" data-testid="settlement-receipt-body">
        {loading && <p className="text-[14px] text-v2-muted">Loading receipt…</p>}
        {!loading && error && <p className="text-[14px] text-v2-red" data-testid="settlement-receipt-error">{error}</p>}
        {!loading && receipt && (
          <>
            <div data-testid="settlement-totals">
              <ReviewRow label="Invested">{fmtToken(receipt.totals.totalInvestedRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}</ReviewRow>
              <ReviewRow label="Received">{fmtToken(receipt.totals.totalReceivedRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}</ReviewRow>
              <ReviewRow label="Average price">{fmtPrice(receipt.totals.avgPrice, receipt.tokenInSymbol, receipt.tokenOutSymbol)}</ReviewRow>
              <ReviewRow label="Total protocol fee">{fmtToken(receipt.totals.totalProtocolFeeRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}</ReviewRow>
              <ReviewRow label={<span title={receipt.networkCostLabel}>Total network cost</span>}>{fmtEth(receipt.totals.totalNetworkCostWeiRaw)}</ReviewRow>
              <p className="pt-1 text-[12px] text-v2-muted">{receipt.networkCostLabel}</p>
            </div>

            <div className={SECTION} data-testid="settlement-aggregation-value-total">
              <ReviewRow label="Aggregation value">
                {receipt.totals.totalAggregationValueRaw == null
                  ? '—'
                  : `+${fmtToken(receipt.totals.totalAggregationValueRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}`}
              </ReviewRow>
              <p className="mt-1 text-[12px] text-v2-muted">What our routing delivered vs. the next-best quoted source, across every fill.</p>
            </div>

            <div className={SECTION} data-testid="settlement-estimate-comparison">
              <p className={CAPS}>vs your upfront estimate</p>
              <ReviewRow label="You signed a budget of">{fmtBps(receipt.estimate.maxSlippageBps)}</ReviewRow>
              <ReviewRow label="Realized protocol-fee cost">{fmtBps(receipt.estimate.realizedFeeBps)}</ReviewRow>
            </div>

            <div className={SECTION} data-testid="settlement-fills-table">
              <p className={CAPS}>Fills ({receipt.fills.length})</p>
              {receipt.fills.length === 0 && <p className="mt-2 text-[13px] text-v2-muted">No fills executed before this position ended.</p>}
              <ul>
                {receipt.fills.map((f) => (
                  <li key={f.txHash} className="ts-sheet-row py-2 text-[13px]">
                    <div className="flex justify-between font-v2-mono text-v2-muted">
                      <span>#{f.executionNumber}</span>
                      <span>{fmtTimestamp(f.timestamp)}</span>
                    </div>
                    <div className="mt-1 flex justify-between gap-3 font-v2-mono tabular-nums text-v2-text">
                      <span>{fmtToken(f.amountInRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}</span>
                      <span>→</span>
                      <span>{fmtToken(f.amountOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}</span>
                    </div>
                    <div className="mt-1 flex justify-between text-v2-muted">
                      <span>Fee: {fmtToken(f.protocolFeeRaw, receipt.tokenInDecimals, receipt.tokenInSymbol)}</span>
                      <a href={f.txUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center text-v2-cream underline-offset-2 hover:underline">
                        View tx ↗
                      </a>
                    </div>
                    <div className="mt-1 text-v2-muted" data-testid="fill-aggregation-value">
                      {f.nextBestOutRaw == null ? (
                        <span>Aggregation value: —</span>
                      ) : (
                        <span>
                          Best route: {routeLabel} → {fmtToken(f.amountOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}.{' '}
                          Next-best: {f.nextBestSource} → {fmtToken(f.nextBestOutRaw, receipt.tokenOutDecimals, receipt.tokenOutSymbol)}.{' '}
                          Aggregation value: +{fmtToken(f.aggregationValueRaw ?? '0', receipt.tokenOutDecimals, receipt.tokenOutSymbol)}.
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
      <div className="mt-6 flex flex-col gap-1">
        <Button ref={closeRef} variant="primary" className="w-full" onClick={onClose} data-testid="settlement-receipt-close">
          Close
        </Button>
        {receipt && (
          <Button variant="text" className="w-full" onClick={() => void handleCopy()} data-testid="settlement-receipt-copy">
            {copied ? 'Copied!' : 'Copy as text'}
          </Button>
        )}
      </div>
    </Sheet>
  )
}
