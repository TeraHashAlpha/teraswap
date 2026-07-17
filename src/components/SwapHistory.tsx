'use client'

import { useState } from 'react'
import { useSwapHistory } from '@/hooks/useSwapHistory'
import { explorerTxUrl } from '@/lib/chains/tokens'
import { formatDisplay } from '@/lib/format'

export default function SwapHistory() {
  const { records } = useSwapHistory()
  const [expanded, setExpanded] = useState(false)

  if (records.length === 0) return null

  return (
    <div className="mt-4 rounded-xl border border-cream-08 bg-surface-secondary/85 backdrop-blur-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-cream-65 hover:text-cream"
      >
        <span>Recent swaps ({records.length})</span>
        <span className="text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-cream-08 px-4 pb-3">
          {records.slice(0, 10).map((rec) => (
            <div
              key={rec.id}
              className="flex items-center justify-between border-b border-cream-08/50 py-2 text-xs last:border-0"
            >
              <div>
                <span className="text-cream-35">{rec.date}</span>
                <span className="mx-2 text-cream">
                  {formatDisplay(rec.amountIn)} {rec.tokenIn} → {formatDisplay(rec.amountOut)} {rec.tokenOut}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className={rec.status === 'confirmed' ? 'text-success' : rec.status === 'failed' ? 'text-danger' : 'text-warning'}>
                  {rec.status === 'confirmed' ? '✓' : rec.status === 'failed' ? '✗' : '⏳'}
                </span>
                <a href={explorerTxUrl(rec.txHash, rec.chainId ?? 1)} target="_blank" rel="noopener noreferrer" className="text-cream-65 hover:text-cream hover:underline">
                  Explorer
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
