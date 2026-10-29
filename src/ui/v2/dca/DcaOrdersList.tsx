'use client'

import { useEffect, useState } from 'react'
import { formatUnits } from 'viem'
import { FLOOR_TIER_BADGE } from '@/components/dca/FloorTierBadge'
import { useOrderExecutions } from '@/hooks/useOrderExecutions'
import { failedOrderReason, nextBuyAtMs, isDue, type AutonomousOrder, type OrderEngineEvent } from '@/lib/order-engine'
import { formatHMS } from '@/lib/order-engine/dca-countdown'
import { getChainName } from '@/lib/chains/registry'
import { explorerTxUrl } from '@/lib/chains/tokens'
import { fmtToken } from '@/lib/format'
import { playClick } from '@/lib/sounds'
import { Button } from '../primitives'
import { Mark } from '../modals/parts'
import './dca.css'

/** v1's status labels (MissionControlCard `STATUS_PILL`, DCAOrderCard `statusLabel` for `partially_filled`/`signing`), verbatim. */
const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  executing: 'Executing',
  partially_filled: 'Active',
  signing: 'Preparing',
  filled: 'Completed',
  error: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}
const STATUS_TONE: Record<string, 'green' | 'amber' | 'cream' | 'muted'> = {
  active: 'green', executing: 'cream', partially_filled: 'green', signing: 'amber', filled: 'muted', error: 'amber', cancelled: 'muted', expired: 'muted',
}

export const EMPTY_TITLE = 'No DCA positions yet'
export const EMPTY_BODY = 'Create one to start autonomous dollar cost averaging'
export const EMPTY_CTA = 'Start a DCA'

export function isLiveStatus(status: string): boolean {
  return status === 'active' || status === 'executing' || status === 'partially_filled'
}

/** A 1 s clock while `enabled` (v1 re-renders its card every second to the target, then stops). */
function useNow(enabled: boolean, targetMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled || targetMs == null) return
    const id = setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= targetMs) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [enabled, targetMs])
  return now
}

/**
 * One position as a hairline row (round7 35): the pair, v1's status label, filled/total, the next buy, expiry, the tier badge, the order's
 * chain, and v1's Cancel / Remove. Display only: Cancel calls the engine's own `cancelOrder` (the v1 hook; its review and signature are
 * v1's), nothing else is sent from here.
 */
export function DcaOrderRow({
  order, latestEvent, connectedChainId, onCancel, onRemove,
}: {
  order: AutonomousOrder
  latestEvent?: OrderEngineEvent | null
  connectedChainId?: number
  onCancel: (id: string) => void
  onRemove: (id: string) => void
}) {
  const status = order.status
  const isLive = isLiveStatus(status)
  const isCompleted = status === 'filled' || (order.dcaTotal > 0 && order.dcaExecuted >= order.dcaTotal)
  const isFailed = status === 'error' || !!order.error
  const isSigning = status === 'signing'
  const chainId = order.chainId ?? 1
  const chainMismatch = isLive && (connectedChainId ?? chainId) !== chainId
  const chainName = getChainName(chainId)

  const { lastFillAtMs } = useOrderExecutions(order.id, order.order.owner, { enabled: isLive, latestEvent })
  const intervalSec = Number(BigInt(order.order.dcaInterval.toString()))
  const targetMs = isLive ? nextBuyAtMs({ lastFillAtMs, scheduleStartMs: order.createdAt, intervalSec }) : null
  const now = useNow(isLive, targetMs)
  const remaining = targetMs == null ? null : targetMs - now

  const label = isCompleted ? STATUS_LABEL.filled : (STATUS_LABEL[status] ?? STATUS_LABEL.active)
  const tone = isCompleted ? 'muted' : (STATUS_TONE[status] ?? 'green')
  const tier = order.floorTier && order.floorTier !== 'onchain-feed' ? FLOOR_TIER_BADGE[order.floorTier] : null
  const amountIn = order.order?.amountIn ? formatUnits(BigInt(order.order.amountIn.toString()), order.tokenInDecimals) : '—'
  const timeLeft = order.expiresAt - now
  const daysLeft = Math.max(0, Math.floor(timeLeft / 86_400_000))
  const hoursLeft = Math.max(0, Math.floor((timeLeft % 86_400_000) / 3_600_000))

  return (
    <article className="ts-dca-row" data-testid="dca-order-row" data-order-id={order.id} data-status={status}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h3 className="text-[15px] font-semibold text-v2-text">
          {order.tokenInSymbol} → {order.tokenOutSymbol}
        </h3>
        <span className="flex flex-wrap items-center gap-3">
          {tier && <span title={tier.title}><Mark tone="amber">{tier.label}</Mark></span>}
          <span data-testid="order-chain-badge" className={`font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px] ${chainMismatch ? 'text-v2-amber' : 'text-v2-muted'}`}>{chainName}</span>
          <span data-testid="status-pill"><Mark tone={tone === 'green' ? 'green' : tone === 'amber' ? 'amber' : 'cream'}>{label}</Mark></span>
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 text-[13px] text-v2-muted">
        <span data-testid="order-progress">{order.dcaExecuted} of {order.dcaTotal} buys</span>
        <span>{fmtToken(amountIn)} {order.tokenInSymbol} total</span>
      </div>

      {isLive && remaining != null && (
        <p className="mt-1 text-[13px] text-v2-muted" data-testid="order-next-buy">
          {isDue(remaining) ? 'Buying now' : 'Next buy in'}{' '}
          <span className="font-v2-mono tabular-nums text-v2-text">{isDue(remaining) ? 'Executing soon…' : formatHMS(remaining)}</span>
        </p>
      )}
      {isLive && timeLeft > 0 && (
        <p className="mt-1 text-[13px] text-v2-muted" data-testid="order-expires">
          Expires in <span className="font-v2-mono text-v2-text">{daysLeft > 0 ? `${daysLeft}d ${hoursLeft}h` : `${hoursLeft}h`}</span>
        </p>
      )}
      {isFailed && <p className="mt-1 text-[13px] text-v2-red" data-testid="failed-banner">{failedOrderReason(order.error)}</p>}
      {order.txHash && (
        <a href={explorerTxUrl(order.txHash, chainId)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-[44px] items-center text-[13px] text-v2-cream underline underline-offset-2">
          View on explorer ↗
        </a>
      )}

      <div className="mt-1 flex justify-end gap-3">
        {isLive && (
          <Button variant="text" tone="danger" onClick={() => { playClick(); onCancel(order.id) }} data-testid="order-cancel"
            title={chainMismatch ? `This order is on ${chainName} — switching your wallet is required to cancel it` : undefined}>
            {chainMismatch ? `Switch to ${chainName}` : 'Cancel'}
          </Button>
        )}
        {!isLive && !isSigning && (
          <Button variant="text" onClick={() => { playClick(); onRemove(order.id) }} data-testid="order-remove">
            Remove
          </Button>
        )}
      </div>
    </article>
  )
}

/** The Positions tab: active rows, then History — v1's DCADashboard order, labels and empty state. */
export function DcaOrdersList({
  active, history, latestEvent, connectedChainId, onCancel, onCancelAll, onRemove, onCreate,
}: {
  active: AutonomousOrder[]
  history: AutonomousOrder[]
  latestEvent?: OrderEngineEvent | null
  connectedChainId?: number
  onCancel: (id: string) => void
  onCancelAll: () => Promise<void> | void
  onRemove: (id: string) => void
  onCreate: () => void
}) {
  if (active.length === 0 && history.length === 0) {
    return (
      <div className="py-8 text-center" data-testid="dca-empty">
        <p className="text-[15px] text-v2-muted">{EMPTY_TITLE}</p>
        <p className="mt-1 text-[13px] text-v2-dim">{EMPTY_BODY}</p>
        <Button variant="primary" className="mt-4" onClick={() => { playClick(); onCreate() }}>
          {EMPTY_CTA}
        </Button>
      </div>
    )
  }
  return (
    <div data-testid="dca-orders">
      {active.length > 1 && (
        <div className="flex justify-end">
          <Button variant="text" tone="danger" onClick={() => { onCancelAll(); playClick() }} data-testid="orders-cancel-all">Cancel All</Button>
        </div>
      )}
      {active.map((o) => (
        <DcaOrderRow key={o.id} order={o} latestEvent={latestEvent} connectedChainId={connectedChainId} onCancel={onCancel} onRemove={onRemove} />
      ))}
      {history.length > 0 && (
        <>
          <div className="mt-4 flex items-center justify-between">
            <span className="font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted">History</span>
            {history.length > 1 && (
              <Button variant="text" onClick={() => { history.forEach((o) => onRemove(o.id)); playClick() }} data-testid="orders-remove-all">Remove All</Button>
            )}
          </div>
          {history.map((o) => (
            <DcaOrderRow key={o.id} order={o} connectedChainId={connectedChainId} onCancel={onCancel} onRemove={onRemove} />
          ))}
        </>
      )}
    </div>
  )
}
