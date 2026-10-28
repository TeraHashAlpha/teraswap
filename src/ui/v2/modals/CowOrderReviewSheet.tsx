'use client'

import { useRef } from 'react'
import type { PendingCowOrder } from '@/hooks/useSwap'
import { fmtToken } from '@/lib/format'
import { Button } from '../primitives'
import { Sheet } from './Sheet'
import { Mark, ReviewRow, truncAddr } from './parts'

function fmtAmount(raw: bigint, decimals: number, symbol: string): string {
  return `${fmtToken(raw, decimals)} ${symbol}`
}

/** v1's CowOrderReviewModal `fmtDeadline`, unchanged: the time of day and, while it is in the future, `(in ~N min)`. */
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

/**
 * [ADR-025] Round 7 frame 27 (right) — "Review MEV-Protected Order". A CoW swap signs an EIP-712 ORDER, not a transaction; this
 * renders EXCLUSIVELY the frozen `order.message` (what `confirmCowOrder` signs 1:1), with v1's wording and v1's explanation box
 * (the frame's "Solvers compete in a batch auction…" is a re-write; v1's sentence is used). Confirm is a stub — B5 wires it.
 */
export function CowOrderReviewSheet({ order, onConfirm, onCancel }: { order: Pick<PendingCowOrder, 'message' | 'tokenIn' | 'tokenOut' | 'settlement' | 'account'>; onConfirm: () => void; onCancel: () => void }) {
  const { message, tokenIn, tokenOut, settlement, account } = order
  const receiverIsSelf = message.receiver.toLowerCase() === account.toLowerCase()
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Sheet
      name="cow-review"
      size="lg"
      title="Review MEV-Protected Order"
      subtitle={
        <>
          You&apos;re about to <strong className="font-semibold text-v2-text">sign a CoW Protocol order</strong> (no on-chain transaction). Verify the exact terms below — this is precisely what your wallet will sign.
        </>
      }
      onClose={onCancel}
      initialFocusRef={cancelRef}
    >
      <div className="mt-4" data-testid="cow-review-body">
        <ReviewRow label="Sell" testId="cow-sell">
          {fmtAmount(message.sellAmount, tokenIn.decimals, tokenIn.symbol)}
        </ReviewRow>
        <ReviewRow label="Receive (min)" testId="cow-buy">
          {fmtAmount(message.buyAmount, tokenOut.decimals, tokenOut.symbol)}
        </ReviewRow>
        <ReviewRow label="Recipient" wrap>
          <span data-testid="cow-receiver">{truncAddr(message.receiver)}</span> {receiverIsSelf ? <Mark>Your wallet</Mark> : <Mark tone="amber">Other</Mark>}
        </ReviewRow>
        <ReviewRow label="CoW network fee" testId="cow-fee">
          {fmtAmount(message.feeAmount, tokenIn.decimals, tokenIn.symbol)}
        </ReviewRow>
        <ReviewRow label="Valid until" testId="cow-validto">
          {fmtDeadline(message.validTo)}
        </ReviewRow>
        <ReviewRow label="Settlement" testId="cow-settlement">
          {truncAddr(settlement)}
        </ReviewRow>
        <ReviewRow label="App data (incl. 0.1% partner fee)" testId="cow-appdata">
          {truncAddr(message.appData)}
        </ReviewRow>
      </div>

      <p data-testid="cow-explanation" className="mt-4 border-l-2 border-v2-green pl-4 text-[13px] leading-relaxed text-v2-green">
        ✓ MEV-protected via CoW Protocol — solvers compete in a batch auction; you&apos;re shielded from frontrunning/sandwich attacks. Your wallet signs this order off-chain; no gas to submit.
      </p>

      <div className="mt-6 flex flex-col gap-1">
        <Button variant="primary" className="w-full" onClick={onConfirm} data-b5-stub="" data-testid="cow-confirm">
          Confirm &amp; Sign Order
        </Button>
        <Button ref={cancelRef} variant="text" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Sheet>
  )
}
