'use client'

import { useEffect, useRef, useState, type Ref } from 'react'
import { FLOOR_CONSENT_CHECKBOX, FLOOR_CONSENT_HEADING } from '@/components/dca/DcaFloorConsentDialog'
import { affectedSymbols } from '@/components/dca/pair-floor-info'
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
export function DcaConsentBlock({ tier, body, checked, onChange, checkboxRef }: { tier: WeakerTier; body: string; checked: boolean; onChange: (v: boolean) => void; checkboxRef?: Ref<HTMLInputElement> }) {
  return (
    <section data-testid="dca-consent" data-tier={tier} aria-labelledby="v2-dca-consent-h" className="mt-4 border-l-2 border-v2-amber py-1 pl-4">
      <h3 id="v2-dca-consent-h" data-testid="dca-consent-heading" className="text-[14px] font-semibold text-v2-text">
        {FLOOR_CONSENT_HEADING}
      </h3>
      <p data-testid="dca-consent-body" className="mt-1 text-[13px] leading-relaxed text-v2-text/90">
        {body}
      </p>
      <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-3 text-[14px] text-v2-text">
        <input ref={checkboxRef} type="checkbox" data-testid="dca-consent-checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#EADFB6]" />
        {FLOOR_CONSENT_CHECKBOX}
      </label>
    </section>
  )
}

/**
 * [ADR-025] The DCA review (B6a): the schedule, the Protection line and cap, the server's tier line and — below `onchain-feed` — the
 * consent block that gates the CTA. Create DCA (B6b) hands the TIER whose box is ticked (or undefined on the on-chain tier) to `onCreate`,
 * which re-runs v1's whole create step and calls `createOrder` with the draft THAT builds (A70 M-1: the sheet holds no draft to send, and
 * no acknowledgement outlives its press — the engine FREEZES the order for the EIP-712 review; nothing is signed or sent from here).
 * `busy` holds the sheet while that runs.
 *
 * `conflictTier` is the `requiredTier` of a 409 from api/orders (the server re-classified and wants a stronger acknowledgement than the
 * one given): the consent REOPENS for that tier — the box is unticked and takes focus, the CTA disabled again — and never for a weaker one.
 * `switchNetwork` is the form's wrong-network CTA (v1's switch action): while the wallet sits on another chain it replaces Create.
 */
export function DcaReviewSheet({
  review, view, conflictTier, busy = false, switchNetwork, onCreate, onClose,
}: {
  review: PreparedReview
  view: DcaReviewView
  conflictTier?: string
  busy?: boolean
  switchNetwork?: { label: string; onSwitch: () => void }
  onCreate: (ack: WeakerTier | undefined) => void
  onClose: () => void
}) {
  const baseTier = consentTier(review.info)
  const reopened = reopenTier(baseTier, conflictTier)
  const tier = reopened ?? baseTier
  // The tier whose box is ticked. Keyed by tier, so a stronger tier from the server reads as unticked with no reset.
  const [ackedTier, setAckedTier] = useState<WeakerTier | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const checkboxRef = useRef<HTMLInputElement>(null)
  const info = tier && tier !== review.info.tier ? { ...review.info, tier } : review.info
  const symbols = tier && tier !== review.info.tier ? affectedSymbols(info, view.symbolIn, view.symbolOut) : review.symbols
  const consented = tier === null || ackedTier === tier
  const protection = protectionLabel(info)
  const hint = protectionHint(info)

  // A 409 brought the consent back: it takes focus (the pressed Create is gone — focus would otherwise fall to the page behind).
  useEffect(() => {
    if (reopened) checkboxRef.current?.focus({ preventScroll: true })
  }, [reopened])

  function create() {
    if (busy) return
    onCreate(tier ?? undefined)
  }

  return (
    <Sheet name="dca-review" size="md" title="Review DCA" subtitle={view.chainName} onClose={() => !busy && onClose()} initialFocusRef={cancelRef} dismissOnBackdrop={false} dismissOnEscape={!busy}>
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

      {tier && <DcaConsentBlock tier={tier} body={consentBody(info, symbols)} checked={ackedTier === tier} onChange={(v) => setAckedTier(v ? tier : null)} checkboxRef={checkboxRef} />}

      <div className="mt-6 flex flex-col gap-1">
        {switchNetwork ? (
          <Button variant="primary" className="w-full" onClick={switchNetwork.onSwitch} data-testid="dca-review-switch">
            {switchNetwork.label}
          </Button>
        ) : (
          <Button
            variant="primary"
            className="w-full aria-disabled:cursor-wait aria-disabled:bg-v2-surface2 aria-disabled:text-v2-dim"
            disabled={!consented}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            onClick={create}
            data-testid="dca-review-create"
          >
            Create DCA
          </Button>
        )}
        <Button ref={cancelRef} variant="text" className="w-full" aria-disabled={busy || undefined} onClick={() => !busy && onClose()} data-testid="dca-review-cancel">
          Cancel
        </Button>
      </div>
    </Sheet>
  )
}
