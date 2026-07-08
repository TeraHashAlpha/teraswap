'use client'

/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] MissionControlCard — the captivating per-order card. The live
 * next-buy countdown sits at the centre of the fills progress ring (the signature element); the route,
 * amounts, expiry, and the fills timeline stay quiet around it.
 *
 * One shared useOrderExecutions fetch feeds BOTH the ring (lastFillAtMs) and the timeline. The 1s tick
 * lives in CountdownCenter (recomputed from the target → no drift, no API hammering). State (status /
 * dcaExecuted) stays reactive via useOrderEngine. Cancel/Remove gating mirrors the existing card.
 */

import { useEffect, useState } from 'react'
import type { AutonomousOrder, OrderEngineEvent } from '@/lib/order-engine'
import { nextBuyAtMs, isDue, failedOrderReason } from '@/lib/order-engine'
import { useOrderExecutions } from '@/hooks/useOrderExecutions'
import NextBuyRing from './NextBuyRing'
import CountdownCenter from './CountdownCenter'
import OrbitStatRow from './OrbitStatRow'
import TokenPairLogos from './TokenPairLogos'
import DCAFillsTimeline from './DCAFillsTimeline'
import DCAPositionStats from './DCAPositionStats'

const PULSE_THRESHOLD_MS = 60_000

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-success/15 text-success' },
  executing: { label: 'Executing', cls: 'bg-blue-400/15 text-blue-300' },
  partially_filled: { label: 'Active', cls: 'bg-success/15 text-success' },
  signing: { label: 'Preparing', cls: 'bg-amber-400/15 text-amber-300' },
  filled: { label: 'Completed', cls: 'bg-cream-08 text-cream-50' },
  error: { label: 'Failed', cls: 'bg-danger/15 text-danger' },
  cancelled: { label: 'Cancelled', cls: 'bg-cream-08 text-cream-35' },
  expired: { label: 'Expired', cls: 'bg-cream-08 text-cream-35' },
}

export default function MissionControlCard({
  order, latestEvent, onCancel, onRemove,
}: {
  order: AutonomousOrder
  latestEvent?: OrderEngineEvent | null
  onCancel?: () => void
  onRemove?: () => void
}) {
  const status = order.status
  const isLive = status === 'active' || status === 'executing' || status === 'partially_filled'
  const isCompleted = status === 'filled' || (order.dcaTotal > 0 && order.dcaExecuted >= order.dcaTotal)
  const isFailed = status === 'error' || !!order.error
  const isSigning = status === 'signing'
  const chainId = order.chainId ?? 1

  const { executions, lastFillAtMs } = useOrderExecutions(order.id, order.order.owner, {
    enabled: isLive,
    latestEvent,
  })

  const intervalSec = Number(BigInt(order.order.dcaInterval.toString()))
  const targetMs = isLive
    ? nextBuyAtMs({ lastFillAtMs, scheduleStartMs: order.createdAt, intervalSec })
    : null
  const progress = order.dcaTotal > 0 ? Math.min(1, order.dcaExecuted / order.dcaTotal) : 0

  // 1s-cheap "is the next buy imminent?" gate for the pulse + green recolour (re-derived each second
  // by the same tick that drives CountdownCenter, via a lightweight local clock).
  const [, force] = useState(0)
  useEffect(() => {
    if (!isLive || targetMs == null) return
    const id = setInterval(() => {
      force(n => n + 1)
      // Once due, the accent is locked to "imminent/success" — stop re-deriving it every second.
      if (Date.now() >= targetMs) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [isLive, targetMs])
  const remaining = targetMs == null ? Infinity : targetMs - Date.now()
  const imminent = isLive && (isDue(remaining) || remaining < PULSE_THRESHOLD_MS)
  const accent = isCompleted || imminent ? 'success' : 'gold'

  const terminalLabel = isCompleted ? 'Completed'
    : status === 'cancelled' ? 'Cancelled'
    : status === 'expired' ? 'Expired'
    : isSigning ? 'Preparing…'
    : undefined

  const pill = isCompleted ? STATUS_PILL.filled : (STATUS_PILL[status] ?? STATUS_PILL.active)

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-cream-08 bg-surface-secondary/70 p-4 backdrop-blur-md transition-all duration-300 hover:border-cream-gold/30 motion-safe:hover:-translate-y-0.5">
      {/* soft gold/green glow behind the ring (recolours when imminent) */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 top-24 h-48 w-48 -translate-x-1/2 rounded-full blur-[90px] transition-colors duration-500 ${
          accent === 'success' ? 'bg-success/20' : 'bg-cream-gold/10'
        }`}
      />

      {/* Header */}
      <div className="relative mb-3 flex items-center justify-between gap-2">
        <TokenPairLogos
          tokenInAddress={order.order.tokenIn as string}
          tokenInSymbol={order.tokenInSymbol}
          tokenOutAddress={order.order.tokenOut as string}
          tokenOutSymbol={order.tokenOutSymbol}
          chainId={chainId}
        />
        <div className="flex items-center gap-2">
          <span data-testid="status-pill" className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${pill.cls}`}>
            {pill.label}
          </span>
          {isLive && onCancel && (
            <button
              onClick={onCancel}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-danger/30 px-3 text-xs text-danger/70 transition-colors hover:text-danger"
            >
              Cancel
            </button>
          )}
          {!isLive && !isSigning && onRemove && (
            <button
              onClick={onRemove}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-cream-08 px-3 text-xs text-cream-50 transition-colors hover:text-cream"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Centerpiece: ring + countdown (or failure banner) */}
      <div className="relative flex justify-center py-2">
        {isFailed ? (
          <div
            data-testid="failed-banner"
            className="max-w-[280px] rounded-xl border border-danger/30 bg-danger/10 px-3 py-3 text-center text-[12px] text-danger"
          >
            {failedOrderReason(order.error)}
          </div>
        ) : (
          <NextBuyRing progress={isCompleted ? 1 : progress} accent={accent} size={200}>
            <CountdownCenter targetMs={targetMs} terminalLabel={terminalLabel} />
            <span className="mt-1 text-xs text-cream-50">{order.dcaExecuted} of {order.dcaTotal} buys</span>
          </NextBuyRing>
        )}
      </div>

      {/* Quiet facts */}
      <div className="relative mt-2">
        <OrbitStatRow order={order} />
      </div>

      {/* [CHORE-DCA-VISIBILITY-AND-STATS #3] Per-position stats + P&L vs spot,
          reusing the fills already fetched above (no extra request). */}
      <div className="relative mt-2">
        <DCAPositionStats
          orderId={order.id}
          wallet={order.order.owner}
          tokenIn={order.order.tokenIn as string}
          tokenOut={order.order.tokenOut as string}
          tokenInSymbol={order.tokenInSymbol}
          tokenOutSymbol={order.tokenOutSymbol}
          tokenInDecimals={order.tokenInDecimals}
          tokenOutDecimals={order.tokenOutDecimals}
          chainId={chainId}
          dcaTotal={order.dcaTotal}
          fills={executions}
        />
      </div>

      {/* Fills */}
      <div className="relative">
        <DCAFillsTimeline
          fills={executions}
          tokenInSymbol={order.tokenInSymbol}
          tokenInDecimals={order.tokenInDecimals}
          tokenOutSymbol={order.tokenOutSymbol}
          tokenOutDecimals={order.tokenOutDecimals}
          chainId={chainId}
        />
      </div>
    </div>
  )
}
