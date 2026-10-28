'use client'

import { useMemo, useRef, useState } from 'react'
import { decodeTransactionPreview } from '@/lib/calldata-decoder'
import { FEE_COLLECTOR_ADDRESS } from '@/lib/constants'
import { fmtToken } from '@/lib/format'
import { Button } from '../primitives'
import { shortAddress } from '../shell/format-address'
import { TierNotice } from '../swap/TierNotice'
import { Sheet } from './Sheet'
import { ConsentBlock, Mark, ReviewRow } from './parts'
import { consentRequired, type ReviewModel } from './review-model'

/**
 * The frozen, signable half of the review — what `useSwap` holds once /api/swap has answered (`pendingSwap`). B4 has none (display
 * only), so the sheet renders the quote half alone; B5 passes this and the calldata rows below appear, byte-for-byte what v1's
 * TransactionPreview shows. Same decoder (`decodeTransactionPreview`), same rules.
 */
export interface ReviewPending {
  calldata: string
  routerAddress: string
  source: string
  /** The signer's address — only used to label the decoded recipient. */
  userAddress: string
  routeViaFeeCollector: boolean
  /** [H-04] FeeCollector-enforced minimum output, raw. Only meaningful when routeViaFeeCollector. */
  minimumOutput?: bigint
  /** For the enforced-minimum line: decimals of the buy token. */
  decimalsOut: number
}

export interface ReviewConfirm {
  /** v1's `executeSwap(…, { unpricedAck: true })` — true only after the consent box was ticked. */
  unpricedAck: boolean
}

function formatDeadline(timestamp: number): string {
  const diff = timestamp - Math.floor(Date.now() / 1000)
  if (diff <= 0) return 'Expired'
  if (diff < 60) return `${diff}s remaining`
  if (diff < 3600) return `${Math.floor(diff / 60)}m remaining`
  return `${Math.floor(diff / 3600)}h remaining`
}

/**
 * [ADR-025] Round 7 frames 26 / m03 — "Review Transaction" as a full-bleed sheet (bottom sheet on a phone). Field set = v1's
 * TransactionPreview (source, send / receive, minimum output, recipient, route, deadline, validation, selector, raw calldata) plus
 * the owner's extras from the quote object (rate, route path, max slippage, platform fee, est. gas, price-tier line). The unpriced
 * consent (#608) sits inline and GATES Confirm; a server 409 (`ackRequired`) brings it back unticked. Confirm is the screen's one
 * solid cream CTA and a stub here — B5 wires it to the signing path.
 */
export function ReviewSheet({
  model,
  pending,
  ackRequired = false,
  onConfirm,
  onCancel,
}: {
  model: ReviewModel
  pending?: ReviewPending
  /** /api/swap answered 409 `unpriced_ack_required` (useSwap.unpricedAckRequired / the split hook's). */
  ackRequired?: boolean
  onConfirm: (c: ReviewConfirm) => void
  onCancel: () => void
}) {
  const needsConsent = consentRequired(model, ackRequired)
  const [ack, setAck] = useState(false)
  // A 409 is a fresh question: any earlier tick is void (derived during render, React's documented pattern for resetting state on a prop change).
  const [prevAckRequired, setPrevAckRequired] = useState(ackRequired)
  if (ackRequired !== prevAckRequired) {
    setPrevAckRequired(ackRequired)
    if (ackRequired) setAck(false)
  }
  const [showRaw, setShowRaw] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const preview = useMemo(() => (pending ? decodeTransactionPreview(pending.calldata, pending.routerAddress, pending.source) : null), [pending])
  const decodeFailed = preview?.functionName === 'unknown'
  const recipient = useMemo(() => {
    if (!pending || !preview) return null
    if (!preview.recipient) return { text: 'msg.sender', badge: 'implicit' as const }
    const lower = preview.recipient.toLowerCase()
    const badge = lower === pending.userAddress.toLowerCase() ? ('match' as const) : lower === FEE_COLLECTOR_ADDRESS.toLowerCase() ? ('feecollector' as const) : ('other' as const)
    return { text: shortAddress(preview.recipient), badge }
  }, [pending, preview])
  const enforcedMinOut =
    pending && pending.routeViaFeeCollector && pending.minimumOutput != null && pending.minimumOutput > 0n ? `${fmtToken(pending.minimumOutput, pending.decimalsOut)} ${model.symbolOut}` : null

  const confirmDisabled = needsConsent && !ack

  return (
    <Sheet name="review" size="md" title="Review Transaction" subtitle="Verify the details before signing" onClose={onCancel} initialFocusRef={cancelRef}>
      {decodeFailed && <p className="mt-4 border-l-2 border-v2-amber pl-3 text-[13px] text-v2-amber">Could not decode transaction details. Verify in your wallet before signing.</p>}

      <div className="mt-4">
        <ReviewRow label="Source" testId="review-source">
          <span className="font-sans text-[15px] font-semibold text-v2-text">{preview ? preview.sourceDex : model.sourceLabel}</span>
          {preview && preview.functionName !== 'unknown' && <span className="ml-2 text-[12px] text-v2-muted">{preview.functionName}()</span>}
          {model.intent && <span className="ml-2 align-middle"><Mark tone="cream">Gasless</Mark></span>}
        </ReviewRow>
        {model.intent && (
          <ReviewRow label="Gas fee" testId="review-cow-gas">
            $0.00 <span className="text-[12px] text-v2-muted">(paid by solver)</span>
          </ReviewRow>
        )}
      </div>

      <div className="mt-2 ts-v2-rule-t pt-2" data-testid="review-amounts">
        <ReviewRow label="Send" testId="review-send">
          {model.send} {model.symbolIn}
        </ReviewRow>
        <div aria-hidden="true" className="py-0.5 text-center text-v2-muted">
          ↓
        </div>
        <ReviewRow label="Receive (est.)" testId="review-receive">
          {model.receive} {model.symbolOut}
        </ReviewRow>
        <div className="mt-1 ts-v2-rule-t pt-1">
          <ReviewRow
            label={
              <span className="inline-flex flex-wrap items-center gap-x-2">
                Minimum output
                {enforcedMinOut && <Mark>Enforced on-chain</Mark>}
              </span>
            }
            testId="review-min"
          >
            {enforcedMinOut ?? `${model.minOutput} ${model.symbolOut}`}
          </ReviewRow>
        </div>
      </div>

      <div className="mt-2 ts-v2-rule-t pt-2">
        <ReviewRow label="Rate" testId="review-rate">
          {model.rate}
        </ReviewRow>
        <ReviewRow label="Route" testId="review-route" wrap>
          <span className="break-words">{model.route}</span>
          {pending?.routeViaFeeCollector && <span className="block text-v2-cream">Via TeraSwap FeeCollector (0.1% fee)</span>}
        </ReviewRow>
        <ReviewRow label="Max slippage" testId="review-slippage">
          {model.slippage}
        </ReviewRow>
        <ReviewRow label="Est. gas" tone={model.gasFree ? 'green' : undefined} testId="review-gas" wrap>
          {model.gas}
        </ReviewRow>
        <ReviewRow label={model.feeLabel} tone={model.feeValue ? undefined : 'green'} testId="review-fee" wrap>
          {model.feeValue ?? 'Free'}
        </ReviewRow>
      </div>

      {preview && recipient && (
        <div className="mt-2 ts-v2-rule-t pt-2" data-testid="review-decoded">
          <ReviewRow label="Recipient" testId="review-recipient" wrap>
            {recipient.text}{' '}
            {recipient.badge === 'match' && <Mark>Your wallet</Mark>}
            {recipient.badge === 'implicit' && <Mark tone="cream">Implicit</Mark>}
            {recipient.badge === 'feecollector' && <Mark tone="cream">FeeCollector</Mark>}
            {recipient.badge === 'other' && <Mark tone="amber">Unknown</Mark>}
          </ReviewRow>
          {preview.deadline != null && preview.deadline > 0 && <ReviewRow label="Deadline">{formatDeadline(preview.deadline)}</ReviewRow>}
          <ReviewRow label="Validation" tone={preview.validated ? 'green' : 'amber'} testId="review-validation" wrap>
            {preview.validated ? (
              <>
                <span aria-hidden="true">✓</span> Validated selector
              </>
            ) : (
              <>
                <span aria-hidden="true">⚠</span> {preview.validationReason ?? 'Unvalidated'}
              </>
            )}
          </ReviewRow>
          <ReviewRow label="Selector" testId="review-selector">
            {preview.selector}
          </ReviewRow>
          <div className="mt-1 ts-v2-rule-t">
            <button
              type="button"
              aria-expanded={showRaw}
              onClick={() => setShowRaw(!showRaw)}
              className="flex min-h-[44px] w-full items-center justify-between text-[13px] text-v2-muted hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-teal"
            >
              <span>Raw calldata ({Math.floor(pending!.calldata.length / 2)} bytes)</span>
              <span aria-hidden="true">{showRaw ? '▲' : '▼'}</span>
            </button>
            {showRaw && <div className="mb-2 max-h-24 overflow-auto break-all font-v2-mono text-[10px] leading-relaxed text-v2-muted">{pending!.calldata}</div>}
          </div>
        </div>
      )}

      {/* The tier line: single-source → v1's amber notice; unpriced → the consent block below instead of the one-line notice. */}
      {model.tier?.tier === 'single-source' && (
        <div className="mt-3">
          <TierNotice tier={model.tier} />
        </div>
      )}
      {needsConsent && <ConsentBlock values={model.consent} checked={ack} onChange={setAck} />}

      <div className="mt-6 flex flex-col gap-1">
        <Button variant="primary" className="w-full" disabled={confirmDisabled} onClick={() => onConfirm({ unpricedAck: needsConsent && ack })} data-b5-stub="" data-testid="review-confirm">
          Confirm &amp; Sign
        </Button>
        <Button ref={cancelRef} variant="text" className="w-full" onClick={onCancel} data-testid="review-cancel">
          Cancel
        </Button>
      </div>
    </Sheet>
  )
}
