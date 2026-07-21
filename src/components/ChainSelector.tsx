'use client'

import { useState, useRef, useEffect, useMemo, type KeyboardEvent } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { getSupportedChainIds, getChainConfig } from '@/lib/chains'
import { useActiveChainId } from '@/hooks/useChainId'
import ChainIcon from './icons/ChainIcon'

/**
 * [CHORE-CHAIN-SELECTOR-UX] Relay/Uniswap-style network picker: a search-first
 * popover with a scrollable listbox, keyboard navigation, and ARIA
 * listbox/option semantics. Display/UX only — chain LIST + active state +
 * gating are unchanged from [P219]/[SPRINT-46-ARBITRUM-CONFIG]:
 *
 *   - chains come from the registry (getSupportedChainIds()/getChainConfig)
 *   - `comingSoon = feeCollector === null` is the sole activation gate
 *   - selecting a chain calls wagmi's useSwitchChain — same as before
 *
 * `variant="compact"` (default) is the Header's icon+name trigger button that
 * opens the popover. `variant="full"` renders the search+listbox inline
 * (no trigger button) for embedding directly in a form/panel — unused today
 * (the sweep for CHORE-CHAIN-SELECTOR-UX found only the Header usage) but
 * kept as the documented extension point the spec asks for.
 *
 * [BUG-MOBILE-CHAIN-SELECTOR] The trigger button used to render
 * `hidden sm:block` on its wrapping div — hiding it unconditionally below the
 * `sm` breakpoint regardless of wallet connection, which is why it was
 * missing from the mobile header entirely. Now always visible: an icon-only
 * circle below `sm`, icon+name from `sm` up (same single button both ways).
 * The popover becomes a bottom sheet below `sm`; desktop's positioned panel
 * is unchanged. Selecting a chain while disconnected updates
 * `disconnectedChainId` (local state) instead of calling wagmi's
 * `switchChain` — there's no wallet chain to switch to when there's no
 * wallet. There is no app-wide "selected chain" store yet, so this only
 * drives what this trigger/list displays, not quoting/routing (those stay
 * on the existing wallet-derived `useActiveChainId()` default).
 */
interface ChainSelectorProps {
  variant?: 'compact' | 'full'
}

export default function ChainSelector({ variant = 'compact' }: ChainSelectorProps) {
  const { isConnected } = useAccount()
  const activeChainId = useActiveChainId()
  const { switchChain, isPending } = useSwitchChain()
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [disconnectedChainId, setDisconnectedChainId] = useState<number | null>(null)
  const displayChainId = isConnected ? activeChainId : (disconnectedChainId ?? activeChainId)

  const chains = useMemo(() => getSupportedChainIds().map((id) => getChainConfig(id)), [])
  const active = chains.find((c) => c.chainId === displayChainId) ?? chains[0]
  const initialHighlight = () => {
    const idx = chains.findIndex((c) => c.chainId === displayChainId)
    return idx >= 0 ? idx : 0
  }

  const [open, setOpen] = useState(variant === 'full')
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(initialHighlight)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return chains
    return chains.filter((c) => c.name.toLowerCase().includes(q))
  }, [chains, query])

  const isSelectable = (chainId: number) => getChainConfig(chainId).contracts.feeCollector !== null

  useEffect(() => {
    if (variant === 'full') return
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [variant])

  function openMenu() {
    setQuery('')
    setHighlighted(initialHighlight())
    setOpen(true)
  }

  function toggleMenu() {
    if (open) setOpen(false)
    else openMenu()
  }

  function onQueryChange(value: string) {
    setQuery(value)
    setHighlighted(0) // first match, re-derived on every keystroke — not a stale reset
  }

  function selectChain(chainId: number) {
    if (!isSelectable(chainId) || chainId === displayChainId || isPending) return
    if (isConnected) {
      switchChain({ chainId })
    } else {
      setDisconnectedChainId(chainId)
    }
    if (variant !== 'full') setOpen(false)
  }

  function closeAndRefocus() {
    setOpen(false)
    if (variant !== 'full') triggerRef.current?.focus()
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[highlighted]
      if (target) selectChain(target.chainId)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (variant !== 'full') closeAndRefocus()
    }
  }

  const listboxId = 'chain-selector-listbox'

  const list = (
    <div
      id={listboxId}
      role="listbox"
      aria-label="Networks"
      className="max-h-[50dvh] overflow-y-auto overscroll-contain py-1 sm:max-h-72"
    >
      {filtered.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-cream-35">No networks found</div>
      )}
      {filtered.map((c, i) => {
        const comingSoon = c.contracts.feeCollector === null
        const isActive = c.chainId === displayChainId
        const isHighlighted = i === highlighted
        return (
          <button
            key={c.chainId}
            id={`chain-option-${c.chainId}`}
            type="button"
            role="option"
            aria-selected={isActive}
            aria-disabled={comingSoon}
            disabled={comingSoon || isActive || isPending}
            onMouseEnter={() => setHighlighted(i)}
            onClick={() => selectChain(c.chainId)}
            className={`flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left text-sm transition sm:h-10 sm:min-h-0 ${
              comingSoon ? 'cursor-not-allowed text-cream-35 opacity-50' : isActive ? 'text-cream' : 'text-cream-65 hover:text-cream'
            } ${isHighlighted && !comingSoon && !isActive ? 'bg-cream-08 text-cream' : ''} disabled:cursor-not-allowed`}
          >
            <ChainIcon chainId={c.chainId} className="h-6 w-6 shrink-0 rounded-full" />
            <span className="flex-1 truncate">{c.name}</span>
            {comingSoon && (
              <span className="rounded-full border border-cream-15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cream-35">
                Soon
              </span>
            )}
            {isActive && (
              <span aria-hidden="true" className="text-success">
                ✓
              </span>
            )}
          </button>
        )
      })}
    </div>
  )

  const panel = (
    <div
      role="presentation"
      className="z-50 w-full overflow-hidden rounded-t-2xl border border-cream-15 shadow-2xl shadow-black/40 sm:w-64 sm:rounded-xl sm:border-cream-08 sm:shadow-none"
      style={{ backgroundColor: 'var(--header-blur)' }}
    >
      {/* Drag pill — mobile bottom-sheet affordance */}
      <div className="mx-auto mb-1 mt-2 h-1 w-10 rounded-full bg-cream-15 sm:hidden" />

      <div className="flex items-center gap-2 border-b border-cream-08 px-3 py-2">
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="h-4 w-4 shrink-0 text-cream-35"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="m17 17-3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Search networks…"
          aria-label="Search networks"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={filtered[highlighted] ? `chain-option-${filtered[highlighted].chainId}` : undefined}
          className="w-full bg-transparent text-base text-cream placeholder:text-cream-35 focus:outline-none sm:text-sm"
        />
      </div>
      {list}
    </div>
  )

  if (variant === 'full') {
    return <div ref={containerRef}>{panel}</div>
  }

  return (
    <div ref={containerRef} className="relative">
      {/* One trigger, two looks: icon-only circle below `sm` (compact, always
          visible — this is what #310 was missing on mobile), icon+name pill
          from `sm` up (desktop, unchanged). */}
      <button
        ref={triggerRef}
        type="button"
        onClick={toggleMenu}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeAndRefocus()
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Network: ${active.name}`}
        className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full border border-cream-15 text-cream-65 transition hover:border-cream-35 hover:text-cream sm:h-auto sm:w-auto sm:px-3 sm:py-1.5 sm:text-xs sm:font-medium"
      >
        <ChainIcon chainId={active.chainId} className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline">{active.name}</span>
        <span aria-hidden="true" className="hidden text-cream-35 sm:inline">▾</span>
      </button>

      {open && (
        <>
          {/* Mobile-only backdrop for the bottom sheet */}
          <div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm sm:hidden"
            onClick={closeAndRefocus}
          />
          <div className="fixed inset-x-0 bottom-0 z-50 animate-slide-up sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:animate-fade-slide-in">
            {panel}
          </div>
        </>
      )}
    </div>
  )
}
