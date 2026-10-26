'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { playTouchMP3 } from '@/lib/sounds'
import { Button } from '../primitives'
import { cx } from '../primitives/cx'

/** Same four anchors, in v1's order (src/components/Header.tsx NAV_LINKS); Docs and My Analytics are routes. */
export const LANDING_NAV = [
  { label: 'Performance', id: 'performance' },
  { label: 'Security', id: 'security' },
  { label: 'Experience', id: 'experience' },
  { label: 'Features', id: 'features' },
] as const

const LINK =
  'text-[13px] font-medium text-v2-muted transition-colors hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal'

/**
 * [ADR-025] Landing header (pack 10a / m01): logo, nav (Performance · Security · Experience · Features · Docs ·
 * My Analytics — I-6), Launch app. Destinations are v1's: the four anchors scroll to their section, Docs → /docs, and
 * "My Analytics" → /analytics appears only with a connected wallet (the dashboard is wallet-scoped; v1 P99).
 * Under 768 px the nav folds into a ☰ menu, as in v1.
 */
export function LandingHeader({ onLaunchApp }: { onLaunchApp: () => void }) {
  const { isConnected } = useAccount()
  const [menu, setMenu] = useState(false)

  const links = (
    <>
      {LANDING_NAV.map((l) => (
        <a key={l.id} href={`#${l.id}`} onClick={() => setMenu(false)} className={LINK}>
          {l.label}
        </a>
      ))}
      <Link href="/docs" onClick={() => setMenu(false)} className={LINK}>
        Docs
      </Link>
      {isConnected ? (
        <Link href="/analytics" onClick={() => setMenu(false)} className={LINK}>
          My Analytics
        </Link>
      ) : null}
    </>
  )

  return (
    <header className="relative z-20 flex items-center justify-between gap-3 px-4 py-4 sm:px-8">
      <div className="flex flex-col">
        <span className="border-l-[3px] border-v2-cream pl-3 font-v2-display text-2xl uppercase tracking-[3px] text-v2-text">TeraSwap</span>
        <span className="sr-only">Meta-Aggregator</span>
      </div>
      <nav aria-label="Sections" className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 md:flex">
        {links}
      </nav>
      <div className="flex items-center gap-2">
        <Button
          className="h-11 min-h-0 px-4 sm:px-6"
          onClick={() => {
            playTouchMP3()
            onLaunchApp()
          }}
        >
          Launch app
        </Button>
        <button
          type="button"
          aria-label="Menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
          className="flex h-11 w-11 items-center justify-center rounded-v2-control border border-v2-border bg-v2-surface text-v2-muted hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal md:hidden"
        >
          <span aria-hidden="true">{menu ? '✕' : '☰'}</span>
        </button>
      </div>
      {menu ? (
        <nav
          aria-label="Sections"
          className={cx('absolute inset-x-0 top-full z-30 flex flex-col gap-4 border-b border-v2-border bg-v2-bg/95 p-4 md:hidden')}
        >
          {links}
        </nav>
      ) : null}
    </header>
  )
}
