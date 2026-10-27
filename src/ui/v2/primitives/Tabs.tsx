'use client'

import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from './cx'

export interface TabItem {
  id: string
  label: ReactNode
  disabled?: boolean
  /** Optional text marker after the label (e.g. "soon"), rendered as a dim `· label` — never a chip (Round 7 D2). */
  badge?: ReactNode
}

export interface TabsProps {
  tabs: TabItem[]
  active: string
  onSelect: (id: string) => void
  /** Accessible name of the tab list. */
  label: string
  /** `sm` for sub-tabs (ACTIVE / COMPLETED, NEW DCA / POSITIONS). */
  size?: 'md' | 'sm'
  className?: string
}

/**
 * Round 7 D3 underline tabs. Active = cream label + 2 px cream underline; others muted; disabled = dim (+ optional text
 * badge). No pill, no fill. Arrow/Home/End move between enabled tabs.
 */
export function Tabs({ tabs, active, onSelect, label, size = 'md', className }: TabsProps) {
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
    <div ref={listRef} role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cx('flex items-center', size === 'sm' ? 'gap-5' : 'gap-6', className)}>
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
              'relative inline-flex min-h-[44px] items-center gap-2 pb-1 font-v2-mono font-bold uppercase tracking-[1.5px]',
              size === 'sm' ? 'text-[12px]' : 'text-[13px]',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal',
              t.disabled ? 'cursor-not-allowed text-v2-dim' : isActive ? 'text-v2-cream' : 'text-v2-muted hover:text-v2-text',
            )}
          >
            {t.label}
            {t.badge ? (
              <span data-tab-badge className="text-[10px] font-medium leading-none text-v2-dim">
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

/** Segmented control = the same underline tab row, small (Round 7 D3 item 8: no filled pill). */
export function Segmented(props: Omit<TabsProps, 'size'>) {
  return <Tabs {...props} size="sm" />
}
