'use client'

import { useEffect, useRef, useState } from 'react'
import { fmtPct } from '@/lib/format'

/**
 * [feat/swap-price-tiers D3] Informed consent for a swap whose pair has NO reference price on either leg
 * (the server's `unpriced` tier, or /api/swap's 409 `unpriced_ack_required`). Owner decision 2026-10-26:
 * allowed after consent, no USD caps; what still protects the user is stated with REAL values — the number
 * of aggregator quotes and their spread, and the on-chain minimum output. Same structure as
 * dca/DcaFloorConsentDialog: Confirm stays disabled until the checkbox is ticked; Cancel is the safe default
 * focus; Escape cancels. Owner copy, verbatim.
 */
export const UNPRICED_CONSENT_HEADING = 'No reference price for this pair'
export const UNPRICED_CONSENT_CHECKBOX = 'I understand — continue'

/** "{d}%" — the house percent formatter: at most 2 decimals, trailing zeros trimmed ("1.5%", "0.12%", "2%"). */
function fmtSpread(pct: number): string {
  return fmtPct(Number.isFinite(pct) && pct >= 0 ? pct : 0, 2)
}

export function unpricedConsentCopy({
  symbolIn,
  symbolOut,
  quoteSourceCount,
  quoteSpreadPct,
  minOut,
}: {
  symbolIn: string
  symbolOut: string
  /** Aggregator quotes that answered for this trade (meta.all). */
  quoteSourceCount: number
  /** (max − min) / min of those quotes, in percent. */
  quoteSpreadPct: number
  /** The on-chain minimum output, already formatted in {symbolOut} units. */
  minOut: string
}): string {
  // With a single quote "1 sources quoted within 0% of each other" would be false; say what is true.
  const protection = quoteSourceCount >= 2
    ? `${quoteSourceCount} sources quoted within ${fmtSpread(quoteSpreadPct)} of each other`
    : '1 source quoted (no second quote to compare against)'
  return `We couldn't find a Chainlink, DefiLlama or CoinGecko price for ${symbolIn} or ${symbolOut}, so we can't estimate this trade's USD value or apply value-based limits. What still protects you: ${protection}, and the on-chain minimum output of ${minOut} ${symbolOut} — if a fill would return less, the transaction reverts.`
}

export default function SwapUnpricedConsentDialog({
  symbolIn,
  symbolOut,
  quoteSourceCount,
  quoteSpreadPct,
  minOut,
  onConfirm,
  onCancel,
}: {
  symbolIn: string
  symbolOut: string
  quoteSourceCount: number
  quoteSpreadPct: number
  minOut: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const [checked, setChecked] = useState(false)
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
        aria-labelledby="unpriced-consent-heading"
        aria-describedby="unpriced-consent-body"
        data-testid="unpriced-consent-dialog"
        className="w-full max-w-md rounded-2xl border border-cream-08 bg-[#0F1318] p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 id="unpriced-consent-heading" data-testid="unpriced-consent-heading" className="mb-2 text-sm font-semibold text-cream">
          {UNPRICED_CONSENT_HEADING}
        </h2>
        <p id="unpriced-consent-body" data-testid="unpriced-consent-body" className="mb-4 text-[13px] leading-relaxed text-cream-70">
          {unpricedConsentCopy({ symbolIn, symbolOut, quoteSourceCount, quoteSpreadPct, minOut })}
        </p>
        <label className="mb-5 flex cursor-pointer items-center gap-2 text-[13px] text-cream">
          <input
            type="checkbox"
            data-testid="unpriced-consent-checkbox"
            checked={checked}
            onChange={e => setChecked(e.target.checked)}
          />
          {UNPRICED_CONSENT_CHECKBOX}
        </label>
        <div className="flex gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            data-testid="unpriced-consent-cancel"
            className="flex-1 rounded-xl border border-cream-08 py-2.5 text-xs font-semibold text-cream-50 transition hover:bg-cream-08 hover:text-cream"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!checked}
            data-testid="unpriced-consent-confirm"
            className="flex-1 rounded-xl bg-cream-gold py-2.5 text-xs font-bold text-[#080B10] transition hover:bg-gold-light disabled:cursor-not-allowed disabled:opacity-40"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
