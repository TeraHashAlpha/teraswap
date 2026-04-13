'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

const STORAGE_KEY = 'teraswap:permit2-educated:v1'

/**
 * One-time education modal shown before the user's first Permit2 signature.
 * Teaches the difference between a legitimate TeraSwap Permit2 approval and
 * a phishing signature from a drainer kit (Inferno, Angel, Pink).
 */
export default function Permit2EducationModal({
  open,
  onConfirm,
  onCancel,
  amount,
  tokenSymbol,
}: {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
  amount?: string
  tokenSymbol?: string
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const firstFocusRef = useRef<HTMLButtonElement>(null)

  // Focus trap + Esc to close
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement
    firstFocusRef.current?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { onCancel(); return }
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
  }, [open, onCancel])

  const handleConfirm = useCallback(() => {
    if (dontShowAgain) {
      try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* ignore */ }
    }
    onConfirm()
  }, [dontShowAgain, onConfirm])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4"
      onClick={onCancel}
      role="presentation"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="permit2-edu-title"
        className="w-full max-w-md rounded-2xl border border-cream-08 bg-[#0F1318] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-400/10 text-xl">
            🔑
          </span>
          <div>
            <h2 id="permit2-edu-title" className="text-base font-bold text-cream">
              About to sign a Permit2 approval
            </h2>
            <p className="mt-0.5 text-[11px] text-cream-40">
              One-time explainer — understand what you&apos;re signing
            </p>
          </div>
        </div>

        {/* What you're signing */}
        <div className="mb-4 rounded-xl border border-cream-08 bg-[#151A22] p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-cream-gold">
            What you&apos;re signing
          </p>
          <div className="space-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <span className="text-cream-40">Spender</span>
              <span className="font-mono text-cream-70">Permit2 (0x0000...30F1)</span>
            </div>
            {amount && tokenSymbol && (
              <div className="flex justify-between">
                <span className="text-cream-40">Amount</span>
                <span className="font-semibold text-cream">{amount} {tokenSymbol}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-cream-40">Expiration</span>
              <span className="text-emerald-300">24 hours</span>
            </div>
          </div>
        </div>

        {/* How to spot phishing */}
        <div className="mb-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-red-400/80">
            How to spot phishing
          </p>
          <div className="space-y-2 text-[11px] leading-relaxed text-cream-50">
            <div className="flex gap-2">
              <span className="shrink-0 text-emerald-400">✓</span>
              <span><b className="text-cream-70">Legitimate (TeraSwap):</b> exact swap amount, 24h expiry, spender is Permit2 contract</span>
            </div>
            <div className="flex gap-2">
              <span className="shrink-0 text-red-400">✗</span>
              <span><b className="text-cream-70">Phishing (drainer kits):</b> max amount (unlimited), expiry in year 8921+, unknown spender address</span>
            </div>
            <div className="flex gap-2">
              <span className="shrink-0 text-amber-400">!</span>
              <span>If a site asks you to sign a Permit2 message with unlimited amount and far-future expiry — <b className="text-red-400">reject it immediately</b></span>
            </div>
          </div>
        </div>

        {/* Don't show again */}
        <label className="mb-4 flex cursor-pointer items-center gap-2 text-[11px] text-cream-40">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-cream-20 bg-transparent accent-cream-gold"
          />
          Don&apos;t show this again
        </label>

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            ref={firstFocusRef}
            onClick={onCancel}
            className="flex-1 rounded-xl border border-cream-08 py-2.5 text-xs font-semibold text-cream-50 transition hover:bg-cream-08 hover:text-cream"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="flex-1 rounded-xl bg-cream-gold py-2.5 text-xs font-bold text-[#080B10] transition hover:bg-gold-light"
          >
            Continue to signature
          </button>
        </div>

        {/* Learn more */}
        <p className="mt-3 text-center text-[10px] text-cream-30">
          <a
            href="https://support.metamask.io/privacy-and-security/staying-safe-in-web3/what-is-a-token-approval/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 transition hover:text-cream-50"
          >
            Learn more about token approvals →
          </a>
        </p>
      </div>
    </div>
  )
}

/** Check if the user has already been educated */
export function isPermit2Educated(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
}
