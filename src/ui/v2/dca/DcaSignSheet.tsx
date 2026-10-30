'use client'

import { useEffect, useRef, useState } from 'react'
import { TYPE_LABEL, fmtAmount, fmtTime, truncAddr } from '@/components/OrderReviewModal'
import { useOrderApproval } from '@/hooks/useOrderApproval'
import type { PendingOrderReview } from '@/hooks/useOrderEngine'
import { OrderType } from '@/lib/order-engine'
import { Button } from '../primitives'
import { Sheet } from '../modals/Sheet'
import { ReviewRow } from '../modals/parts'
import { Notice } from '../swap/QuotePanel'
import { failureCopy, signSteps, type DcaSignPhase } from './dca-model'

/**
 * [ADR-025 / B6b] Round 7 frame 34 — v1's OrderReviewModal as a sheet: the DECODED frozen struct (`pendingOrder.order`, what
 * `confirmOrder` signs 1:1 — pair, total, per buy, minimum received, schedule, expiry, router, nonce, price feed, route-constraint
 * hash), v1's approve-then-sign gate (`useOrderApproval` with OrderReviewModal.tsx:62's arguments: the frozen token, the FULL total,
 * the frozen chain, the v3 predicate) and v1's wording throughout. The same sheet then follows the engine: `signing` (the wallet
 * prompt + POST, v1's `isSubmitting`), `created` (v1's success toast words + View positions) and `failed` (v1's error text verbatim,
 * Retry). One instance across the four phases, so focus never leaves it (the pressed button turns `aria-disabled`, not `disabled`).
 */
export function DcaSignSheet({
  pending, phase, error, onConfirm, onCancel, onRetry, onViewPositions, onDone,
}: {
  pending: PendingOrderReview
  phase: DcaSignPhase
  /** The `order_error` text (v1's taxonomy: "Signature rejected in wallet.", the server's `error`, …); null unless `failed`. */
  error: string | null
  /** v1: `onConfirm={confirmOrder}`. */
  onConfirm: () => void
  /** v1: `onCancel={clearPendingOrder}`. */
  onCancel: () => void
  onRetry: () => void
  onViewPositions: () => void
  onDone: () => void
}) {
  const { order: o, config } = pending
  const isDca = config.orderType === OrderType.DCA
  // v1 OrderReviewModal.tsx:62 — the frozen token, the FULL signed total, the frozen chain, the v3 predicate the signing path uses.
  // The allowance read is idled once the order has left the review (`tokenIn` undefined → the hook's `enabled` is false): the sheet
  // keeps showing the snapshot, nothing is read for it.
  const approval = useOrderApproval(phase === 'frozen' ? o.tokenIn : undefined, o.amountIn, pending.chainId, o.maxSlippageBps !== undefined)
  // Listed on the timeline iff the review opened on an order that still needed the exact approval (v1 renders Approve XOR Sign).
  const [approvalListed, setApprovalListed] = useState(false)
  if (phase === 'frozen' && approval.needsApproval && !approvalListed) setApprovalListed(true)
  const approvalBusy = approval.status === 'approving' || approval.status === 'confirming' || approval.status === 'ready'
  // Per AREA A: o.amountIn is the TOTAL; per-buy = amountIn / dcaTotal (floor) — v1 OrderReviewModal.tsx:66.
  const perBuy = isDca && o.dcaTotal > 0n ? o.amountIn / o.dcaTotal : o.amountIn
  const total = fmtAmount(o.amountIn, config.tokenIn.decimals, config.tokenIn.symbol)

  const cancelRef = useRef<HTMLButtonElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  // The pressed button keeps focus through `signing` (same node, aria-disabled); when the outcome lands, the primary action takes it
  // explicitly so a keyboard user is never left on the page behind.
  useEffect(() => {
    if (phase === 'created' || phase === 'failed') primaryRef.current?.focus({ preventScroll: true })
  }, [phase])

  const busy = phase === 'signing' || (phase === 'frozen' && approval.needsApproval && approvalBusy)
  const failure = phase === 'failed' ? failureCopy(error) : null
  const steps = signSteps({ phase, approvalListed, approvalReady: !approval.needsApproval, symbolIn: config.tokenIn.symbol })

  const primary = (() => {
    if (phase === 'created') return { label: 'View positions', onPress: onViewPositions, testId: 'dca-sign-view-positions' }
    if (phase === 'failed') return { label: 'Retry', onPress: onRetry, testId: 'dca-sign-retry' }
    if (phase === 'signing') return { label: 'Signing order...', onPress: () => {}, testId: 'dca-sign-confirm' }
    if (approval.needsApproval) {
      // v1 OrderReviewModal.tsx:163-167
      const label = approval.status === 'approving' ? 'Confirm in wallet…' : approval.status === 'confirming' ? 'Approving…' : `Approve ${config.tokenIn.symbol}`
      return { label, onPress: () => void approval.approve(), testId: 'dca-sign-approve' }
    }
    return { label: 'Confirm & Sign Order', onPress: onConfirm, testId: 'dca-sign-confirm' }
  })()
  const secondary = phase === 'created' || phase === 'failed' ? { label: 'New DCA', onPress: onDone } : { label: 'Cancel', onPress: onCancel }
  const title = phase === 'created' ? 'DCA order placed' : failure ? failure.title : (TYPE_LABEL[config.orderType] ?? 'Order')
  const subtitle =
    phase === 'created' ? 'Your DCA is live — it will execute automatically on schedule.'
    : failure ? null
    : (
      <>
        You&apos;re about to <strong className="font-semibold text-v2-text">sign an autonomous order</strong> (EIP-712). Verify the exact terms —
        this is precisely what your wallet will sign and what the executor will enforce on-chain.
      </>
    )
  const dismissable = phase !== 'signing' && !busy
  const onClose = phase === 'frozen' ? onCancel : onDone

  return (
    <Sheet name="dca-sign" size="md" title={title} subtitle={subtitle} onClose={onClose} initialFocusRef={cancelRef} dismissOnBackdrop={false} dismissOnEscape={dismissable}>
      <div className="mt-4 flex flex-col" data-testid="dca-sign-body" data-phase={phase}>
        <ReviewRow label="Pair" testId="dca-sign-pair">{config.tokenIn.symbol} → {config.tokenOut.symbol}</ReviewRow>
        <ReviewRow label={isDca ? 'Total to spend' : 'Sell'} testId="dca-sign-amountin">{total}</ReviewRow>
        {isDca && <ReviewRow label="Per buy" testId="dca-sign-perbuy">{fmtAmount(perBuy, config.tokenIn.decimals, config.tokenIn.symbol)}</ReviewRow>}
        <ReviewRow label="Minimum received" testId="dca-sign-minout">{fmtAmount(o.minAmountOut, config.tokenOut.decimals, config.tokenOut.symbol)}</ReviewRow>
        {isDca && <ReviewRow label="Schedule" testId="dca-sign-dca">{Number(o.dcaInterval)}s × {Number(o.dcaTotal)} buys</ReviewRow>}
        <ReviewRow label="Expires" testId="dca-sign-expiry">{fmtTime(o.expiry)}</ReviewRow>
        {phase !== 'created' && (
          <>
            <ReviewRow label="Router (constraint)" testId="dca-sign-router">{truncAddr(o.router)}</ReviewRow>
            <ReviewRow label="Nonce" testId="dca-sign-nonce">{o.nonce.toString()}</ReviewRow>
            <ReviewRow label="Price feed (oracle)" testId="dca-sign-pricefeed">{truncAddr(o.priceFeed)}</ReviewRow>
            <ReviewRow label="Route constraint hash" testId="dca-sign-routerhash">{truncAddr(o.routerDataHash)}</ReviewRow>
          </>
        )}
      </div>

      {phase === 'frozen' && (
        <p data-testid="dca-sign-note" className="mt-4 border-l-2 border-v2-cream pl-4 text-[13px] leading-relaxed text-v2-text/90">
          {approval.needsApproval
            ? `Two steps: first approve the exact ${total} on-chain (one-time, no infinite approvals), then sign the order. The executor then runs it autonomously — output is protected by the on-chain minimum received above.`
            : 'Approved on-chain — now sign the order. The executor runs it autonomously when your condition is met; output is protected by the on-chain minimum received above. No funds move until then.'}
        </p>
      )}

      {failure && (
        <div className="mt-4">
          <Notice tone="red" testId="dca-sign-error">
            <span className="font-semibold">{failure.title}</span>
            <span className="mt-0.5 block text-v2-muted">{failure.description}</span>
          </Notice>
        </div>
      )}

      <ol className="ts-exec-steps" aria-live="polite" data-testid="dca-sign-steps">
        {steps.map((s) => (
          <li key={s.label} data-step={s.state} aria-current={s.state === 'active' ? 'step' : undefined} className="ts-exec-step">
            <span aria-hidden="true" data-node={s.state} className="ts-exec-node">
              {s.state === 'done' ? '✓' : s.state === 'failed' ? '✕' : null}
            </span>
            <span className={s.state === 'active' || s.state === 'failed' ? 'font-semibold text-v2-text' : s.state === 'todo' ? 'text-v2-dim' : 'text-v2-text/90'}>{s.label}</span>
          </li>
        ))}
      </ol>

      {approval.error && phase === 'frozen' && (
        <p className="mt-2 text-center text-[12px] text-v2-red" data-testid="dca-sign-approve-error">{approval.error}</p>
      )}

      <div className="mt-6 flex flex-col gap-1">
        <Button
          ref={primaryRef}
          variant="primary"
          className="w-full aria-disabled:cursor-wait aria-disabled:bg-v2-surface2 aria-disabled:text-v2-dim"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => !busy && primary.onPress()}
          data-testid={primary.testId}
        >
          {primary.label}
        </Button>
        <Button ref={cancelRef} variant="text" className="w-full" aria-disabled={!dismissable || undefined} onClick={() => dismissable && secondary.onPress()} data-testid="dca-sign-secondary">
          {secondary.label}
        </Button>
      </div>
    </Sheet>
  )
}
