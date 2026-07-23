'use client'

import { useEffect, useRef } from 'react'

/**
 * [FIX-DCA-NOFEED-CONSENT] Shown BEFORE signing whenever a DCA's output token has no Chainlink
 * price feed (getChainlinkFeed(tokenOut, chainId) === null) — the frontend/API $5 pre-flight can
 * no longer USD-value that leg, so the owner's decision is to ALLOW it, gated by explicit,
 * plain-language consent instead of a silent relaxation. Feed-covered tokens NEVER see this.
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
          available. Your buys still only happen at the lowest amount you agree to each time, so
          you&apos;re not unprotected — but there&apos;s no live-price referee double-checking the
          market for this coin. Everything else works the same.
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
