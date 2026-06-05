'use client'

/**
 * [SPRINT-9U U2] Autonomous-order review — clear-signing for the Order Engine's EIP-712 order.
 *
 * Limit / DCA / SL·TP creation signs an EIP-712 order struct. Before useOrderEngine requests that
 * signature it FREEZES the order (PendingOrderReview) and shows this modal, which renders the DECODED
 * frozen struct — order type, pair, amounts, trigger/limit price, expiry, min output, router, nonce.
 * It renders EXCLUSIVELY from the frozen `order`, which confirmOrder signs 1:1, so modal == signed
 * payload. Confirm → confirmOrder(); a re-config or chain/account switch invalidates and re-presents.
 */

import { formatUnits } from 'viem'
import { OrderType, PriceCondition } from '@/lib/order-engine'
import type { PendingOrderReview } from '@/hooks/useOrderEngine'

function truncAddr(addr: string): string {
  if (!addr || addr.length <= 12) return addr || '—'
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function fmtAmount(raw: bigint, decimals: number, symbol: string): string {
  const num = parseFloat(formatUnits(raw, decimals))
  if (!isFinite(num)) return '—'
  if (num === 0) return `0 ${symbol}`
  return num < 0.0001 ? `<0.0001 ${symbol}` : `${num.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`
}

function fmtTime(expiry: bigint): string {
  const ms = Number(expiry) * 1000
  const d = new Date(ms)
  if (isNaN(d.getTime())) return `${expiry}`
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const TYPE_LABEL: Record<number, string> = {
  [OrderType.LIMIT]: 'Limit order',
  [OrderType.STOP_LOSS]: 'Stop-loss / Take-profit',
  [OrderType.DCA]: 'DCA (recurring buy)',
}

interface Props {
  order: PendingOrderReview
  onConfirm: () => void
  onCancel: () => void
}

export default function OrderReviewModal({ order, onConfirm, onCancel }: Props) {
  const { order: o, config } = order
  const isDca = config.orderType === OrderType.DCA
  const priceLabel = config.orderType === OrderType.LIMIT ? 'Limit price' : 'Trigger price'
  const dir = o.condition === PriceCondition.ABOVE ? '≥' : '≤'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Review autonomous order">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      <div className="relative flex max-h-[85vh] w-full animate-slide-up flex-col overflow-hidden rounded-t-2xl border border-cream-08 bg-surface-secondary shadow-2xl shadow-black/40 sm:max-h-[85vh] sm:max-w-md sm:animate-fade-slide-in sm:rounded-2xl">
        <div className="mx-auto mt-3 mb-1 h-1 w-10 shrink-0 rounded-full bg-cream-15 sm:hidden" />

        <div className="shrink-0 border-b border-cream-08 px-5 py-4">
          <h2 className="text-base font-display font-semibold text-cream" data-testid="order-type">{TYPE_LABEL[config.orderType] ?? 'Order'}</h2>
          <p className="mt-0.5 text-xs text-cream-50">
            You&apos;re about to <strong>sign an autonomous order</strong> (EIP-712). Verify the exact terms —
            this is precisely what your wallet will sign and what the executor will enforce on-chain.
          </p>
        </div>

        <div className="flex-1 space-y-2.5 overflow-y-auto px-5 py-4 text-sm" data-testid="order-review-body">
          <div className="flex items-center justify-between">
            <span className="text-cream-50">Pair</span>
            <span className="font-medium text-cream" data-testid="order-pair">{config.tokenIn.symbol} &#8594; {config.tokenOut.symbol}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-cream-50">{isDca ? 'Amount per buy' : 'Sell'}</span>
            <span className="font-medium text-cream" data-testid="order-amountin">{fmtAmount(o.amountIn, config.tokenIn.decimals, config.tokenIn.symbol)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-cream-50">Minimum received</span>
            <span className="font-medium text-cream" data-testid="order-minout">{fmtAmount(o.minAmountOut, config.tokenOut.decimals, config.tokenOut.symbol)}</span>
          </div>

          {!isDca && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-cream-50">{priceLabel}</span>
              <span className="font-mono text-cream" data-testid="order-price">{dir} {parseFloat(formatUnits(o.targetPrice, 8)).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
            </div>
          )}
          {isDca && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-cream-50">Schedule</span>
              <span className="font-mono text-cream" data-testid="order-dca">{Number(o.dcaInterval)}s &#215; {Number(o.dcaTotal)} buys</span>
            </div>
          )}

          <div className="flex items-center justify-between text-xs">
            <span className="text-cream-50">Expires</span>
            <span className="font-mono text-cream-65" data-testid="order-expiry">{fmtTime(o.expiry)}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-cream-50">Router (constraint)</span>
            <span className="font-mono text-cream-65" data-testid="order-router">{truncAddr(o.router)}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-cream-50">Nonce</span>
            <span className="font-mono text-cream-65" data-testid="order-nonce">{o.nonce.toString()}</span>
          </div>

          <div className="mt-1 rounded-lg border border-cream-gold/20 bg-cream-gold/5 px-3 py-2 text-[11px] text-cream-gold">
            Signed once now; the executor runs it autonomously when your condition is met — output is
            protected by the on-chain minimum received above. No funds move until then.
          </div>
        </div>

        <div className="shrink-0 border-t border-cream-08 bg-surface-secondary px-5 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:pb-4">
          <button
            onClick={onConfirm}
            className="flex h-12 w-full items-center justify-center rounded-full border-2 border-cream-80 bg-transparent text-[14px] font-bold uppercase tracking-[1.5px] text-cream transition-all hover:bg-cream hover:text-black sm:h-auto sm:py-3"
          >
            Confirm &amp; Sign Order
          </button>
          <button
            onClick={onCancel}
            className="mt-2 flex h-12 w-full items-center justify-center text-center text-xs text-cream-35 transition hover:text-cream-50 sm:h-auto sm:py-2"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
