'use client'

import { useMemo, useRef, useState } from 'react'
import { decodeTransactionPreview } from '@/lib/calldata-decoder'
import { FEE_COLLECTOR_ADDRESS } from '@/lib/constants'
import { fmtToken } from '@/lib/format'
import type { Token } from '@/lib/tokens'
import type { PlannedLeg } from '@/hooks/useSplitSwap'
import { Button } from '../primitives'
import { Sheet } from './Sheet'
import { ConsentBlock, Mark, ReviewRow, truncAddr } from './parts'
import type { ConsentValues } from './review-model'
import type { ReviewConfirm } from './ReviewSheet'

function fmtAmount(raw: string | bigint | undefined, token: Token | null): string {
  if (raw == null || !token) return '—'
  try {
    return `${fmtToken(typeof raw === 'bigint' ? raw : BigInt(raw), token.decimals)} ${token.symbol}`
  } catch {
    return '—'
  }
}

function Leg({ leg, index, tokenIn, tokenOut, userAddress }: { leg: PlannedLeg; index: number; tokenIn: Token | null; tokenOut: Token | null; userAddress: string }) {
  const preview = useMemo(() => (leg.routerCalldata ? decodeTransactionPreview(leg.routerCalldata, leg.routerAddress, leg.source) : null), [leg.routerCalldata, leg.routerAddress, leg.source])
  const skipped = leg.status === 'skipped'
  const recipient = preview?.recipient ?? null
  const badge: 'match' | 'implicit' | 'feecollector' | 'other' = !recipient
    ? 'implicit'
    : recipient.toLowerCase() === userAddress.toLowerCase()
      ? 'match'
      : recipient.toLowerCase() === FEE_COLLECTOR_ADDRESS.toLowerCase()
        ? 'feecollector'
        : 'other'

  return (
    <section data-testid={`split-leg-${index}`} aria-label={`Leg ${index + 1}`} className={`ts-v2-rule-t pt-3 ${skipped ? 'opacity-60' : ''}`}>
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-v2-mono text-[12px] font-semibold uppercase tracking-[1.5px] text-v2-cream">
          Leg {index + 1}: {preview?.sourceDex ?? leg.source}
          <span className="ml-2 normal-case tracking-normal text-v2-muted">{preview && preview.functionName !== 'unknown' ? `${preview.functionName}()` : ''}</span>
        </h3>
        <span className="font-v2-mono text-[12px] text-v2-muted">{leg.percent}%</span>
      </div>

      {skipped ? (
        <p className="mt-2 border-l-2 border-v2-amber pl-3 text-[13px] text-v2-amber">
          ⚠ Skipped — will NOT be signed. {leg.error ?? 'Failed pre-flight checks.'}
        </p>
      ) : (
        <div className="mt-1 pb-3">
          <ReviewRow label="Send">{fmtAmount(leg.legAmount, tokenIn)}</ReviewRow>
          <ReviewRow label="Receive (est.)">{fmtAmount(leg.expectedOut, tokenOut)}</ReviewRow>
          {leg.routeViaFeeCollector && leg.legMinOutput > 0n && (
            <ReviewRow
              label={
                <span className="inline-flex flex-wrap items-center gap-x-2">
                  Minimum output <Mark>Enforced on-chain</Mark>
                </span>
              }
            >
              {fmtAmount(leg.legMinOutput, tokenOut)}
            </ReviewRow>
          )}
          <ReviewRow label="Router">{truncAddr(leg.routerAddress)}</ReviewRow>
          <ReviewRow label="Recipient">
            {recipient ? truncAddr(recipient) : 'msg.sender'}{' '}
            {badge === 'match' && <Mark>Your wallet</Mark>}
            {badge === 'implicit' && <Mark tone="cream">Implicit</Mark>}
            {badge === 'feecollector' && <Mark tone="cream">FeeCollector</Mark>}
            {badge === 'other' && <Mark tone="amber">Unknown</Mark>}
          </ReviewRow>
          <ReviewRow label="Validation" tone={preview?.validated ? 'green' : 'amber'}>
            {preview?.validated ? (
              <>
                <span aria-hidden="true">✓</span> Validated selector <span className="text-v2-muted">{preview.selector}</span>
              </>
            ) : (
              <>
                <span aria-hidden="true">⚠</span> {preview?.validationReason ?? 'Unvalidated'}
              </>
            )}
          </ReviewRow>
          {leg.simulated === false && (
            <p className="mt-1 text-[12px] text-v2-amber">
              ⚠ Simulation unavailable — protected only by the on-chain minimum output.
            </p>
          )}
          {leg.routeViaFeeCollector && <p className="mt-1 text-[12px] text-v2-cream">Via TeraSwap FeeCollector (0.1% fee)</p>}
        </div>
      )}
    </section>
  )
}

/**
 * [ADR-025] Round 7 frame 27 (left) — "Review Split Swap". The per-leg trust surface of v1's SplitReviewModal (same decoder, same
 * fields, same wording): nothing is signed until the user confirms this plan. `consent` (the unpriced informed consent, #608 / the split
 * hook's 409) gates Confirm exactly as it does on the single review. Confirm is a stub here — B5 wires `confirmSplitPlan`.
 */
export function SplitReviewSheet({
  plannedLegs,
  tokenIn,
  tokenOut,
  userAddress,
  consent,
  onConfirm,
  onCancel,
}: {
  plannedLegs: PlannedLeg[]
  tokenIn: Token | null
  tokenOut: Token | null
  userAddress: string
  /** Present when the unpriced consent applies (tier `unpriced`, or the server's 409): shown inline and gates Confirm. */
  consent?: ConsentValues | null
  onConfirm: (c: ReviewConfirm) => void
  onCancel: () => void
}) {
  const [ack, setAck] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const signable = plannedLegs.filter((p) => p.status === 'reviewed').length
  const n = plannedLegs.length

  return (
    <Sheet
      name="split-review"
      size="lg"
      title="Review Split Swap"
      subtitle={`This routes across ${n} ${n === 1 ? 'leg' : 'legs'}. Verify each before signing — you'll approve ${signable} wallet ${signable === 1 ? 'prompt' : 'prompts'}, one per leg.`}
      onClose={onCancel}
      initialFocusRef={cancelRef}
    >
      <div className="mt-4 space-y-1">
        {plannedLegs.map((leg, i) => (
          <Leg key={i} leg={leg} index={i} tokenIn={tokenIn} tokenOut={tokenOut} userAddress={userAddress} />
        ))}
      </div>
      {consent && <ConsentBlock values={consent} checked={ack} onChange={setAck} />}
      <div className="mt-6 flex flex-col gap-1">
        <Button variant="primary" className="w-full" disabled={signable === 0 || (!!consent && !ack)} onClick={() => onConfirm({ unpricedAck: !!consent && ack })} data-b5-stub="" data-testid="split-confirm">
          Confirm &amp; Sign {signable} {signable === 1 ? 'leg' : 'legs'}
        </Button>
        <Button ref={cancelRef} variant="text" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Sheet>
  )
}
