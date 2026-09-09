'use client'

import { useEffect, useRef } from 'react'

/**
 * [FIX-DCA-NOFEED-CONSENT — SUPERSEDED by FIX-DCA-NOFEED-FAIL-CLOSED, 2026-09-09]
 *
 * DEPRECATED: nothing routes to this modal. It was shown before signing whenever a DCA's output
 * token had no price feed, on the owner's 2026-07-23 decision to ALLOW that case under explicit
 * consent. That decision was reversed on 2026-09-09 once the on-chain consequence was measured:
 * with no feed registered in the executor, `_fairValueOut` returns hasFeed=false and the entire
 * on-chain floor collapses to the ADR-013 dust fallback (TeraSwapOrderExecutorV3.sol:540-554,
 * v3-min-derivation.ts:247-249). Consent is not the right instrument for a risk the copy below
 * originally described as bounded ("so you're not unprotected") when it was not. DCAPanel now
 * refuses such an order outright, naming the leg.
 *
 * Retained per rule #4 (nothing is deleted) and because its focus-trap/consent structure is the
 * reference for the next modal of this shape. Its copy has been corrected so that a future
 * re-wiring cannot resurrect the false claim along with the component.
 *
 * Zero jargon by design: no "oracle", "feed", "slippage", "minAmountOut" anywhere in the copy —
 * see dca-cost-preview.ts's sibling instinct (name things plainly) and NoFeedConsentModal.test.tsx's
 * denylist assertion, which is the actual enforcement mechanism for this invariant.
 *
 * Structure (focus trap, Esc-to-reject, safe-default focus) mirrors Permit2EducationModal.tsx —
 * the existing "explain before an irreversible signature" pattern in this app — minus its
 * "don't show again" checkbox: this modal is deliberately shown on EVERY no-feed DCA creation
 * (informed consent per order, no persistence).
 */
export default function NoFeedConsentModal({
  open,
  tokenSymbol,
  onAccept,
  onReject,
}: {
  open: boolean
  tokenSymbol: string
  onAccept: () => void
  onReject: () => void
}) {
  const modalRef = useRef<HTMLDivElement>(null)
  // Reject is the safe default focus target (spec requirement).
  const rejectRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement
    rejectRef.current?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { onReject(); return }
      if (e.key !== 'Tab' || !modalRef.current) return
      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, [tabindex]:not([tabindex="-1"])'
      )
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      prev?.focus()
    }
  }, [open, onReject])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/80 p-4 pt-[10vh]"
      onClick={onReject}
      role="presentation"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nofeed-consent-title"
        data-testid="nofeed-consent-modal"
        className="w-full max-w-md rounded-2xl border border-cream-08 bg-[#0F1318] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-400/10 text-xl">
            👋
          </span>
          <h2 id="nofeed-consent-title" className="text-base font-bold text-cream" data-testid="nofeed-consent-title">
            Quick heads-up about {tokenSymbol}
          </h2>
        </div>

        <p className="mb-5 text-[13px] leading-relaxed text-cream-70" data-testid="nofeed-consent-body">
          For most coins, TeraSwap watches the live market price on every buy — like a referee
          making sure you always get a fair deal. {tokenSymbol} doesn&apos;t have that referee
          available. The floor your buys are set against is a last-resort backstop, not a fair-price
          check: it sits low enough that a bad deal could still go through. That is why TeraSwap no
          longer starts recurring buys for coins in this position.
        </p>

        <div className="flex gap-3">
          <button
            ref={rejectRef}
            onClick={onReject}
            data-testid="nofeed-consent-reject"
            className="flex-1 rounded-xl border border-cream-08 py-2.5 text-xs font-semibold text-cream-50 transition hover:bg-cream-08 hover:text-cream"
          >
            Reject
          </button>
          <button
            onClick={onAccept}
            data-testid="nofeed-consent-accept"
            className="flex-1 rounded-xl bg-cream-gold py-2.5 text-xs font-bold text-[#080B10] transition hover:bg-gold-light"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}
