'use client'

import { useState } from 'react'
import { useSwapHistory } from '@/hooks/useSwapHistory'
import { explorerTxUrl } from '@/lib/chains/tokens'
import { formatDisplay } from '@/lib/format'
import { Surface } from '../primitives'

/**
 * [L-1, owner decision: BUILD in v2] v1's SwapHistory (src/components/SwapHistory.tsx) — same data, the shared
 * `useSwapHistory` zustand store, and the same copy ("Recent swaps (N)", row text, "Explorer" link to the record's
 * own chain), drawn in the no-box language: a hairline Surface, not v1's rounded `bg-surface-secondary` box.
 */
export function RecentSwaps() {
  const { records } = useSwapHistory()
  const [expanded, setExpanded] = useState(false)

  if (records.length === 0) return null

  return (
    <Surface edge="top" className="mt-4 pt-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex min-h-[44px] w-full items-center justify-between font-v2-mono text-[12px] font-medium uppercase tracking-[1.5px] text-v2-muted hover:text-v2-text"
      >
        <span>Recent swaps ({records.length})</span>
        <span aria-hidden="true" className="text-[11px]">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="mt-1">
          {records.slice(0, 10).map((rec, i) => (
            <div key={rec.id} className={`flex items-center justify-between gap-3 py-2 text-[12px] ${i > 0 ? 'ts-v2-rule-t' : ''}`}>
              <span>
                <span className="text-v2-dim">{rec.date}</span>
                <span className="ml-2 text-v2-text">
                  {formatDisplay(rec.amountIn)} {rec.tokenIn} → {formatDisplay(rec.amountOut)} {rec.tokenOut}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className={rec.status === 'confirmed' ? 'text-v2-green' : rec.status === 'failed' ? 'text-v2-red' : 'text-v2-amber'}>
                  {rec.status === 'confirmed' ? '✓' : rec.status === 'failed' ? '✗' : '⏳'}
                </span>
                <a href={explorerTxUrl(rec.txHash, rec.chainId ?? 1)} target="_blank" rel="noopener noreferrer" className="text-v2-muted hover:text-v2-text hover:underline">
                  Explorer
                </a>
              </span>
            </div>
          ))}
        </div>
      )}
    </Surface>
  )
}
