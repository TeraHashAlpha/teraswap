'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { helpSections } from '@/lib/help-content'
import { SUPPORT_EMAIL } from '@/lib/constants'
import { EyebrowLabel, Input, Surface } from '../primitives'
import { cx } from '../primitives/cx'

const X_URL = 'https://x.com/TeraHash'

// Round 7 D3 item 7: link-buttons are text + hairline underline, never an outlined box.
const HELP_LINK =
  'ts-v2-underline inline-flex min-h-[44px] items-center justify-center bg-transparent px-1 font-v2-mono text-[12px] font-medium uppercase tracking-[1.5px] text-v2-cream hover:text-v2-text'

/**
 * [ADR-025] Help Center drawer (pack 03): 440 px from the right; Esc, the overlay and ✕ close it. Content is
 * v1's `helpSections` (same module — no copy is retyped here), with the pack's search field filtering it, and the
 * v1 "need more help" links (X, support e-mail).
 */
export function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [openSection, setOpenSection] = useState<number | null>(0)
  const [openItem, setOpenItem] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const q = query.trim().toLowerCase()
  const sections = useMemo(
    () =>
      helpSections
        .map((section, sIdx) => ({
          sIdx,
          title: section.title,
          items: section.items
            .map((item, iIdx) => ({ ...item, key: `${sIdx}-${iIdx}` }))
            .filter((item) => !q || `${item.q} ${item.a}`.toLowerCase().includes(q)),
        }))
        .filter((section) => section.items.length > 0),
    [q],
  )

  if (!open) return null

  return (
    <>
      <div aria-hidden="true" className="fixed inset-0 z-[60] bg-black/55" onClick={onClose} />
      {/* Round 7 D3 item 16: a solid --bg panel with a left hairline only. */}
      <Surface
        variant="sheet"
        edge="left"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed inset-y-0 right-0 z-[70] flex w-full max-w-[440px] flex-col overflow-y-auto px-6 py-6"
      >
        <div className="flex items-start justify-between">
          <EyebrowLabel>Help Center</EyebrowLabel>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close help"
            className="flex h-11 w-11 items-center justify-center text-v2-muted hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-teal"
          >
            ✕
          </button>
        </div>
        <h2 id={titleId} className="mt-2 font-v2-display text-4xl uppercase leading-none text-v2-text">
          How can we help?
        </h2>
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help…"
          aria-label="Search help"
          className="mt-5"
        />

        <div className="mt-4">
          {sections.map((section) => {
            const expanded = q ? true : openSection === section.sIdx
            return (
              <div key={section.title} className="ts-v2-rule-b">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpenSection(expanded && !q ? null : section.sIdx)}
                  className="flex min-h-[46px] w-full items-center justify-between py-3 text-left text-[15px] text-v2-text"
                >
                  {section.title}
                  <span aria-hidden="true" className={cx('text-v2-muted transition-transform', expanded && 'rotate-180')}>
                    ⌄
                  </span>
                </button>
                {expanded ? (
                  // Round 7 D3 item 17: the open group is indented under a single hairline, no surrounding box
                  <div className="ts-v2-rule-l mb-2 ml-1 pl-3">
                    {section.items.map((item) => {
                      const itemOpen = openItem === item.key
                      return (
                        <div key={item.key}>
                          <button
                            type="button"
                            aria-expanded={itemOpen}
                            onClick={() => setOpenItem(itemOpen ? null : item.key)}
                            className={cx('min-h-[40px] w-full py-2 text-left text-[13px]', itemOpen ? 'text-v2-cream' : 'text-v2-muted')}
                          >
                            {item.q}
                          </button>
                          {itemOpen ? (
                            <p className="mb-2 py-2 text-[13px] leading-relaxed text-v2-text">
                              {item.a}
                            </p>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>

        <div className="mt-6">
          <EyebrowLabel>Need more help?</EyebrowLabel>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <a href={`mailto:${SUPPORT_EMAIL}`} className={HELP_LINK}>
              Email support
            </a>
            <a href={X_URL} target="_blank" rel="noopener noreferrer" className={HELP_LINK}>
              @TeraHash on X
            </a>
          </div>
          <p className="mt-3 font-v2-mono text-xs text-v2-cream">{SUPPORT_EMAIL}</p>
        </div>
      </Surface>
    </>
  )
}
