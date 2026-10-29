'use client'

import { useRef, useState } from 'react'
import { UNPRICED_CONSENT_CHECKBOX, UNPRICED_CONSENT_HEADING, unpricedConsentCopy } from '@/components/SwapUnpricedConsentDialog'
import { Button } from '../primitives'
import { Sheet } from './Sheet'
import type { ConsentValues } from './review-model'

/**
 * [B5] The unpriced informed consent as a sheet of its own — for the SPLIT path, which (as in v1) goes from the Swap click straight
 * to the plan with no single-route review to carry the checkbox. It is v1's SwapUnpricedConsentDialog in a v2 sheet: heading, body and
 * checkbox label are v1's own exports, Continue stays disabled until the box is ticked, Cancel is the safe default focus, and a click
 * on the dimmed page does not count as consent (nor as a cancel the user did not mean).
 */
export function ConsentSheet({ values, onContinue, onCancel }: { values: ConsentValues; onContinue: () => void; onCancel: () => void }) {
  const [ack, setAck] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Sheet name="consent" size="md" title={UNPRICED_CONSENT_HEADING} onClose={onCancel} initialFocusRef={cancelRef} dismissOnBackdrop={false}>
      <p data-testid="unpriced-consent-body" className="mt-3 text-[13px] leading-relaxed text-v2-text/90">
        {unpricedConsentCopy(values)}
      </p>
      <label className="mt-4 flex min-h-[44px] cursor-pointer items-center gap-3 text-[14px] text-v2-text">
        <input type="checkbox" data-testid="unpriced-consent-checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="h-4 w-4 accent-[#EADFB6]" />
        {UNPRICED_CONSENT_CHECKBOX}
      </label>
      <div className="mt-6 flex flex-col gap-1">
        <Button variant="primary" className="w-full" disabled={!ack} onClick={onContinue} data-testid="consent-continue">
          Continue
        </Button>
        <Button ref={cancelRef} variant="text" className="w-full" onClick={onCancel} data-testid="consent-cancel">
          Cancel
        </Button>
      </div>
    </Sheet>
  )
}
