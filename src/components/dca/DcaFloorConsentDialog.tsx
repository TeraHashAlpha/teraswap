'use client'

import { useEffect, useRef, useState } from 'react'
import { DCA_NO_PRICE_FILL_CAP_MAX_USD, type DcaFloorTier } from '@/lib/order-engine'

/**
 * [FEAT-DCA-FLOOR-TIERS] Informed consent for a DCA whose minimum the contract cannot fully
 * enforce (owner decision 2026-10-11; replaces the 2026-09-09 hard block). Shown only for the two
 * weaker tiers. Confirm stays disabled until the checkbox is ticked; Cancel is the safe default focus.
 *
 * [fix/dca-consent-copy-and-tier-check] Owner-chosen copy, verbatim. {N} is the REAL number of tokens
 * on this chain whose feed the executor has registered (`registeredFeedCount` from
 * /api/dca-floor-cap); when that is unknown or 0 the sentence carries no number at all — never a
 * guess, never "0 tokens". The cap comes from DCA_NO_PRICE_FILL_CAP_MAX_USD, never a literal.
 */
export const FLOOR_CONSENT_HEADING = 'How DCA buys are protected'
export const FLOOR_CONSENT_CHECKBOX = 'Got it — continue'

function registeredLead(count: number | null | undefined): string {
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return 'A small set of tokens on this network have'
  return count === 1 ? '1 token on this network has' : `${count} tokens on this network have`
}

export function floorConsentCopy({
  tier,
  symbols,
  effectiveCapUsd,
  registeredFeedCount,
}: {
  tier: Exclude<DcaFloorTier, 'onchain-feed'>
  /** The legs without an on-chain feed, as the user picked them. Both → "A and B". */
  symbols: readonly string[]
  effectiveCapUsd?: number | null
  registeredFeedCount?: number | null
}): string {
  const lead = registeredLead(registeredFeedCount)
  const symbol = symbols.join(' and ')
  const doesnt = symbols.length > 1 ? "don't" : "doesn't"
  if (tier === 'offchain-price') {
    return `${lead} a Chainlink price feed registered in our contract, which lets the contract reject a bad fill on its own. ${symbol} ${doesnt} have one yet, so protection comes from our executor instead — it checks each buy against live market prices and holds the buy if they disagree. This is how most tokens work today.`
  }
  // Never render a number above the ceiling, whatever the API returned.
  const cap = typeof effectiveCapUsd === 'number' && Number.isFinite(effectiveCapUsd) && effectiveCapUsd > 0
    ? Math.min(effectiveCapUsd, DCA_NO_PRICE_FILL_CAP_MAX_USD) : DCA_NO_PRICE_FILL_CAP_MAX_USD
  return `${lead} a Chainlink price feed registered in our contract. ${symbol} ${doesnt}, and at the moment no market price source is answering for it, so the executor can't check the fill. To limit risk, each buy is capped at $${cap} and flagged. Buys resume normal protection when a price source comes back.`
}

export default function DcaFloorConsentDialog({
  tier,
  symbols,
  chainId,
  registeredFeedCount,
  effectiveCapUsd,
  onConfirm,
  onCancel,
}: {
  tier: Exclude<DcaFloorTier, 'onchain-feed'>
  symbols: readonly string[]
  /** Legacy: when given (and the numbers below are not), the dialog reads them from /api/dca-floor-cap. */
  chainId?: number
  /** From the pair response the parent already holds; when provided the dialog fetches nothing. */
  registeredFeedCount?: number | null
  effectiveCapUsd?: number | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const [checked, setChecked] = useState(false)
  const [cap, setCap] = useState<{ effectiveUsd: number | null; registeredFeedCount: number | null }>({ effectiveUsd: null, registeredFeedCount: null })
  useEffect(() => {
    if (chainId === undefined || registeredFeedCount !== undefined || effectiveCapUsd !== undefined) return
    let cancelled = false
    fetch(`/api/dca-floor-cap?chainId=${chainId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (cancelled || !j) return
        const num = (v: unknown) => (typeof v === 'number' ? v : null)
        setCap({ effectiveUsd: num(j.effectiveUsd), registeredFeedCount: num(j.registeredFeedCount) })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [chainId, registeredFeedCount, effectiveCapUsd])
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/80 p-4 pt-[10vh]" onClick={onCancel} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="floor-consent-heading"
        aria-describedby="floor-consent-body"
        data-testid="floor-consent-dialog"
        data-tier={tier}
        className="w-full max-w-md rounded-2xl border border-cream-08 bg-[#0F1318] p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 id="floor-consent-heading" data-testid="floor-consent-heading" className="mb-2 text-sm font-semibold text-cream">
          {FLOOR_CONSENT_HEADING}
        </h2>
        <p id="floor-consent-body" data-testid="floor-consent-body" className="mb-4 text-[13px] leading-relaxed text-cream-70">
          {floorConsentCopy({ tier, symbols, effectiveCapUsd: effectiveCapUsd ?? cap.effectiveUsd, registeredFeedCount: registeredFeedCount ?? cap.registeredFeedCount })}
        </p>
        <label className="mb-5 flex cursor-pointer items-center gap-2 text-[13px] text-cream">
          <input
            type="checkbox"
            data-testid="floor-consent-checkbox"
            checked={checked}
            onChange={e => setChecked(e.target.checked)}
          />
          {FLOOR_CONSENT_CHECKBOX}
        </label>
        <div className="flex gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            data-testid="floor-consent-cancel"
            className="flex-1 rounded-xl border border-cream-08 py-2.5 text-xs font-semibold text-cream-50 transition hover:bg-cream-08 hover:text-cream"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!checked}
            data-testid="floor-consent-confirm"
            className="flex-1 rounded-xl bg-cream-gold py-2.5 text-xs font-bold text-[#080B10] transition hover:bg-gold-light disabled:cursor-not-allowed disabled:opacity-40"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
