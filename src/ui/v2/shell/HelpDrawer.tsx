'use client'

import { useMemo, useState } from 'react'
import { helpSections } from '@/lib/help-content'
import { SUPPORT_EMAIL } from '@/lib/constants'
import { EyebrowLabel, Input } from '../primitives'
import { cx } from '../primitives/cx'
import { Sheet } from '../modals/Sheet'

const X_URL = 'https://x.com/TeraHash'

// Round 7 D3 item 7: link-buttons are text + hairline underline, never an outlined box.
const HELP_LINK =
  'ts-v2-underline inline-flex min-h-[44px] items-center justify-center bg-transparent px-1 font-v2-mono text-[12px] font-medium uppercase tracking-[1.5px] text-v2-cream hover:text-v2-text'

/**
 * [ADR-025, L-6/A75] Help Center drawer (pack 03), built on modals/Sheet: Esc, the overlay, ✕ and Sheet's own Tab
 * trap + focus-restore-on-close, none of which the drawer used to have (one focus-on-open call, a window Esc
 * listener, no trap). Content is v1's `helpSections` (same module — no copy is retyped here), with the pack's
 * search field filtering it, and the v1 "need more help" links (X, support e-mail).
 */
export function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [openSection, setOpenSection] = useState<number | null>(0)
  const [openItem, setOpenItem] = useState<string | null>(null)

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
    <Sheet onClose={onClose} title="How can we help?" size="md" edge="left" name="help">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close help"
        className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center text-v2-muted hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-teal"
      >
        ✕
      </button>
      <EyebrowLabel>Help Center</EyebrowLabel>
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search help…"
        aria-label="Search help"
        className="mt-3"
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
    </Sheet>
  )
}
