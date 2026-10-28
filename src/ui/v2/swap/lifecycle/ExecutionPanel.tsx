'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { AGGREGATOR_META } from '@/lib/constants'
import { Button } from '../../primitives'
import { Notice } from '../QuotePanel'
import { explorerName, type SuccessSummary, type TimelineStep } from './lifecycle-view'

export interface ExecutionLeg {
  source: string
  percent: number
  status: 'pending' | 'fetching' | 'simulating' | 'reviewed' | 'signing' | 'confirming' | 'success' | 'error'
  error?: string
}

export interface ExecutionPanelProps {
  steps: TimelineStep[]
  phase: 'pending' | 'success' | 'failure'
  symbolIn: string
  symbolOut: string
  amountIn: string
  /** Standard path only; null for CoW / split (v1 builds no summary there). */
  summary: SuccessSummary | null
  txHash?: string
  /** `getChainConfig(chainId).blockExplorer` of the ORDER's chain. */
  explorerUrl: string
  error: string | null
  /** v1's toast title for this outcome: Swap failed / Split swap failed / Split swap partially complete. */
  failureTitle: string
  cowPending: boolean
  legs?: { rows: ExecutionLeg[]; completed: number; total: number }
  /** v1's pre-swap simulation lines + 9O fallback notice, under the same conditions. */
  simulation: { passed: boolean | null; skipped: boolean; swapStatus: string }
  fallback: { from: string; to: string } | null
  /** A sheet (review / consent / Permit2 / …) is on screen: it owns focus. */
  sheetOpen: boolean
  onNewSwap: () => void
}

const LEG_TEXT: Record<ExecutionLeg['status'], string> = {
  pending: 'Waiting',
  fetching: 'Getting route...',
  simulating: 'Simulating...',
  reviewed: 'Reviewed',
  signing: 'Confirm in wallet',
  confirming: 'Confirming...',
  success: '✓ Done',
  error: 'Failed',
}

function Node({ state }: { state: TimelineStep['state'] }) {
  return (
    <span aria-hidden="true" data-node={state} className="ts-exec-node">
      {state === 'done' ? '✓' : state === 'failed' ? '✕' : null}
    </span>
  )
}

/**
 * [ADR-025 / B5] Round 7 28a / 28b / 28c — the Execution column that replaces the quote panel while a swap runs. A vertical
 * timeline of SwapButton's own state labels (sent → confirming → done), then what the outcome needs: the pending tx link to the
 * ORDER chain's explorer, the success amounts (v1's own arrow line; the "you saved" line only for a CoW fill with realised
 * surplus, v1's wording) or v1's error text verbatim. The retry is the CTA's `Error — retry` (SwapButton's), not a second button.
 */
export function ExecutionPanel(p: ExecutionPanelProps) {
  const ref = useRef<HTMLElement>(null)
  // Focus has to land somewhere when the review sheet hands over to the running swap (its opener, the CTA, is now disabled): the
  // progress itself. It never takes focus from a sheet that is still open.
  useEffect(() => {
    if (!p.sheetOpen) ref.current?.focus({ preventScroll: true })
  }, [p.sheetOpen])
  const link = (label: ReactNode) =>
    p.txHash ? (
      <a href={`${p.explorerUrl}/tx/${p.txHash}`} target="_blank" rel="noopener noreferrer" className="text-v2-text underline-offset-2 hover:underline" data-testid="exec-tx-link">
        {label}
      </a>
    ) : null
  return (
    <section ref={ref} tabIndex={-1} data-testid="execution" data-phase={p.phase} aria-label="Execution" className="ts-exec focus:outline-none">
      <h2 className="font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted">Execution</h2>
      <ol className="ts-exec-steps" aria-live="polite">
        {p.steps.map((s) => (
          <li key={s.label} data-step={s.state} aria-current={s.state === 'active' ? 'step' : undefined} className="ts-exec-step">
            <Node state={s.state} />
            <span className={s.state === 'active' || s.state === 'failed' ? 'font-semibold text-v2-text' : s.state === 'todo' ? 'text-v2-dim' : 'text-v2-text/90'}>{s.label}</span>
          </li>
        ))}
      </ol>

      {p.legs && p.legs.rows.length > 0 && (
        <div className="mt-4 ts-v2-rule-t pt-3" data-testid="exec-legs">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-semibold text-v2-muted">Split Execution</span>
            <span className="font-v2-mono text-v2-muted">
              {p.legs.completed}/{p.legs.total} legs
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {p.legs.rows.map((leg, i) => (
              <li key={i} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="text-v2-muted">
                  {AGGREGATOR_META[leg.source as keyof typeof AGGREGATOR_META]?.label || leg.source} <span className="text-v2-dim">{leg.percent}%</span>
                </span>
                <span className={leg.status === 'error' ? 'text-v2-red' : 'text-v2-muted'}>{leg.status === 'error' ? leg.error || LEG_TEXT.error : LEG_TEXT[leg.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 ts-v2-rule-t pt-4 text-[13px]">
        {p.phase === 'pending' && (
          <>
            {p.txHash && <p data-testid="exec-sent">{link(<>Transaction sent — track on {explorerName(p.explorerUrl)} ↗</>)}</p>}
            {p.cowPending && <p className="text-v2-muted">Your order is MEV-protected. Solvers are competing to fill it at the best price.</p>}
          </>
        )}
        {p.phase === 'success' && (
          <div className="space-y-2" data-testid="exec-success">
            {p.summary && (
              <p className="font-v2-mono tabular-nums text-v2-green">
                {p.amountIn} {p.symbolIn} → {p.summary.outDisplay} {p.symbolOut}
              </p>
            )}
            {p.summary?.savingsLine && <p data-testid="exec-saved" className="text-v2-muted">{p.summary.savingsLine}</p>}
            <div className="flex items-center justify-between gap-3">
              {p.txHash ? link(<>View on explorer ↗</>) : <span />}
              <Button variant="text" onClick={p.onNewSwap} data-testid="exec-new-swap">
                New swap
              </Button>
            </div>
          </div>
        )}
        {p.phase === 'failure' && (
          <div data-testid="exec-failure" className="space-y-2">
            <Notice tone="red" testId="exec-error">
              <span className="font-semibold">{p.failureTitle}</span>
              <span className="mt-0.5 block text-v2-muted">{p.error || 'Transaction was rejected or failed.'}</span>
              {p.txHash && <span className="mt-1 block">{link(<>View on explorer ↗</>)}</span>}
            </Notice>
          </div>
        )}
        {p.simulation.passed === true && (p.simulation.swapStatus === 'swapping' || p.simulation.swapStatus === 'success') && (
          <p className="mt-2 text-[12px] text-v2-green">
            <span aria-hidden="true">✓</span> Pre-swap simulation passed — transaction verified safe
          </p>
        )}
        {p.simulation.passed === false && p.simulation.swapStatus === 'error' && (
          <p className="mt-2 text-[12px] text-v2-red">
            <span aria-hidden="true">✗</span> Pre-swap simulation caught a revert — no gas was spent
          </p>
        )}
        {p.simulation.skipped && (
          <p className="mt-2 text-[12px] text-v2-amber">
            <span aria-hidden="true">⚠</span> Simulation unavailable — proceed with caution
          </p>
        )}
        {p.fallback && (
          <p className="mt-2 text-[12px] text-v2-amber">
            <span aria-hidden="true">↻</span> {p.fallback.from} couldn&apos;t execute this route — switched to {p.fallback.to}
          </p>
        )}
      </div>
    </section>
  )
}
