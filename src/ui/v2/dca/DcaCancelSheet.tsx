'use client'

import { useRef } from 'react'
import { TYPE_LABEL, fmtAmount, fmtTime, truncAddr } from '@/components/OrderReviewModal'
import type { PendingCancelReview } from '@/hooks/useOrderEngine'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { getChainName } from '@/lib/chains/registry'
import { OrderType, type AutonomousOrder } from '@/lib/order-engine'
import { Button } from '../primitives'
import { Sheet } from '../modals/Sheet'
import { ReviewRow } from '../modals/parts'

function orderTypeLabel(o: AutonomousOrder): string {
  return TYPE_LABEL[o.orderType] ?? 'Order'
}

/**
 * [ADR-025 / B6b] Round 7 frame 41 — v1's OrderCancelReviewModal as a sheet. The engine's `cancelOrder` / `cancelAllOrders` only FREEZE
 * a plan (`pendingCancel`); nothing is sent until this sheet's confirm calls `confirmCancel` (DCAPanel.tsx:257
 * `onConfirm={confirmCancel} onCancel={clearPendingCancel}`), which executes the frozen payload 1:1. Every word is v1's; the tx count is
 * v1's arithmetic (a v3 DCA never rides the nonce invalidation — one cancelOrder() each). Keep is the safe default focus.
 */
export function DcaCancelSheet({ review, onConfirm, onCancel }: { review: PendingCancelReview; onConfirm: () => void; onCancel: () => void }) {
  const keepRef = useRef<HTMLButtonElement>(null)
  const isInvalidate = review.action === 'invalidate'
  const nonceTxCount = review.action === 'invalidate' ? (review.newNonce !== null ? 1 : 0) + review.v3Batches.length : 0
  const cancelTxCount = review.action === 'invalidate' ? review.v3DcaOrders.length : 0
  const totalTxCount = nonceTxCount + cancelTxCount

  const subtitle = isInvalidate ? (
    cancelTxCount > 0 ? (
      <>You&apos;re about to send <strong className="font-semibold text-v2-text">{totalTxCount} on-chain transactions</strong> ({nonceTxCount > 0 ? `${nonceTxCount} nonce invalidation${nonceTxCount > 1 ? 's' : ''} + ` : ''}{cancelTxCount} individual cancelOrder call{cancelTxCount > 1 ? 's' : ''} for the DCA orders below), plus one removal signature per order. Your wallet will prompt {totalTxCount} times. Verify the exact plan.</>
    ) : (
      <>You&apos;re about to <strong className="font-semibold text-v2-text">invalidate your order nonce on-chain</strong> (one transaction), cancelling every active order below, plus one removal signature per order. Verify the exact plan.</>
    )
  ) : (
    <>You&apos;re about to <strong className="font-semibold text-v2-text">cancel this order on-chain</strong> (one transaction) plus sign one removal message (EIP-712). Verify the exact order being cancelled.</>
  )

  return (
    <Sheet name="dca-cancel" size="md" title={isInvalidate ? 'Cancel all orders' : 'Cancel order'} subtitle={subtitle} onClose={onCancel} initialFocusRef={keepRef} dismissOnBackdrop={false}>
      <div className="mt-4 flex flex-col" data-testid="dca-cancel-body" data-action={review.action}>
        {review.action === 'cancel' ? (
          <>
            <ReviewRow label="Order type" testId="dca-cancel-type">{orderTypeLabel(review.order)}</ReviewRow>
            <ReviewRow label="Pair" testId="dca-cancel-pair">{review.order.tokenInSymbol || '?'} → {review.order.tokenOutSymbol || '?'}</ReviewRow>
            <ReviewRow label={review.order.orderType === OrderType.DCA ? 'Amount (total)' : 'Amount'} testId="dca-cancel-amount">
              {fmtAmount(review.orderStruct.amountIn, review.order.tokenInDecimals || 18, review.order.tokenInSymbol || '?')}
            </ReviewRow>
            <ReviewRow label="Order nonce" testId="dca-cancel-nonce">{review.orderStruct.nonce.toString()}</ReviewRow>
            <ReviewRow label="Expires" testId="dca-cancel-expiry">{fmtTime(review.orderStruct.expiry)}</ReviewRow>
            {/* The orderHash binds the off-chain removal signature to exactly this order's row. */}
            <ReviewRow label="Order hash" testId="dca-cancel-orderhash">{truncAddr(review.order.orderHash)}</ReviewRow>
            <p className="mt-4 border-l-2 border-v2-cream pl-4 text-[13px] leading-relaxed text-v2-text/90">
              After the on-chain cancel confirms, this order can never execute — the contract marks
              its hash cancelled. No funds move.
            </p>
          </>
        ) : (
          <>
            <ReviewRow label="Orders affected" testId="dca-invalidate-count">{review.affectedOrders.length}</ReviewRow>
            <ReviewRow label="On-chain transactions" testId="dca-invalidate-tx-summary" wrap>
              {totalTxCount} total
              {nonceTxCount > 0 ? ` (${nonceTxCount} nonce invalidation${nonceTxCount > 1 ? 's' : ''})` : ''}
              {cancelTxCount > 0 ? ` (${cancelTxCount} cancelOrder call${cancelTxCount > 1 ? 's' : ''} — DCA orders)` : ''}
            </ReviewRow>
            {review.newNonce !== null && <ReviewRow label="New invalidation nonce" testId="dca-invalidate-nonce">{review.newNonce.toString()}</ReviewRow>}
            <ul className="mt-2 flex flex-col" data-testid="dca-invalidate-rows">
              {review.affectedOrders.map((o) => (
                <li key={o.id} data-testid="dca-invalidate-row" className="ts-sheet-row flex items-center justify-between gap-4 py-2 text-[13px]">
                  <span className="font-medium text-v2-text">{o.tokenInSymbol || '?'} → {o.tokenOutSymbol || '?'}</span>
                  <span className="text-v2-muted">{orderTypeLabel(o)} · nonce {String(o.order?.nonce ?? '—')}</span>
                </li>
              ))}
            </ul>
            {review.skippedOrders.length > 0 && (
              <p data-testid="dca-invalidate-skipped" className="mt-3 border-l-2 border-v2-amber pl-4 text-[13px] leading-relaxed text-v2-amber">
                {review.skippedOrders.length} order{review.skippedOrders.length > 1 ? 's' : ''} on other
                chains ({[...new Set(review.skippedOrders.map((o) => getChainName(o.chainId ?? DEFAULT_CHAIN_ID)))].join(', ')}) were
                NOT included — switch your wallet to that chain and run Cancel All again to cancel them.
              </p>
            )}
            <p className="mt-4 border-l-2 border-v2-cream pl-4 text-[13px] leading-relaxed text-v2-text/90">
              {cancelTxCount > 0 ? (
                <>Non-DCA orders above are cancelled by the nonce invalidation; each DCA order needs its
                own on-chain cancelOrder call (the contract never checks the nonce for DCA) — expect{' '}
                {totalTxCount} wallet prompts. No funds move.</>
              ) : (
                <>Invalidating the nonce on-chain cancels every order above at once — orders signed with a
                lower nonce can never execute afterwards. No funds move.</>
              )}
            </p>
          </>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-1">
        <Button variant="text" tone="danger" className="w-full" onClick={onConfirm} data-testid="dca-cancel-confirm">
          {isInvalidate ? 'Confirm — Cancel All' : 'Confirm — Cancel Order'}
        </Button>
        <Button ref={keepRef} variant="text" className="w-full" onClick={onCancel} data-testid="dca-cancel-keep">
          {isInvalidate ? 'Keep my orders' : 'Keep this order'}
        </Button>
      </div>
    </Sheet>
  )
}
