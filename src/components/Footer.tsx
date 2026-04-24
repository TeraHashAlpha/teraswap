'use client'

import Link from 'next/link'
import { FEE_PERCENT } from '@/lib/constants'
import { useBlockNumber } from 'wagmi'

interface Props {
  onPrivacy?: () => void
  onTerms?: () => void
}

export default function Footer({ onPrivacy, onTerms }: Props) {
  const { data: blockNumber } = useBlockNumber({ watch: true })

  return (
    <footer className="relative z-[1] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-cream-08 px-4 py-4 text-[11px] text-cream-35">
      <Link href="/docs" className="text-cream-50 transition hover:text-cream">Docs</Link>
      <span className="text-cream-15">|</span>
      <a href="#" className="text-cream-50 transition hover:text-cream">GitHub</a>
      <span className="text-cream-15">|</span>
      <a href="https://x.com/TeraSwapDeFi" target="_blank" rel="noopener noreferrer" className="text-cream-50 transition hover:text-cream" aria-label="X (Twitter)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      </a>
      <span className="text-cream-15">|</span>
      <span>Fee: {FEE_PERCENT}%</span>
      <span className="hidden text-cream-15 sm:inline">|</span>
      <span className="hidden sm:inline">No infinite approvals</span>
      {blockNumber && (
        <>
          <span className="hidden text-cream-15 sm:inline">|</span>
          <span className="hidden items-center gap-1 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            Block #{blockNumber.toLocaleString()}
          </span>
        </>
      )}
      <span className="text-cream-15">|</span>
      <button onClick={onPrivacy} className="text-cream-50 transition hover:text-cream">Privacy</button>
      <span className="text-cream-15">|</span>
      <button onClick={onTerms} className="text-cream-50 transition hover:text-cream">Terms</button>
      <span className="text-cream-15">|</span>
      <span>&copy; 2026 TeraSwap</span>
      <span className="text-cream-15">|</span>
      <a
        href="https://terahelps.netlify.app/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-cream-gold transition hover:text-cream"
      >
        TeraHelps
      </a>
    </footer>
  )
}
