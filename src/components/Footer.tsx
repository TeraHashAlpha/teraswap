'use client'

import { FEE_PERCENT } from '@/lib/constants'
import { useBlockNumber } from 'wagmi'

interface Props {
  onDocs?: () => void
  onPrivacy?: () => void
  onTerms?: () => void
}

export default function Footer({ onDocs, onPrivacy, onTerms }: Props) {
  const { data: blockNumber } = useBlockNumber({ watch: true })

  return (
    <footer className="relative z-[1] flex flex-wrap items-center justify-center gap-3 border-t border-cream-08 px-4 py-4 text-[11px] text-cream-35">
      <button onClick={onDocs} className="text-cream-50 transition hover:text-cream">Docs</button>
      <span className="text-cream-15">|</span>
      <a href="#" className="text-cream-50 transition hover:text-cream">GitHub</a>
      <span className="text-cream-15">|</span>
      <span>Fee: {FEE_PERCENT}%</span>
      <span className="text-cream-15">|</span>
      <span>No infinite approvals</span>
      {blockNumber && (
        <>
          <span className="text-cream-15">|</span>
          <span className="flex items-center gap-1">
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
    </footer>
  )
}
