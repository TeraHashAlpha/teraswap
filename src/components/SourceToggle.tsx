'use client'

import { useState } from 'react'
import { AGGREGATOR_META, type AggregatorName } from '@/lib/constants'

// Sources shown in the toggle (exclude internal engine)
const TOGGLEABLE_SOURCES: AggregatorName[] = [
  '1inch', '0x', 'velora', 'odos', 'kyberswap',
  'cowswap', 'uniswap', 'openocean', 'sushiswap', 'balancer', 'curve',
]

interface SourceToggleProps {
  excludedSources: Set<string>
  onToggle: (source: string) => void
}

export default function SourceToggle({ excludedSources, onToggle }: SourceToggleProps) {
  const [open, setOpen] = useState(false)

  const enabledCount = TOGGLEABLE_SOURCES.length - excludedSources.size

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg border border-cream-08 bg-surface px-2.5 py-1 text-[11px] text-cream-50 transition hover:border-cream-15 hover:text-cream"
      >
        <span className="text-[10px]">&#9881;</span>
        <span>{enabledCount}/{TOGGLEABLE_SOURCES.length} sources</span>
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Dropdown */}
          <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border border-cream-08 bg-surface p-2 shadow-2xl">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[11px] font-medium text-cream-50">Liquidity Sources</span>
              <button
                onClick={() => {
                  // Toggle all on/off
                  if (excludedSources.size === 0) {
                    // Exclude all except first
                    TOGGLEABLE_SOURCES.slice(1).forEach(s => {
                      if (!excludedSources.has(s)) onToggle(s)
                    })
                  } else {
                    // Enable all
                    excludedSources.forEach(s => onToggle(s))
                  }
                }}
                className="text-[10px] text-cream-gold hover:underline"
              >
                {excludedSources.size === 0 ? 'Deselect all' : 'Select all'}
              </button>
            </div>

            <div className="max-h-64 overflow-y-auto">
              {TOGGLEABLE_SOURCES.map(source => {
                const meta = AGGREGATOR_META[source]
                const enabled = !excludedSources.has(source)

                return (
                  <button
                    key={source}
                    onClick={() => onToggle(source)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition ${
                      enabled
                        ? 'text-cream hover:bg-cream-08'
                        : 'text-cream-35 hover:bg-cream-08/50'
                    }`}
                  >
                    <div
                      className={`h-3.5 w-3.5 flex-shrink-0 rounded border ${
                        enabled
                          ? 'border-cream-gold bg-cream-gold'
                          : 'border-cream-15 bg-transparent'
                      } flex items-center justify-center`}
                    >
                      {enabled && <span className="text-[8px] text-bg">&#10003;</span>}
                    </div>
                    <span className="flex-1 text-xs">{meta.label}</span>
                    <div className="flex gap-1">
                      {meta.mevProtected && (
                        <span className="rounded bg-emerald-500/15 px-1 text-[9px] text-emerald-400">MEV</span>
                      )}
                      {meta.isDirect && (
                        <span className="rounded bg-blue-500/15 px-1 text-[9px] text-blue-400">Direct</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="mt-2 border-t border-cream-08 pt-2 px-1">
              <p className="text-[9px] text-cream-35">
                Disabling sources reduces competition. Keep all enabled for best prices.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
