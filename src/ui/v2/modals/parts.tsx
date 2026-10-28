'use client'

import type { ReactNode } from 'react'
import { UNPRICED_CONSENT_CHECKBOX, UNPRICED_CONSENT_HEADING, unpricedConsentCopy } from '@/components/SwapUnpricedConsentDialog'
import { cx } from '../primitives/cx'
import type { ConsentValues } from './review-model'

/** A review line: muted label left, mono value right — separated by whitespace, not boxes. */
export function ReviewRow({ label, children, tone, className, testId }: { label: ReactNode; children: ReactNode; tone?: 'green' | 'amber' | 'red' | 'cream' | 'muted'; className?: string; testId?: string }) {
  const color = { green: 'text-v2-green', amber: 'text-v2-amber', red: 'text-v2-red', cream: 'text-v2-cream', muted: 'text-v2-muted' }[tone ?? 'muted']
  return (
    <div data-testid={testId} className={cx('flex items-start justify-between gap-6 py-[7px] text-[14px]', className)}>
      <span className="shrink-0 text-v2-muted">{label}</span>
      <span className={cx('min-w-0 text-right font-v2-mono tabular-nums', tone ? color : 'text-v2-text/90')}>{children}</span>
    </div>
  )
}

/** "ENFORCED ON-CHAIN" and friends: a small mono-caps marker in a status colour — no pill, no outline. */
export function Mark({ children, tone = 'green' }: { children: ReactNode; tone?: 'green' | 'amber' | 'cream' }) {
  const color = { green: 'text-v2-green', amber: 'text-v2-amber', cream: 'text-v2-cream' }[tone]
  return <span className={cx('font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px]', color)}>{children}</span>
}

/**
 * The unpriced informed-consent block (#608, owner copy 2026-10-26) — the dialog's heading, body and checkbox label are v1's OWN
 * exports (`UNPRICED_CONSENT_HEADING`, `unpricedConsentCopy`, `UNPRICED_CONSENT_CHECKBOX`), so the words cannot drift; only the
 * placement changed: inline in the review sheet, gating its Confirm.
 */
export function ConsentBlock({ values, checked, onChange }: { values: ConsentValues; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <section data-testid="unpriced-consent" aria-labelledby="v2-unpriced-consent-h" className="mt-4 border-l-2 border-v2-amber py-1 pl-4">
      <h3 id="v2-unpriced-consent-h" data-testid="unpriced-consent-heading" className="text-[14px] font-semibold text-v2-text">
        {UNPRICED_CONSENT_HEADING}
      </h3>
      <p data-testid="unpriced-consent-body" className="mt-1 text-[13px] leading-relaxed text-v2-text/90">
        {unpricedConsentCopy(values)}
      </p>
      <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-3 text-[14px] text-v2-text">
        <input type="checkbox" data-testid="unpriced-consent-checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#EADFB6]" />
        {UNPRICED_CONSENT_CHECKBOX}
      </label>
    </section>
  )
}

export function truncAddr(addr: string): string {
  if (!addr || addr.length <= 12) return addr || '—'
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}
