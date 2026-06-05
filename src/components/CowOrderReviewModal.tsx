'use client'

/**
 * [SPRINT-9U U1] CoW order review — clear-signing for EIP-712 typed-data orders.
 *
 * A CoW swap signs an ORDER (typed data), not a transaction, so the 9R TransactionPreview (which
 * decodes calldata) doesn't apply. Before useSwap requests the EIP-712 signature it FREEZES the exact
 * order payload (PendingCowOrder) and shows this modal, which renders the DECODED frozen order —
 * sell/buy + human amounts, receiver, validTo, feeAmount, appData/partner-fee summary, settlement
 * contract. It renders EXCLUSIVELY from the frozen `order.message` that confirmCowOrder signs 1:1, so
 * the modal == the signed payload. Confirm → confirmCowOrder(); any rebuild (re-quote) or chain/account
 * switch invalidates the frozen order and re-presents.
 */

import { formatUnits } from 'viem'
import type { PendingCowOrder } from '@/hooks/useSwap'

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

function fmtDeadline(validTo: number): string {
  try {
    const d = new Date(validTo * 1000)
    if (isNaN(d.getTime())) return `${validTo}`
    const mins = Math.round((validTo * 1000 - Date.now()) / 60000)
    return `${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}${mins > 0 ? ` (in ~${mins} min)` : ''}`
  } catch {
    return `${validTo}`
  }
}

interface Props {
  order: PendingCowOrder
  onConfirm: () => void
  onCancel: () => void
}

export default function CowOrderReviewModal({ order, onConfirm, onCancel }: Props) {
  const { message, tokenIn, tokenOut, settlement, account } = order
  const receiverIsSelf = message.receiver.toLowerCase() === account.toLowerCase()

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Review MEV-protected order">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      <div className="relative flex max-h-[85vh] w-full animate-slide-up flex-col overflow-hidden rounded-t-2xl border border-cream-08 bg-surface-secondary shadow-2xl shadow-black/40 sm:max-h-[85vh] sm:max-w-md sm:animate-fade-slide-in sm:rounded-2xl">
        <div className="mx-auto mt-3 mb-1 h-1 w-10 shrink-0 rounded-full bg-cream-15 sm:hidden" />

        <div className="shrink-0 border-b border-cream-08 px-5 py-4">
          <h2 className="text-base font-display font-semibold text-cream">Review MEV-Protected Order</h2>
          <p className="mt-0.5 text-xs text-cream-50">
            You&apos;re about to <strong>sign a CoW Protocol order</strong> (no on-chain transaction). Verify the
            exact terms below — this is precisely what your wallet will sign.
          </p>
        </div>

        <div className="flex-1 space-y-2.5 overflow-y-auto px-5 py-4 text-sm" data-testid="cow-review-body">
          {/* Sell / Buy */}
          <div className="flex items-center justify-between">
            <span className="text-cream-50">Sell</span>
            <span className="font-medium text-cream" data-testid="cow-sell">{fmtAmount(message.sellAmount, tokenIn.decimals, tokenIn.symbol)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-cream-50">Receive (min)</span>
            <span className="font-medium text-cream" data-testid="cow-buy">{fmtAmount(message.buyAmount, tokenOut.decimals, tokenOut.symbol)}</span>
          </div>

          {/* Receiver */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-cream-50">Recipient</span>
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-cream" data-testid="cow-receiver">{truncAddr(message.receiver)}</span>
              {receiverIsSelf
                ? <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">Your wallet</span>
                : <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">Other</span>}
            </span>
          </div>

          {/* Network fee (sell token) */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-cream-50">CoW network fee</span>
            <span className="font-mono text-cream-65" data-testid="cow-fee">{fmtAmount(message.feeAmount, tokenIn.decimals, tokenIn.symbol)}</span>
          </div>

          {/* Valid until */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-cream-50">Valid until</span>
            <span className="font-mono text-cream-65" data-testid="cow-validto">{fmtDeadline(message.validTo)}</span>
          </div>

          {/* Settlement + appData (trust surface) */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-cream-50">Settlement</span>
            <span className="font-mono text-cream-65" data-testid="cow-settlement">{truncAddr(settlement)}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-cream-50">App data (incl. 0.1% partner fee)</span>
            <span className="font-mono text-cream-35" data-testid="cow-appdata">{truncAddr(message.appData)}</span>
          </div>

          <div className="mt-1 rounded-lg border border-success/20 bg-success/5 px-3 py-2 text-[11px] text-success">
            &#10003; MEV-protected via CoW Protocol — solvers compete in a batch auction; you&apos;re shielded
            from frontrunning/sandwich attacks. Your wallet signs this order off-chain; no gas to submit.
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
