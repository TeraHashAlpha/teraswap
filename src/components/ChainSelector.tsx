'use client'

import { useState, useRef, useEffect } from 'react'
import { useSwitchChain } from 'wagmi'
import { getSupportedChainIds, getChainConfig } from '@/lib/chains'
import { useActiveChainId } from '@/hooks/useChainId'

/** Per-chain accent dot colour. */
const CHAIN_DOT: Record<number, string> = {
  1: 'bg-cream-65',      // Ethereum
  8453: 'bg-blue-400',   // Base
}

/**
 * [P219] Compact chain switcher for the header.
 *
 * Lists every supported chain (registry-driven). Switching uses wagmi's
 * useSwitchChain. A chain whose FeeCollector isn't deployed yet (feeCollector
 * === null) is switchable but flagged "Coming Soon" — swaps stay gated
 * downstream until the contract is live. Mainnet is the default and is
 * unaffected when selected.
 */
export default function ChainSelector() {
  const activeChainId = useActiveChainId()
  const { switchChain, isPending } = useSwitchChain()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const chains = getSupportedChainIds().map((id) => getChainConfig(id))
  const active = chains.find((c) => c.chainId === activeChainId) ?? chains[0]

  return (
    <div ref={ref} className="relative hidden sm:block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Network: ${active.name}`}
        className="flex items-center gap-1.5 rounded-full border border-cream-15 px-3 py-1.5 text-xs font-medium text-cream-65 transition hover:border-cream-35 hover:text-cream"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${CHAIN_DOT[active.chainId] ?? 'bg-cream-65'} animate-pulse-slow`} />
        {active.name}
        <span aria-hidden="true" className="text-cream-35">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-50 mt-2 w-48 overflow-hidden rounded-xl border border-cream-08 py-1 backdrop-blur-2xl"
          style={{ backgroundColor: 'var(--header-blur)' }}
        >
          {chains.map((c) => {
            const comingSoon = c.contracts.feeCollector === null
            const isActive = c.chainId === activeChainId
            return (
              <button
                key={c.chainId}
                type="button"
                role="option"
                aria-selected={isActive}
                disabled={isActive || isPending}
                onClick={() => {
                  switchChain({ chainId: c.chainId })
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition ${
                  isActive ? 'text-cream' : 'text-cream-65 hover:bg-cream-08 hover:text-cream'
                } disabled:cursor-default`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${CHAIN_DOT[c.chainId] ?? 'bg-cream-65'}`} />
                <span className="flex-1">{c.name}</span>
                {comingSoon && (
                  <span className="rounded-full border border-cream-15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cream-35">
                    Soon
                  </span>
                )}
                {isActive && <span aria-hidden="true" className="text-success">✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
