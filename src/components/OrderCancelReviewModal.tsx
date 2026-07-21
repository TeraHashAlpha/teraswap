'use client'

/**
 * [CANCEL-REVIEW] Cancel/invalidate review — clear-signing for order cancellation (9U follow-up).
 *
 * Cancelling an order sends an on-chain cancel tx + an EIP-712 removal signature (Supabase row);
 * "Cancel all" sends one invalidateNonces tx + one removal signature per order. Before useOrderEngine
 * executes any of these it FREEZES the plan (PendingCancelReview) and shows this modal, which renders the
 * DECODED frozen payload — action, affected order(s): pair, amount, type, nonce, expiry — exclusively
 * from the frozen struct that confirmCancel executes 1:1, so modal == executed payload. Confirm →
 * confirmCancel(); a chain/account switch invalidates and re-presents. Chain-agnostic (active chain).
 */

import { OrderType } from '@/lib/order-engine'
import type { AutonomousOrder } from '@/lib/order-engine'
import type { PendingCancelReview } from '@/hooks/useOrderEngine'
import { truncAddr, fmtAmount, fmtTime, TYPE_LABEL } from './OrderReviewModal'

interface Props {
  review: PendingCancelReview
  onConfirm: () => void
  onCancel: () => void
}

function orderTypeLabel(o: AutonomousOrder): string {
  return TYPE_LABEL[o.orderType] ?? 'Order'
}

export default function OrderCancelReviewModal({ review, onConfirm, onCancel }: Props) {
  const isInvalidate = review.action === 'invalidate'
  // [BUG-MASS-CANCEL-DCA-ONCHAIN] The nonce invalidation NEVER covers v3 DCA orders (the contract's
  // DCA branch skips the bitmap check entirely — TeraSwapOrderExecutorV3.sol executeOrder ~L453 vs
  // ~L499) — confirmCancel sends one on-chain cancelOrder() per DCA order in addition to whichever
  // nonce tx(es) cover everything else. Compute the REAL tx count so the copy never overstates a
  // single blanket invalidation.
  const nonceTxCount = review.action === 'invalidate'
    ? (review.newNonce !== null ? 1 : 0) + review.v3Batches.length
    : 0
  const cancelTxCount = review.action === 'invalidate' ? review.v3DcaOrders.length : 0
  const totalTxCount = nonceTxCount + cancelTxCount

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Review order cancellation">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      <div className="relative flex max-h-[85vh] w-full animate-slide-up flex-col overflow-hidden rounded-t-2xl border border-cream-08 bg-surface-secondary shadow-2xl shadow-black/40 sm:max-h-[85vh] sm:max-w-md sm:animate-fade-slide-in sm:rounded-2xl">
        <div className="mx-auto mt-3 mb-1 h-1 w-10 shrink-0 rounded-full bg-cream-15 sm:hidden" />

        <div className="shrink-0 border-b border-cream-08 px-5 py-4">
          <h2 className="text-base font-display font-semibold text-cream" data-testid="cancel-action">
            {isInvalidate ? 'Cancel all orders' : 'Cancel order'}
          </h2>
          <p className="mt-0.5 text-xs text-cream-50">
            {isInvalidate ? (
              cancelTxCount > 0 ? (
                <>You&apos;re about to send <strong>{totalTxCount} on-chain transactions</strong> ({nonceTxCount > 0 ? `${nonceTxCount} nonce invalidation${nonceTxCount > 1 ? 's' : ''} + ` : ''}{cancelTxCount} individual cancelOrder call{cancelTxCount > 1 ? 's' : ''} for the DCA orders below), plus one removal signature per order. Your wallet will prompt {totalTxCount} times. Verify the exact plan.</>
              ) : (
                <>You&apos;re about to <strong>invalidate your order nonce on-chain</strong> (one transaction), cancelling every active order below, plus one removal signature per order. Verify the exact plan.</>
              )
            ) : (
              <>You&apos;re about to <strong>cancel this order on-chain</strong> (one transaction) plus sign one removal message (EIP-712). Verify the exact order being cancelled.</>
            )}
          </p>
        </div>

        <div className="flex-1 space-y-2.5 overflow-y-auto px-5 py-4 text-sm" data-testid="cancel-review-body">
          {review.action === 'cancel' ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-cream-50">Order type</span>
                <span className="font-medium text-cream" data-testid="cancel-type">{orderTypeLabel(review.order)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-cream-50">Pair</span>
                <span className="font-medium text-cream" data-testid="cancel-pair">{review.order.tokenInSymbol || '?'} &#8594; {review.order.tokenOutSymbol || '?'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-cream-50">{review.order.orderType === OrderType.DCA ? 'Amount (total)' : 'Amount'}</span>
                <span className="font-medium text-cream" data-testid="cancel-amount">
                  {fmtAmount(review.orderStruct.amountIn, review.order.tokenInDecimals || 18, review.order.tokenInSymbol || '?')}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-cream-50">Order nonce</span>
                <span className="font-mono text-cream-65" data-testid="cancel-nonce">{review.orderStruct.nonce.toString()}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-cream-50">Expires</span>
                <span className="font-mono text-cream-65" data-testid="cancel-expiry">{fmtTime(review.orderStruct.expiry)}</span>
              </div>
              {/* The orderHash binds the off-chain removal signature to exactly this order's row. */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-cream-50">Order hash</span>
                <span className="font-mono text-cream-35" data-testid="cancel-orderhash">{truncAddr(review.order.orderHash)}</span>
              </div>

              <div className="mt-1 rounded-lg border border-cream-gold/20 bg-cream-gold/5 px-3 py-2 text-[11px] text-cream-gold">
                After the on-chain cancel confirms, this order can never execute — the contract marks
                its hash cancelled. No funds move.
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-cream-50">Orders affected</span>
                <span className="font-medium text-cream" data-testid="invalidate-count">{review.affectedOrders.length}</span>
              </div>
              {/* [BUG-MASS-CANCEL-DCA-ONCHAIN] Real tx breakdown — DCA orders never ride the nonce
                  invalidation, so state the actual per-tx-type count instead of implying one tx. */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-cream-50">On-chain transactions</span>
                <span className="font-medium text-cream" data-testid="invalidate-tx-summary">
                  {totalTxCount} total
                  {nonceTxCount > 0 ? ` (${nonceTxCount} nonce invalidation${nonceTxCount > 1 ? 's' : ''})` : ''}
                  {cancelTxCount > 0 ? ` (${cancelTxCount} cancelOrder call${cancelTxCount > 1 ? 's' : ''} — DCA orders)` : ''}
                </span>
              </div>
              {/* [SPRINT-V3-P3] newNonce is null when there are no v2 orders to invalidate
                  (a v3-only cancel-all) — the v2 invalidateNonces() call is skipped entirely. */}
              {review.newNonce !== null && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-cream-50">New invalidation nonce</span>
                  <span className="font-mono text-cream-65" data-testid="invalidate-nonce">{review.newNonce.toString()}</span>
                </div>
              )}

              <div className="space-y-1.5">
                {review.affectedOrders.map((o) => (
                  <div key={o.id} data-testid="invalidate-row" className="flex items-center justify-between rounded-lg border border-cream-08 bg-surface-tertiary px-3 py-2 text-xs">
                    <span className="font-medium text-cream">{o.tokenInSymbol || '?'} &#8594; {o.tokenOutSymbol || '?'}</span>
                    <span className="text-cream-50">{orderTypeLabel(o)} · nonce {String(o.order?.nonce ?? '—')}</span>
                  </div>
                ))}
              </div>

              <div className="mt-1 rounded-lg border border-cream-gold/20 bg-cream-gold/5 px-3 py-2 text-[11px] text-cream-gold">
                {cancelTxCount > 0 ? (
                  <>Non-DCA orders above are cancelled by the nonce invalidation; each DCA order needs its
                  own on-chain cancelOrder call (the contract never checks the nonce for DCA) — expect{' '}
                  {totalTxCount} wallet prompts. No funds move.</>
                ) : (
                  <>Invalidating the nonce on-chain cancels every order above at once — orders signed with a
                  lower nonce can never execute afterwards. No funds move.</>
                )}
              </div>
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-cream-08 bg-surface-secondary px-5 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:pb-4">
          <button
            onClick={onConfirm}
            data-testid="cancel-confirm"
            className="flex h-12 w-full items-center justify-center rounded-full border-2 border-red-400/80 bg-transparent text-[14px] font-bold uppercase tracking-[1.5px] text-red-300 transition-all hover:bg-red-400 hover:text-black sm:h-auto sm:py-3"
          >
            {isInvalidate ? 'Confirm — Cancel All' : 'Confirm — Cancel Order'}
          </button>
          <button
            onClick={onCancel}
            data-testid="cancel-keep"
            className="mt-2 flex h-12 w-full items-center justify-center text-center text-xs text-cream-35 transition hover:text-cream-50 sm:h-auto sm:py-2"
          >
            {isInvalidate ? 'Keep my orders' : 'Keep this order'}
          </button>
        </div>
      </div>
    </div>
  )
}
