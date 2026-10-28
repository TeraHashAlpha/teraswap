'use client'

import { useId, useState } from 'react'
import { AGGREGATOR_META } from '@/lib/constants'
import { Button, Surface } from '../primitives'
import { TOGGLEABLE_SOURCES } from '@/components/SourceToggle'

/**
 * Round 7 item 9/17 + frame 24: "N sources enabled" is a text trigger (the same data as v1's SourceToggle — the
 * product-claims source list minus the user's exclusions); it opens the Liquidity Sources list on a solid popover.
 * Same behaviour and copy as v1: Deselect all / Select all, per-source MEV / Direct badges, the "reduces competition" note.
 */
export function SourcesMenu({ excluded, onToggle }: { excluded: Set<string>; onToggle: (source: string) => void }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const total = TOGGLEABLE_SOURCES.length
  const enabled = total - excluded.size

  const toggleAll = () => {
    if (excluded.size === 0) TOGGLEABLE_SOURCES.slice(1).forEach((s) => onToggle(s)) // all on → keep the first only
    else Array.from(excluded).forEach((s) => onToggle(s)) // otherwise enable all
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-[44px] items-center gap-2 font-v2-mono text-[12px] font-medium uppercase tracking-[1.5px] text-v2-text/90 hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
      >
        <span aria-hidden="true">&#9881;</span>
        <span>{enabled === total ? `${enabled} sources enabled` : `${enabled} of ${total} sources enabled`}</span>
      </button>

      {open && (
        <Surface id={panelId} variant="popover" className="absolute left-0 top-full z-20 mt-1 w-full min-w-[260px] max-w-[360px] p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-[14px] font-semibold text-v2-text">Liquidity Sources</span>
            <span className="flex items-center gap-1">
              <Button variant="text" onClick={toggleAll}>
                {excluded.size === 0 ? 'Deselect all' : 'Select all'}
              </Button>
              <Button variant="icon" onClick={() => setOpen(false)} aria-label="Close liquidity sources panel">
                <span aria-hidden="true">&#10005;</span>
              </Button>
            </span>
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {TOGGLEABLE_SOURCES.map((source) => {
              const meta = AGGREGATOR_META[source]
              const on = !excluded.has(source)
              return (
                <li key={source}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => onToggle(source)}
                    className={`flex min-h-[44px] w-full items-center gap-3 text-left text-[14px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal ${on ? 'text-v2-text' : 'text-v2-muted'}`}
                  >
                    <span aria-hidden="true" className={`ts-swap-check ${on ? 'is-on' : ''}`}>{on ? '✓' : ''}</span>
                    <span className="flex-1">{meta.label}</span>
                    {meta.mevProtected && <span className="font-v2-mono text-[10px] uppercase tracking-[1.5px] text-v2-cream">MEV</span>}
                    {meta.isDirect && <span className="font-v2-mono text-[10px] uppercase tracking-[1.5px] text-v2-amber">Direct</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="mt-3 text-[12px] text-v2-muted">Disabling sources reduces competition. Keep all enabled for best prices.</p>
        </Surface>
      )}
    </div>
  )
}
