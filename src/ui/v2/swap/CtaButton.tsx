'use client'

import type { CtaState } from './cta'
import { Button } from '../primitives'

/**
 * [ADR-025] The ONE CTA. Round 7 keeps a single filled shape per screen, so only the states that ask the visitor to act on the swap
 * (connect, review, split Swap, and the disabled form states) wear the cream fill; every state that reports on the swap is the same
 * text button in the status colour — frames 28a (in flight, muted), 28b (complete, green), 28c (retry, red), 29 (wrong network /
 * a price-gate block: amber when a checkbox clears it, red when nothing can).
 */
const TEXT_TONE: Partial<Record<CtaState['kind'], string>> = {
  'wrong-network': '!text-v2-amber',
  'in-flight': '!text-v2-muted',
  complete: '!text-v2-green',
  retry: '!text-v2-red',
}

export function CtaButton({ cta, onClick }: { cta: CtaState; onClick?: () => void }) {
  const tone = cta.kind === 'blocked' ? (cta.recoverable ? '!text-v2-amber' : '!text-v2-red') : TEXT_TONE[cta.kind]
  if (tone) {
    return (
      <Button variant="text" className={`w-full ${tone}`} disabled={cta.disabled} data-cta={cta.kind} data-recoverable={cta.recoverable === undefined ? undefined : String(cta.recoverable)} aria-busy={cta.kind === 'in-flight' || undefined} onClick={onClick}>
        {cta.label}
      </Button>
    )
  }
  return (
    <Button variant="primary" className="w-full" disabled={cta.disabled} data-cta={cta.kind} onClick={onClick}>
      {cta.label}
    </Button>
  )
}
