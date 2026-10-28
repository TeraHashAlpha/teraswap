'use client'

import { useRef, useState } from 'react'
import { Button } from '../primitives'
import { Sheet } from './Sheet'
import { ReviewRow } from './parts'

/** v1's key (Permit2EducationModal.tsx) — `isPermit2Educated()` reads it, so "Don't show this again" is honoured by v1's own check. */
const STORAGE_KEY = 'teraswap:permit2-educated:v1'

/**
 * [ADR-025] Round 7 frame 25 — the one-time Permit2 explainer, shown before the first Permit2 signature. Driven by `useApproval`
 * exactly as v1 drives its modal: `open` = `needsPermit2Education`, Continue = `confirmPermit2Education`, Cancel / Esc =
 * `cancelPermit2Education`. Every word is v1's (the frame's "How Permit2 approvals work" is a re-write and is not used).
 */
export function Permit2Sheet({ onConfirm, onCancel, amount, tokenSymbol }: { onConfirm: () => void; onCancel: () => void; amount?: string; tokenSymbol?: string }) {
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  function handleConfirm() {
    if (dontShowAgain) {
      try {
        localStorage.setItem(STORAGE_KEY, '1')
      } catch {
        /* ignore */
      }
    }
    onConfirm()
  }

  return (
    <Sheet name="permit2" size="md" title="About to sign a Permit2 approval" subtitle="One-time explainer — understand what you're signing" onClose={onCancel} initialFocusRef={cancelRef}>
      <p className="mt-5 font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-cream">What you&apos;re signing</p>
      <div className="mt-1">
        <ReviewRow label="Spender">Permit2 (0x0000...30F1)</ReviewRow>
        {amount && tokenSymbol && (
          <ReviewRow label="Amount">
            {amount} {tokenSymbol}
          </ReviewRow>
        )}
        <ReviewRow label="Expiration" tone="green">
          24 hours
        </ReviewRow>
      </div>

      <p className="mt-5 font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-red">How to spot phishing</p>
      <ul className="mt-2 space-y-2 text-[13px] leading-relaxed text-v2-text/90">
        <li className="flex gap-2">
          <span aria-hidden="true" className="shrink-0 text-v2-green">
            ✓
          </span>
          <span>
            <b className="font-semibold text-v2-text">Legitimate (TeraSwap):</b> exact swap amount, 24h expiry, spender is Permit2 contract
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="shrink-0 text-v2-red">
            ✗
          </span>
          <span>
            <b className="font-semibold text-v2-text">Phishing (drainer kits):</b> max amount (unlimited), expiry in year 8921+, unknown spender address
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="shrink-0 text-v2-amber">
            !
          </span>
          <span>
            If a site asks you to sign a Permit2 message with unlimited amount and far-future expiry — <b className="font-semibold text-v2-red">reject it immediately</b>
          </span>
        </li>
      </ul>

      <label className="mt-4 flex min-h-[44px] cursor-pointer items-center gap-3 text-[13px] text-v2-muted">
        <input type="checkbox" checked={dontShowAgain} onChange={(e) => setDontShowAgain(e.target.checked)} className="h-4 w-4 accent-[#EADFB6]" />
        Don&apos;t show this again
      </label>

      <div className="mt-3 flex flex-col gap-1">
        <Button variant="primary" onClick={handleConfirm} className="w-full">
          Continue to signature
        </Button>
        <Button ref={cancelRef} variant="text" onClick={onCancel} className="w-full">
          Cancel
        </Button>
      </div>

      <p className="mt-3 text-center text-[12px] text-v2-muted">
        <a href="https://support.metamask.io/privacy-and-security/staying-safe-in-web3/what-is-a-token-approval/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-v2-text">
          Learn more about token approvals →
        </a>
      </p>
    </Sheet>
  )
}
