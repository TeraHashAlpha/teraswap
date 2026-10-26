'use client'

import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from './cx'

export interface TabItem {
  id: string
  label: ReactNode
  disabled?: boolean
  /** Optional chip after the label (e.g. a "soon" marker); content is supplied by the caller. */
  badge?: ReactNode
}

export interface TabsProps {
  tabs: TabItem[]
  active: string
  onSelect: (id: string) => void
  /** Accessible name of the tab list. */
  label: string
  className?: string
}

/** Active = text + cream bar; disabled = dim (+ optional badge). Arrow/Home/End move between enabled tabs. */
export function Tabs({ tabs, active, onSelect, label, className }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null)

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const enabled = tabs.filter((t) => !t.disabled)
    const i = enabled.findIndex((t) => t.id === active)
    let next: TabItem | undefined
    if (e.key === 'ArrowRight') next = enabled[(i + 1) % enabled.length]
    else if (e.key === 'ArrowLeft') next = enabled[(i - 1 + enabled.length) % enabled.length]
    else if (e.key === 'Home') next = enabled[0]
    else if (e.key === 'End') next = enabled[enabled.length - 1]
    if (!next) return
    e.preventDefault()
    onSelect(next.id)
    listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)?.focus()
  }

  return (
    <div ref={listRef} role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cx('flex items-center gap-6', className)}>
      {tabs.map((t) => {
        const isActive = t.id === active
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab-id={t.id}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onSelect(t.id)}
            className={cx(
              'relative inline-flex items-center gap-2 pb-2 font-v2-mono text-[13px] font-bold uppercase tracking-[1.5px]',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal',
              t.disabled ? 'cursor-not-allowed text-v2-dim' : isActive ? 'text-v2-text' : 'text-v2-muted',
            )}
          >
            {t.label}
            {t.badge ? (
              <span className="rounded-v2-chip border border-v2-border bg-v2-surface2 px-1.5 py-0.5 text-[10px] leading-none text-v2-dim">
                {t.badge}
              </span>
            ) : null}
            {isActive ? <span aria-hidden="true" data-tab-bar className="absolute inset-x-0 bottom-0 h-0.5 bg-v2-cream" /> : null}
          </button>
        )
      })}
    </div>
  )
}
