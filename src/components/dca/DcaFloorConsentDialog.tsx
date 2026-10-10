'use client'

import { useEffect, useRef, useState } from 'react'
import { DCA_NO_PRICE_FILL_CAP_USD, type DcaFloorTier } from '@/lib/order-engine'

/**
 * [FEAT-DCA-FLOOR-TIERS] Informed consent for a DCA whose minimum the contract cannot fully
 * enforce (owner decision 2026-10-11; replaces the 2026-09-09 hard block). Shown only for the two
 * weaker tiers. Copy is plain and exact; the cap comes from DCA_NO_PRICE_FILL_CAP_USD, never a
 * literal. Confirm stays disabled until the checkbox is ticked; Cancel is the safe default focus.
 */
export function floorConsentCopy(tier: Exclude<DcaFloorTier, 'onchain-feed'>, symbol: string): string {
  return tier === 'offchain-price'
    ? `No on-chain price feed for ${symbol}. The contract cannot enforce a minimum; each buy is protected only by our off-chain price check.`
    : `No price source for ${symbol}. Buys may execute at ANY price; each buy is capped at $${DCA_NO_PRICE_FILL_CAP_USD} and flagged.`
}

export const FLOOR_CONSENT_CHECKBOX = 'I understand and want to proceed'

export default function DcaFloorConsentDialog({
  tier,
  symbol,
  onConfirm,
  onCancel,
}: {
  tier: Exclude<DcaFloorTier, 'onchain-feed'>
  symbol: string
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
        aria-labelledby="floor-consent-body"
        data-testid="floor-consent-dialog"
        data-tier={tier}
        className="w-full max-w-md rounded-2xl border border-cream-08 bg-[#0F1318] p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <p id="floor-consent-body" data-testid="floor-consent-body" className="mb-4 text-[13px] leading-relaxed text-cream-70">
          {floorConsentCopy(tier, symbol)}
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
