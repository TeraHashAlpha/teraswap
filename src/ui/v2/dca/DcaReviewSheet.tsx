'use client'

import { useRef, useState } from 'react'
import { FLOOR_CONSENT_CHECKBOX, FLOOR_CONSENT_HEADING } from '@/components/dca/DcaFloorConsentDialog'
import { affectedSymbols } from '@/components/dca/pair-floor-info'
import type { CreateOrderConfig } from '@/lib/order-engine'
import { Button } from '../primitives'
import { Sheet } from '../modals/Sheet'
import { Mark, ReviewRow } from '../modals/parts'
import { consentBody, consentTier, protectionHint, protectionLabel, reopenTier, type WeakerTier } from './dca-model'
import type { PreparedReview } from './use-dca-form'

/** What the sheet prints, built by the card from the form (display strings) — the draft itself is the hook's, untouched. */
export interface DcaReviewView {
  symbolIn: string
  symbolOut: string
  chainName: string
  total: string
  perBuy: string
  buys: number
  every: string
  duration: string
  expires: string
  /** The signed minimum output (total basis) and what is enforced per buy, in `symbolOut`; null while the oracle gate blocks a floor. */
  floorTotal: string | null
  floorPerBuy: string | null
}

/**
 * v1's DcaFloorConsentDialog, inline in the review (the owner's placement, as on the Swap review): heading, body and checkbox label are
 * v1's own exports/derivation (`FLOOR_CONSENT_HEADING`, `floorConsentCopy` via `consentBody`, `FLOOR_CONSENT_CHECKBOX`), with the REAL {N}
 * (registeredFeedCount), symbols and cap from the server's answer. Shown for both weaker tiers, as v1 does.
 */
export function DcaConsentBlock({ tier, body, checked, onChange }: { tier: WeakerTier; body: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <section data-testid="dca-consent" data-tier={tier} aria-labelledby="v2-dca-consent-h" className="mt-4 border-l-2 border-v2-amber py-1 pl-4">
      <h3 id="v2-dca-consent-h" data-testid="dca-consent-heading" className="text-[14px] font-semibold text-v2-text">
        {FLOOR_CONSENT_HEADING}
      </h3>
      <p data-testid="dca-consent-body" className="mt-1 text-[13px] leading-relaxed text-v2-text/90">
        {body}
      </p>
      <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-3 text-[14px] text-v2-text">
        <input type="checkbox" data-testid="dca-consent-checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#EADFB6]" />
        {FLOOR_CONSENT_CHECKBOX}
      </label>
    </section>
  )
}

/**
 * [ADR-025] The DCA review (B6a): the schedule, the Protection line and cap, the server's tier line and — below `onchain-feed` — the
 * consent block that gates the CTA. The CTA is a STUB: it hands the acknowledged draft to `onCreate` (B6b signs); this block never
 * signs, approves or sends anything.
 *
 * `conflictTier` is the `requiredTier` of a 409 from api/orders (the server re-classified and wants a stronger acknowledgement than the
 * one given): the consent REOPENS for that tier — the box is unticked and the CTA disabled again — and never for a weaker one.
 */
export function DcaReviewSheet({
  review, view, conflictTier, onCreate, onClose,
}: {
  review: PreparedReview
  view: DcaReviewView
  conflictTier?: string
  onCreate?: (draft: CreateOrderConfig) => void
  onClose: () => void
}) {
  const baseTier = consentTier(review.info)
  const tier = reopenTier(baseTier, conflictTier) ?? baseTier
  // The tier whose box is ticked. Keyed by tier, so a stronger tier from the server reads as unticked with no reset.
  const [ackedTier, setAckedTier] = useState<WeakerTier | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const info = tier && tier !== review.info.tier ? { ...review.info, tier } : review.info
  const symbols = tier && tier !== review.info.tier ? affectedSymbols(info, view.symbolIn, view.symbolOut) : review.symbols
  const consented = tier === null || ackedTier === tier
  const protection = protectionLabel(info)
  const hint = protectionHint(info)

  function create() {
    onCreate?.({ ...review.draft, ...(tier ? { floorAck: { tier, acknowledgedAt: new Date().toISOString() } } : {}) })
  }

  return (
    <Sheet name="dca-review" size="md" title="Review DCA" subtitle={view.chainName} onClose={onClose} initialFocusRef={cancelRef} dismissOnBackdrop={false}>
      <div className="mt-4 flex flex-col" data-testid="dca-review-schedule">
        <ReviewRow label="Total to spend" testId="dca-review-total">{view.total} {view.symbolIn}</ReviewRow>
        <ReviewRow label="Buy" testId="dca-review-buy">{view.symbolOut}</ReviewRow>
        <ReviewRow label="Per buy" testId="dca-review-per-buy">{view.perBuy} {view.symbolIn}</ReviewRow>
        <ReviewRow label="Number of Buys" testId="dca-review-buys">{view.buys}</ReviewRow>
        <ReviewRow label="Execution" testId="dca-review-every">Every {view.every}</ReviewRow>
        <ReviewRow label="Total duration" testId="dca-review-duration">{view.duration}</ReviewRow>
        <ReviewRow label="Expires" testId="dca-review-expires">{view.expires}</ReviewRow>
        {view.floorTotal != null && (
          <ReviewRow label="Signed floor per order (total)" testId="dca-review-floor">≥ {view.floorTotal} {view.symbolOut}{view.floorPerBuy != null ? ` — ≥ ${view.floorPerBuy} ${view.symbolOut} enforced per buy` : ''}</ReviewRow>
        )}
        {protection && (
          <ReviewRow label="Protection" testId="dca-review-protection" tone="amber">
            {protection.text}
          </ReviewRow>
        )}
      </div>

      {hint && (
        <p data-testid="dca-review-tier" data-tier={hint.tier} className={`mt-3 text-[13px] leading-snug ${hint.tier === 'onchain-feed' ? 'text-v2-muted' : 'text-v2-amber'}`}>
          {tier ? <Mark tone="amber">{protection?.text}</Mark> : null} {hint.text}
        </p>
      )}

      {tier && <DcaConsentBlock tier={tier} body={consentBody(info, symbols)} checked={ackedTier === tier} onChange={(v) => setAckedTier(v ? tier : null)} />}

      <div className="mt-6 flex flex-col gap-1">
        <Button variant="primary" className="w-full" disabled={!consented} onClick={create} data-testid="dca-review-create" data-stub="">
          Create DCA
        </Button>
        <Button ref={cancelRef} variant="text" className="w-full" onClick={onClose} data-testid="dca-review-cancel">
          Cancel
        </Button>
      </div>
    </Sheet>
  )
}
