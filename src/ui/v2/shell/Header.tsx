'use client'

import Link from 'next/link'
import { ConnectArea } from './ConnectArea'
import { NetworkMenu } from './NetworkMenu'

/**
 * [ADR-025] Shell header (pack 01): logo (no BETA, no theme toggle — dark only), network dropdown, connect.
 * Search is not part of the header. The v1 tagline ("Meta-Aggregator") has no place in pack 01 and is kept as
 * screen-reader text on the logo link so no v1 content is lost.
 */
export function Header({ onLogoClick }: { onLogoClick?: () => void }) {
  return (
    <header className="ts-v2-rule-b flex items-center justify-between gap-3 px-4 py-4 sm:px-8">
      <Link
        href="/"
        onClick={(e) => {
          if (!onLogoClick) return
          e.preventDefault()
          onLogoClick()
        }}
        className="border-l-[3px] border-v2-cream pl-3 font-v2-display text-2xl uppercase tracking-[3px] text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
      >
        TeraSwap
        <span className="sr-only"> Meta-Aggregator</span>
      </Link>
      <div className="flex items-center gap-2 sm:gap-3">
        <NetworkMenu />
        <ConnectArea />
      </div>
    </header>
  )
}
