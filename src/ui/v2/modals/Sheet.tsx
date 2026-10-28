'use client'

import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { Surface } from '../primitives'
import { cx } from '../primitives/cx'
import './modals.css'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type SheetSize = 'sm' | 'md' | 'lg' | 'xl'

export interface SheetProps {
  /** Esc, the dimmed page and the close control all land here. */
  onClose: () => void
  /** The visible heading — the dialog's accessible name. */
  title: ReactNode
  /** Optional line under the heading (the dialog's description). */
  subtitle?: ReactNode
  size?: SheetSize
  /** Focus lands here on open; default is the first focusable control. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Show the ✕ in the header (token selector). */
  closeButton?: boolean
  /** A click on the dimmed page closes the sheet (default). Consent-style sheets keep it off. */
  dismissOnBackdrop?: boolean
  /** Extra test/hook marker, e.g. `review`. */
  name?: string
  children: ReactNode
}

/**
 * Round 7 item 13 — the modal as a FULL-BLEED SHEET: the page behind is dimmed, the content sits on a solid --bg surface with
 * a top hairline only (no radius, no outline), and on a phone it is a bottom sheet. Focus is trapped inside while open, Esc
 * closes it, and focus returns to whatever opened it. One component for every v2 swap modal so none of them re-implements
 * the keyboard contract (v1's modals each carry their own copy, and the slippage / token / review ones have no trap at all).
 */
export function Sheet({ onClose, title, subtitle, size = 'md', initialFocusRef, closeButton = false, dismissOnBackdrop = true, name, children }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  const titleId = useId()
  const descId = useId()

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const focusables = () => (panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true') : [])
    // Focus the requested control, else the first one; a panel with nothing focusable holds focus itself.
    // preventScroll: a long sheet (review) must open at its title, not scrolled down to a footer button that took focus.
    ;(initialFocusRef?.current ?? focusables()[0] ?? panel)?.focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const list = focusables()
      if (list.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (!panel.contains(active)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      // Restore focus to the opener — unless the page has since removed it.
      if (opener && opener.isConnected) opener.focus()
    }
    // Mount-only on purpose: re-running on a new `initialFocusRef` identity would steal focus mid-interaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div data-sheet-root="" className="ts-sheet-root">
      <div aria-hidden="true" data-sheet-backdrop="" className="ts-sheet-backdrop" onClick={dismissOnBackdrop ? onClose : undefined} />
      <Surface
        ref={panelRef}
        variant="sheet"
        edge="top"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? descId : undefined}
        tabIndex={-1}
        data-sheet={name}
        data-size={size}
        className={cx('ts-sheet text-v2-text/90')}
      >
        <div className="ts-sheet-grab" aria-hidden="true" />
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[20px] font-semibold leading-tight text-v2-text">
              {title}
            </h2>
            {subtitle ? (
              <p id={descId} className="mt-1 text-[13px] text-v2-muted">
                {subtitle}
              </p>
            ) : null}
          </div>
          {closeButton ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center text-v2-muted hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-teal"
            >
              <span aria-hidden="true">✕</span>
            </button>
          ) : null}
        </div>
        {children}
      </Surface>
    </div>
  )
}
