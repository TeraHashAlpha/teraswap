'use client'

import { useEffect, useState, type ReactNode } from 'react'
import TokenLogo from '@/components/TokenLogo'
import { FLOOR_TIER_BADGE } from '@/components/dca/FloorTierBadge'
import { useOrderExecutions } from '@/hooks/useOrderExecutions'
import { failedOrderReason, type AutonomousOrder, type DcaFloorTier, type OrderEngineEvent } from '@/lib/order-engine'
import { routeLabel } from '@/lib/order-engine/route-source'
import { getChainName } from '@/lib/chains/registry'
import { explorerTxUrl, findChainToken } from '@/lib/chains/tokens'
import { fmtToken } from '@/lib/format'
import { playClick } from '@/lib/sounds'
import { Button } from '../primitives'
import { Mark } from '../modals/parts'
import { FillsTimeline } from './FillsTimeline'
import { NextBuyRing, CountdownText, useReducedMotion } from './NextBuyRing'
import { PositionSummary } from './PositionSummary'
import { ReceiptSheet, isReceiptEligible } from './ReceiptSheet'
import {
  POSITION_STATUS_LABEL,
  countdownView,
  expiresIn,
  historyStatusLabel,
  historyTotal,
  isCompletedOrder,
  isLiveStatus,
  nextBuyTarget,
  orbitAmounts,
  orbitExpiry,
  ringAccent,
  ringProgress,
  terminalLabel,
} from './positions-model'
import './dca.css'

export { isLiveStatus }

export const EMPTY_TITLE = 'No DCA positions yet'
export const EMPTY_BODY = 'Create one to start autonomous dollar cost averaging'
export const EMPTY_CTA = 'Start a DCA'

const CAPS = 'font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px]'

/** A 1 s clock while `enabled`, stopping at the target (v1: CountdownCenter's tick + MissionControlCard's accent tick — one clock here). */
export function useNow(enabled: boolean, targetMs: number | null): number {
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

/** v1 FloorTierBadge (renders nothing for the on-chain feed). */
export function TierMark({ tier }: { tier?: DcaFloorTier | null }) {
  if (!tier || tier === 'onchain-feed') return null
  const b = FLOOR_TIER_BADGE[tier]
  if (!b) return null
  return (
    <span data-testid="floor-tier-badge" data-tier={tier} title={b.title}>
      <Mark tone="amber">{b.label}</Mark>
    </span>
  )
}

/** v1 TokenPairLogos: the order chain's catalog logo for each side, symbol beside it (names, never addresses). */
function TokenPair({ order, chainId }: { order: AutonomousOrder; chainId: number }) {
  const tokenFor = (address: string, symbol: string) => findChainToken(address, chainId) ?? { address: address as `0x${string}`, symbol, logoURI: '', chainId }
  return (
    <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[17px] font-semibold text-v2-text" data-testid="token-pair">
      <TokenLogo token={tokenFor(order.order.tokenIn as string, order.tokenInSymbol)} size={20} className="rounded-full" />
      <span>{order.tokenInSymbol}</span>
      <span aria-hidden="true" className="text-v2-muted"> → </span>
      <TokenLogo token={tokenFor(order.order.tokenOut as string, order.tokenOutSymbol)} size={20} className="rounded-full" />
      <span>{order.tokenOutSymbol}</span>
    </h3>
  )
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0">
      <dt className={`${CAPS} text-v2-muted`}>{label}</dt>
      <dd className="mt-1 font-v2-mono text-[13px] tabular-nums text-v2-text" data-testid={testId}>{children}</dd>
    </div>
  )
}

/**
 * [B7] One ACTIVE position — v1 MissionControlCard in the round-7 language (frame 35): the countdown ring (fills N of M around v1's
 * next-buy countdown; reduced motion → static text), the pair with its logos, v1's tier badge / chain / status pill, v1's four facts
 * (Per buy · Total · Route · Expires), v1's position summary + P&L vs spot, v1's fills timeline, and v1's Cancel (or "Switch to {chain}"
 * when the wallet is elsewhere). ONE `useOrderExecutions` feeds the ring, the summary and the timeline (v1's single-fetch contract).
 */
export function DcaPositionCard({ order, latestEvent, connectedChainId, onCancel, onRemove }: {
  order: AutonomousOrder
  latestEvent?: OrderEngineEvent | null
  connectedChainId?: number
  onCancel?: (id: string) => void
  onRemove?: (id: string) => void
}) {
  const status = order.status
  const isLive = isLiveStatus(status)
  const isCompleted = isCompletedOrder(order)
  const isFailed = status === 'error' || !!order.error
  const isSigning = status === 'signing'
  const chainId = order.chainId ?? 1
  const chainMismatch = isLive && (connectedChainId ?? chainId) !== chainId
  const chainName = getChainName(chainId)
  const reduced = useReducedMotion()

  const { executions, lastFillAtMs } = useOrderExecutions(order.id, order.order.owner, { enabled: isLive, latestEvent })
  const targetMs = nextBuyTarget(order, lastFillAtMs)
  const now = useNow(isLive, targetMs)
  const view = countdownView(targetMs, terminalLabel(order), now)
  const accent = ringAccent(order, targetMs, now)
  const pill = isCompleted ? POSITION_STATUS_LABEL.filled : (POSITION_STATUS_LABEL[status] ?? POSITION_STATUS_LABEL.active)
  const pillTone = isCompleted ? 'cream' : status === 'signing' || status === 'error' ? 'amber' : status === 'executing' ? 'cream' : status === 'cancelled' || status === 'expired' ? 'cream' : 'green'
  const { perBuyRaw, totalRaw } = orbitAmounts(order)

  return (
    <article className="ts-dca-row ts-dca-pos" data-testid="dca-order-row" data-order-id={order.id} data-status={status}>
      <div className="ts-dca-pos-ring">
        {isFailed ? (
          <p data-testid="failed-banner" className="max-w-[280px] border-l-2 border-v2-red pl-3 text-[13px] text-v2-red">{failedOrderReason(order.error)}</p>
        ) : (
          <NextBuyRing progress={ringProgress(order)} accent={accent} reduced={reduced}>
            <span className="contents" data-testid="order-next-buy"><CountdownText view={view} /></span>
            <span className="text-[12px] text-v2-muted" data-testid="order-progress">{order.dcaExecuted} of {order.dcaTotal} buys</span>
          </NextBuyRing>
        )}
      </div>

      <div className="ts-dca-pos-body">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <TokenPair order={order} chainId={chainId} />
          <span className="flex flex-wrap items-center gap-3">
            <TierMark tier={order.floorTier} />
            <span data-testid="order-chain-badge" className={`${CAPS} ${chainMismatch ? 'text-v2-amber' : 'text-v2-muted'}`}>{chainName}</span>
            <span data-testid="status-pill"><Mark tone={pillTone}>{pill}</Mark></span>
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Fact label="Per buy">{fmtToken(perBuyRaw, order.tokenInDecimals)} {order.tokenInSymbol}</Fact>
          <Fact label="Total">{fmtToken(totalRaw, order.tokenInDecimals)} {order.tokenInSymbol}</Fact>
          <Fact label="Route"><span data-testid="route-badge" className="text-v2-cream">{routeLabel(order.order.router as string)}</span></Fact>
          <Fact label="Expires" testId="order-expires">{orbitExpiry(order.expiresAt, now)}</Fact>
        </dl>

        <PositionSummary
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

      <div className="ts-dca-pos-fills">
        <FillsTimeline
          fills={executions}
          planned={order.dcaTotal}
          tokenInSymbol={order.tokenInSymbol}
          tokenInDecimals={order.tokenInDecimals}
          tokenOutSymbol={order.tokenOutSymbol}
          tokenOutDecimals={order.tokenOutDecimals}
          chainId={chainId}
          now={now}
        />
      </div>

      {((isLive && onCancel) || (!isLive && !isSigning && onRemove)) && (
        <div className="ts-dca-pos-actions flex justify-end gap-3">
          {isLive && onCancel && (
            <Button variant="text" tone="danger" onClick={() => { playClick(); onCancel(order.id) }} data-testid="order-cancel"
              title={chainMismatch ? `This order is on ${chainName} — switching your wallet is required to cancel it` : undefined}>
              {chainMismatch ? `Switch to ${chainName}` : 'Cancel'}
            </Button>
          )}
          {!isLive && !isSigning && onRemove && (
            <Button variant="text" onClick={() => { playClick(); onRemove(order.id) }} data-testid="order-remove">Remove</Button>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * [B7] One HISTORY position — v1 DCAOrderCard as a hairline row (frame 35's lower list): the pair, v1's history status label + tier
 * badge, the order's chain, the fill bar, "N of M buys" · "X total", v1's failure reason, the tx on the order's chain, v1's "View
 * receipt" (completed / cancelled only) → the receipt sheet, and Remove.
 */
export function DcaHistoryRow({ order, onCancel, onRemove }: { order: AutonomousOrder; onCancel?: (id: string) => void; onRemove?: (id: string) => void }) {
  const [showReceipt, setShowReceipt] = useState(false)
  const receiptEligible = isReceiptEligible(order.status)
  const progress = order.dcaTotal > 0 ? order.dcaExecuted / order.dcaTotal : 0
  const isActive = isLiveStatus(order.status)
  const chainId = order.chainId ?? 1
  // v1 reads the clock per render; a history row is not live, so v1 never shows its expiry — one read at mount is the same output.
  const [now] = useState(() => Date.now())
  const expires = expiresIn(order, now)
  const tone = isActive ? 'green' : order.status === 'error' ? 'amber' : 'cream'

  return (
    <article className="ts-dca-row" data-testid="dca-order-row" data-order-id={order.id} data-status={order.status}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="flex flex-wrap items-center gap-3">
          <h3 className="text-[15px] font-semibold text-v2-text">{order.tokenInSymbol} → {order.tokenOutSymbol}</h3>
          <span data-testid="status-pill"><Mark tone={tone}>{historyStatusLabel(order)}</Mark></span>
          <TierMark tier={order.floorTier} />
          <span data-testid="order-chain-badge" className={`${CAPS} text-v2-muted`}>{getChainName(chainId)}</span>
        </span>
        <span className="flex gap-3">
          {isActive && onCancel && (
            <Button variant="text" tone="danger" onClick={() => { playClick(); onCancel(order.id) }} data-testid="order-cancel">Cancel</Button>
          )}
          {!isActive && onRemove && (
            <Button variant="text" onClick={() => { playClick(); onRemove(order.id) }} data-testid="order-remove">Remove</Button>
          )}
        </span>
      </div>
      <div aria-hidden="true" className="ts-dca-bar mt-2"><span style={{ width: `${Math.min(1, progress) * 100}%` }} /></div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 text-[13px] text-v2-muted">
        <span data-testid="order-progress">{order.dcaExecuted} of {order.dcaTotal} buys</span>
        <span>{historyTotal(order)} {order.tokenInSymbol} total</span>
      </div>
      {expires && (
        <p className="mt-1 text-[13px] text-v2-muted" data-testid="order-expires">
          Expires in <span className="font-v2-mono text-v2-text">{expires}</span>
        </p>
      )}
      {(order.error || order.status === 'error') && <p className="mt-1 text-[13px] text-v2-red" data-testid="failed-banner">{failedOrderReason(order.error)}</p>}
      {(order.txHash || receiptEligible) && (
        <div className="mt-1 flex flex-wrap gap-x-5">
          {order.txHash && (
            <a href={explorerTxUrl(order.txHash, chainId)} target="_blank" rel="noopener noreferrer" data-row-nav="" className="inline-flex min-h-[44px] items-center text-[13px] text-v2-cream underline underline-offset-2">
              View on explorer ↗
            </a>
          )}
          {receiptEligible && (
            <button type="button" onClick={() => setShowReceipt(true)} data-testid="view-receipt" data-row-nav="" className="inline-flex min-h-[44px] items-center text-[13px] text-v2-cream underline underline-offset-2">
              View receipt
            </button>
          )}
        </div>
      )}
      {showReceipt && <ReceiptSheet order={order} onClose={() => setShowReceipt(false)} />}
    </article>
  )
}

/** The Positions tab: active positions, then History — v1's DCADashboard order, labels, gating and empty state. */
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
      {/* v1 DCADashboard hands MissionControlCard no onRemove: an active position offers Cancel only. */}
      {active.map((o) => (
        <DcaPositionCard key={o.id} order={o} latestEvent={latestEvent} connectedChainId={connectedChainId} onCancel={onCancel} />
      ))}
      {history.length > 0 && (
        <>
          <div className="mt-6 flex items-center justify-between">
            <span className={`${CAPS} text-[11px] text-v2-muted`}>History</span>
            {history.length > 1 && (
              <Button variant="text" onClick={() => { history.forEach((o) => onRemove(o.id)); playClick() }} data-testid="orders-remove-all">Remove All</Button>
            )}
          </div>
          {history.map((o) => (
            <DcaHistoryRow key={o.id} order={o} onRemove={onRemove} />
          ))}
        </>
      )}
    </div>
  )
}
