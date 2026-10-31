'use client'

import type { FillRow } from '@/hooks/useOrderExecutions'
import { explorerTxUrl } from '@/lib/chains/tokens'
import { fillAmount, fillRelTime, fillUsdText, isFillSuccess } from './positions-model'

/**
 * [B7] v1 DCAFillsTimeline as hairline rows (round7 35's FILLS strip): newest first, each fill's number, SUCCESS / FAILED, the per-fill
 * USD (v1's `fillUsd`, "—" when unpriced), amount in → amount out, the error, the tx on the ORDER's chain, and how long ago. Fed by the
 * parent's `useOrderExecutions` rows (no fetch here). The dot strip above the rows is decorative (`aria-hidden`): filled / planned.
 */
export function FillsTimeline({
  fills, planned, tokenInSymbol, tokenInDecimals, tokenOutSymbol, tokenOutDecimals, chainId, now,
}: {
  fills: FillRow[]
  /** dcaTotal, for the decorative dot strip only. */
  planned?: number
  tokenInSymbol: string
  tokenInDecimals: number
  tokenOutSymbol: string
  tokenOutDecimals: number
  chainId: number
  /** The card's clock (v1 reads Date.now() per render; the card re-renders each second while live). */
  now: number
}) {
  if (!fills.length) return null
  const ordered = [...fills].sort((a, b) => b.execution_number - a.execution_number)
  const done = fills.filter((f) => isFillSuccess(f.status)).length
  const dots = Math.min(Math.max(planned ?? 0, fills.length), 24)

  return (
    <section className="ts-dca-fills" data-testid="fills-timeline" aria-label="Fills">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="flex items-center gap-3">
          <span className="font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted">Fills</span>
          {dots > 0 && (
            <span aria-hidden="true" className="ts-dca-dots">
              {Array.from({ length: dots }, (_, i) => (
                <span key={i} data-on={i < done ? '' : undefined} />
              ))}
            </span>
          )}
        </span>
        <span className="text-[11px] text-v2-dim">newest first</span>
      </div>
      <ul className="mt-2">
        {ordered.map((f) => {
          const success = isFillSuccess(f.status)
          return (
            <li key={f.id} data-testid="fill-row" className="ts-dca-fill">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-v2-mono text-[13px] font-semibold text-v2-text">#{f.execution_number}</span>
                  <span className={`font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px] ${success ? 'text-v2-green' : 'text-v2-red'}`}>
                    {success ? 'SUCCESS' : 'FAILED'}
                  </span>
                  <span className="font-v2-mono text-[12px] text-v2-muted" data-testid="fill-usd">{fillUsdText(f.amount_in, tokenInDecimals, tokenInSymbol)}</span>
                </div>
                <p className="mt-0.5 font-v2-mono text-[13px] tabular-nums text-v2-text/90">
                  {fillAmount(f.amount_in, tokenInDecimals, tokenInSymbol)} <span className="text-v2-muted">→</span>{' '}
                  <span className="text-v2-text">{fillAmount(f.amount_out, tokenOutDecimals, tokenOutSymbol)}</span>
                </p>
                {f.error && <p className="mt-0.5 line-clamp-1 text-[12px] text-v2-red">{f.error}</p>}
                {f.tx_hash && (
                  <a
                    href={explorerTxUrl(f.tx_hash, chainId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-row-nav=""
                    className="inline-flex min-h-[44px] items-center gap-1 font-v2-mono text-[12px] text-v2-cream underline-offset-2 hover:underline"
                  >
                    <span>{f.tx_hash.slice(0, 8)}…{f.tx_hash.slice(-6)}</span>
                    <span aria-hidden="true">↗</span>
                  </a>
                )}
              </div>
              <span className="shrink-0 font-v2-mono text-[11px] text-v2-muted">{fillRelTime(f.created_at, now)}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
