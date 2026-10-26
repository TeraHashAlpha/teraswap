'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import ChainIcon from '@/components/icons/ChainIcon'
import { cx } from '../primitives/cx'
import { shellChains } from './chains'
import { useShellChain } from './use-shell-chain'

/**
 * [ADR-025] Network dropdown (pack 01): every registry chain, name + capability subtitle, a check on the selected
 * one. No search field (pack round 3 A2). Selection semantics are v1's (useShellChain).
 */
export function NetworkMenu() {
  const { chainId, select, isPending } = useShellChain()
  const chains = shellChains()
  const active = chains.find((c) => c.chainId === chainId) ?? chains[0]
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function openMenu() {
    setHighlight(Math.max(0, chains.findIndex((c) => c.chainId === chainId)))
    setOpen(true)
  }

  function close(refocus = true) {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  function choose(id: number) {
    select(id)
    close()
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        close()
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return openMenu()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight((i) => (i + step + chains.length) % chains.length)
    } else if (e.key === 'Enter' && open) {
      const target = chains[highlight]
      if (target?.selectable) {
        e.preventDefault()
        choose(target.chainId)
      }
    }
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Network: ${active.name}`}
        onClick={() => (open ? close(false) : openMenu())}
        className="inline-flex h-11 items-center gap-2 rounded-full border border-v2-border bg-v2-surface px-3 text-sm text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
      >
        <ChainIcon chainId={active.chainId} className="h-5 w-5 shrink-0" />
        <span className="hidden sm:inline">{active.name}</span>
        <span aria-hidden="true" className={cx('text-v2-muted transition-transform', open && 'rotate-180')}>
          ⌄
        </span>
      </button>

      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Networks"
          className="absolute right-0 top-full z-50 mt-2 w-[250px] rounded-v2-card border border-v2-border bg-v2-surface p-2 shadow-2xl shadow-black/40"
        >
          {chains.map((c, i) => {
            const selected = c.chainId === chainId
            return (
              <button
                key={c.chainId}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={!c.selectable}
                disabled={!c.selectable || isPending}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(c.chainId)}
                className={cx(
                  'flex w-full items-center gap-3 rounded-v2-control px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50',
                  (selected || i === highlight) && 'bg-v2-surface2',
                )}
              >
                <ChainIcon chainId={c.chainId} className="h-6 w-6 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-v2-text">{c.name}</span>
                  <span className="block text-[11px] text-v2-muted">{c.subtitle}</span>
                </span>
                {!c.selectable ? (
                  <span className="rounded-v2-chip border border-v2-border px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-v2-dim">Soon</span>
                ) : null}
                {selected ? (
                  <span aria-hidden="true" className="text-v2-text">
                    ✓
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
