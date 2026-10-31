'use client'

import { useId, useRef, useState, type ReactNode } from 'react'
import { useAccount, useChainId, useReadContract } from 'wagmi'
import { useOrderEngine } from '@/hooks/useOrderEngine'
import { useOrderExecutions } from '@/hooks/useOrderExecutions'
import { chainlinkAggregatorAbi } from '@/lib/chainlink'
import { getChainName } from '@/lib/chains/registry'
import { explorerTxUrl } from '@/lib/chains/tokens'
import { fmtDate } from '@/lib/format'
import { failedOrderReason } from '@/lib/order-engine/failed-reason'
import { OrderType, type AutonomousOrder } from '@/lib/order-engine'
import { BLOCK_POLL_MS } from '@/lib/rpc-polling'
import { playTouchMP3 } from '@/lib/sounds'
import { Button, Skeleton, Tabs } from '../primitives'
import { DcaCancelSheet } from '../dca/DcaCancelSheet'
import { PositionSummary } from '../dca/PositionSummary'
import { ExecutionHistory, type ExecOrderMeta } from './ExecutionHistory'
import { rowNavKeyDown, useCancelFocusRestore } from './keyboard'
import {
  ZERO_ADDR,
  amountInText,
  dcaProgress,
  emptyText,
  filterTabs,
  hasPriceFeed,
  isActiveOrder,
  livePrice,
  orderLists,
  orderTypeCfg,
  receivedText,
  showsExecutionHistory,
  statusOf,
  targetLabel,
  timeLeftText,
  type OrderFilter,
  type StatusTone,
} from './orders-model'
import '../dca/dca.css'
import './orders.css'

const CAPS = 'font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px]'
const TONE_TEXT: Record<StatusTone, string> = { amber: 'text-v2-amber', green: 'text-v2-green', teal: 'text-v2-teal', muted: 'text-v2-muted', red: 'text-v2-red' }
const TONE_DOT: Record<StatusTone, string> = { amber: 'bg-v2-amber', green: 'bg-v2-green', teal: 'bg-v2-teal', muted: 'bg-v2-muted', red: 'bg-v2-red' }

/**
 * v1 LivePrice: the order's Chainlink feed, `Now $x (+y%)`, amber within 2 % of the target. Read on the ORDER's chain (v1 reads on whatever
 * chain the wallet is on) at the shared informational cadence `BLOCK_POLL_MS` (rpc-polling.ts; v1 polls every 30 s). Nothing when the feed
 * has no answer (v1).
 */
function LivePrice({ order }: { order: AutonomousOrder }) {
  const feed = order.order.priceFeed as string
  const { data } = useReadContract({
    address: feed as `0x${string}`,
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
    chainId: order.chainId ?? 1,
    query: { refetchInterval: BLOCK_POLL_MS, refetchIntervalInBackground: false, enabled: feed !== ZERO_ADDR },
  })
  const answer = data ? (data as readonly [bigint, bigint, bigint, bigint, bigint])[1] : undefined
  const p = livePrice(answer, order.order.targetPrice.toString())
  if (!p) return null
  return (
    <span className={p.close ? 'text-v2-amber' : 'text-v2-muted'} data-testid="live-price">
      Now {p.now}
      {' '}({p.pct})
    </span>
  )
}

function Detail({ label, children, tone }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className={`${CAPS} text-v2-muted`}>{label}</dt>
      <dd className={`mt-1 font-v2-mono text-[13px] tabular-nums ${tone ?? 'text-v2-text'}`}>{children}</dd>
    </div>
  )
}

/**
 * One order as a hairline row (round7 40 / 42 / m07) — v1 OrderCard: the header toggles the details (v1's accordion: one open at a time),
 * v1's type glyph + label, the amount and pair, the order's chain (amber when the wallet is elsewhere), the target, DCA fills, the time
 * left, the live price, v1's status; open: Created / Executed / Expires / Received, v1's failure reason, the tx (ORDER chain), the DCA
 * position summary, the execution history, and v1's Cancel Order / Switch to {chain} / Remove.
 */
export function OrderRow({ order, expanded, onToggle, onCancel, onRemove, connectedChainId }: {
  order: AutonomousOrder
  expanded: boolean
  onToggle: () => void
  onCancel: () => void
  onRemove: () => void
  connectedChainId?: number
}) {
  const panelId = useId()
  const status = statusOf(order)
  const isActive = isActiveOrder(order.status)
  const isDCA = order.orderType === OrderType.DCA
  const orderChainId = order.chainId ?? 1
  const chainMismatch = isActive && (connectedChainId ?? orderChainId) !== orderChainId
  const chainName = getChainName(orderChainId)
  const type = orderTypeCfg(order)
  const target = targetLabel(order)
  const [now] = useState(() => Date.now())
  const timeLeft = timeLeftText(order, now)
  const received = receivedText(order)
  const showHistory = showsExecutionHistory(order)
  // ONE read of the order's fills while open, feeding the DCA summary and the execution history (v1 fetches them twice).
  const ex = useOrderExecutions(order.id, order.order.owner, { enabled: expanded && (isDCA || showHistory) })

  return (
    <article className="ts-orders-row" data-testid="order-row" data-order-id={order.id} data-status={order.status} data-type={type.label}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        data-order-toggle={order.id}
        className="ts-orders-head"
      >
        <span aria-hidden="true" className="ts-orders-glyph">{type.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 text-[16px] font-semibold text-v2-text">
            <span>{amountInText(order)} {order.tokenInSymbol || '?'}</span>
            <span className="text-v2-muted">→</span>
            <span>{order.tokenOutSymbol || '?'}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <span className={`${CAPS} text-v2-muted`} data-testid="order-type">{type.label}</span>
            <span data-testid="order-chain-badge" className={`${CAPS} ${chainMismatch ? 'text-v2-amber' : 'text-v2-muted'}`}>{chainName}</span>
            {target && <span className="text-v2-muted">{target}</span>}
            {isDCA && order.dcaTotal > 0 && <span className="text-v2-muted">{order.dcaExecuted ?? 0}/{order.dcaTotal} fills</span>}
            {timeLeft && <span className="text-v2-dim"><span aria-hidden="true">⏱ </span>{timeLeft}</span>}
            {hasPriceFeed(order) && isActive && <LivePrice order={order} />}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[status.tone]}`} />
          <span className={`text-[13px] font-semibold ${TONE_TEXT[status.tone]}`} data-testid="order-status">{status.label}</span>
          <svg aria-hidden="true" className={`h-3.5 w-3.5 text-v2-muted transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>

      {isDCA && order.dcaTotal > 0 && (
        <div aria-hidden="true" className="ts-dca-bar mt-1"><span style={{ width: `${dcaProgress(order) * 100}%` }} /></div>
      )}

      {expanded && (
        <div id={panelId} className="ts-orders-detail" data-testid="order-detail">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Detail label="Created">{fmtDate(order.createdAt)}</Detail>
            {order.executedAt && <Detail label="Executed">{fmtDate(order.executedAt)}</Detail>}
            {order.expiresAt && <Detail label="Expires">{fmtDate(order.expiresAt)}</Detail>}
            {received && <Detail label="Received" tone="text-v2-green">{received}</Detail>}
          </dl>

          {(order.error || order.status === 'error') && (
            <p className="mt-3 border-l-2 border-v2-red pl-3 text-[13px] text-v2-red" data-testid="order-error">{failedOrderReason(order.error)}</p>
          )}

          {order.txHash && (
            <a href={explorerTxUrl(order.txHash, orderChainId)} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-[44px] items-center gap-2 font-v2-mono text-[12px] text-v2-cream underline-offset-2 hover:underline">
              <span aria-hidden="true">📎</span>
              <span>{order.txHash.slice(0, 10)}...{order.txHash.slice(-8)}</span>
              <span>↗</span>
            </a>
          )}

          {isDCA && (
            <PositionSummary
              orderId={order.id}
              wallet={order.order.owner}
              tokenIn={order.order.tokenIn as string}
              tokenOut={order.order.tokenOut as string}
              tokenInSymbol={order.tokenInSymbol}
              tokenOutSymbol={order.tokenOutSymbol}
              tokenInDecimals={order.tokenInDecimals}
              tokenOutDecimals={order.tokenOutDecimals}
              chainId={orderChainId}
              dcaTotal={order.dcaTotal}
              fills={ex.executions}
            />
          )}

          {showHistory && (
            <ExecutionHistory
              executions={ex.executions}
              orderMeta={ex.orderMeta as ExecOrderMeta | null}
              loading={ex.loading}
              chainId={orderChainId}
              tokenInSymbol={order.tokenInSymbol}
              tokenOutSymbol={order.tokenOutSymbol}
              tokenInDecimals={order.tokenInDecimals}
              tokenOutDecimals={order.tokenOutDecimals}
              dcaTotal={order.dcaTotal}
              dcaExecuted={order.dcaExecuted}
            />
          )}

          <div className="mt-3 flex justify-end">
            {isActive ? (
              <Button variant="text" tone="danger" data-testid="order-cancel"
                onClick={(e) => { e.stopPropagation(); playTouchMP3(); onCancel() }}
                title={chainMismatch ? `This order is on ${chainName} — switching your wallet is required to cancel it` : undefined}>
                {chainMismatch ? `Switch to ${chainName}` : 'Cancel Order'}
              </Button>
            ) : (
              <Button variant="text" data-testid="order-remove" onClick={(e) => { e.stopPropagation(); playTouchMP3(); onRemove() }}>Remove</Button>
            )}
          </div>
        </div>
      )}
    </article>
  )
}

/**
 * [ADR-025 / B7 C2] The Orders tab (round7 40 / 41 / 42 / 46 / m07) over v1's `useOrderEngine()` — the SAME hook v1's OrderDashboard
 * calls, unchanged: the list, the filters' sources, the read-signature retry, and the cancel path. Cancel / Cancel All only FREEZE a plan
 * (`pendingCancel`); the v2 cancel sheet already wired for DCA (#630/#633, v1's OrderCancelReviewModal) confirms it with `confirmCancel`
 * or drops it with `clearPendingCancel` — nothing is sent from this tab. Every word is v1's.
 */
export function OrdersTab() {
  const { address } = useAccount()
  // v1: the wallet's ACTIVE chain, for the per-order mismatch badge before the Cancel click.
  const connectedChainId = useChainId()
  const engine = useOrderEngine()
  return <OrdersView address={address} connectedChainId={connectedChainId} engine={engine} />
}

/** The slice of v1's `useOrderEngine()` the Orders tab reads — the ONE instance `OrdersTab` holds. */
export type OrdersEngine = Pick<
  ReturnType<typeof useOrderEngine>,
  'orders' | 'activeOrders' | 'cancelOrder' | 'cancelAllOrders' | 'removeOrder' | 'pendingCancel' | 'confirmCancel' | 'clearPendingCancel' | 'isLoading' | 'readAuthDenied' | 'requestOrdersReadAuth'
>

/** The tab's view over the engine slice (no hook of its own besides UI state): what `OrdersTab` renders. */
export function OrdersView({ address, connectedChainId, engine }: { address: string | undefined; connectedChainId: number; engine: OrdersEngine }) {
  const { orders, activeOrders, cancelOrder, cancelAllOrders, removeOrder, pendingCancel, confirmCancel, clearPendingCancel, isLoading, readAuthDenied, requestOrdersReadAuth } = engine
  const [filter, setFilter] = useState<OrderFilter>('active')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const rootRef = useRef<HTMLElement>(null)
  useCancelFocusRestore(pendingCancel ? { orderId: pendingCancel.action === 'cancel' ? pendingCancel.orderId : null } : null, rootRef, '[role="tab"][aria-selected="true"]')

  const lists = orderLists(orders, activeOrders)
  const filtered = lists[filter]

  if (!address) {
    return (
      <section className="ts-orders" aria-label="Orders" data-testid="orders-disconnected">
        <div className="ts-orders-empty">
          <span aria-hidden="true" className="text-[28px]">🔗</span>
          <p className="text-[15px] text-v2-text">Connect your wallet to view orders</p>
        </div>
      </section>
    )
  }

  if (isLoading) {
    return (
      <section className="ts-orders" aria-label="Orders" aria-busy="true" data-testid="orders-loading">
        {[0, 1, 2].map((i) => (
          <div key={i} className="ts-orders-row flex items-center gap-3 py-4">
            <Skeleton width={36} height={36} />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton width={128} height={14} />
              <Skeleton width={80} height={10} />
            </div>
            <Skeleton width={56} height={12} />
          </div>
        ))}
      </section>
    )
  }

  return (
    <section ref={rootRef} className="ts-orders" aria-label="Orders" data-testid="orders" onKeyDown={rowNavKeyDown('[data-order-toggle]')}>
      {/* [W6-M-01] v1: the read-signature prompt was rejected — active orders stay hidden until signed. */}
      {readAuthDenied && (
        <div className="ts-orders-notice" data-testid="orders-read-auth">
          <p className="text-[13px] text-v2-text/90">Your active orders are private — sign a free message (no transaction) to view them.</p>
          <Button variant="text" onClick={() => void requestOrdersReadAuth?.()} data-testid="orders-sign-to-view">Sign to view</Button>
        </div>
      )}
      {/* [CANCEL-REVIEW] No cancel / invalidate executes until the user confirms this frozen plan (v1 OrderDashboard.tsx:107). */}
      {pendingCancel && <DcaCancelSheet review={pendingCancel} onConfirm={() => void confirmCancel()} onCancel={clearPendingCancel} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-3 font-v2-display text-[34px] font-bold uppercase leading-none tracking-[0.5px] text-v2-text">
          My Orders
          {orders.length > 0 && <span className="font-v2-mono text-[13px] font-semibold text-v2-muted" data-testid="orders-count">{orders.length}</span>}
        </h2>
        {activeOrders.length > 1 && (
          <Button variant="text" tone="danger" onClick={() => { playTouchMP3(); cancelAllOrders() }} data-testid="orders-cancel-all">
            Cancel All ({activeOrders.length})
          </Button>
        )}
      </div>

      <div className="ts-orders-filters">
        <Tabs
          label="Orders"
          size="sm"
          active={filter}
          onSelect={(id) => { playTouchMP3(); setFilter(id as OrderFilter) }}
          tabs={filterTabs(lists)}
          className="ts-orders-tabs"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="ts-orders-empty" data-testid="orders-empty">
          <span aria-hidden="true" className="text-[24px] opacity-40">📋</span>
          <p className="text-[14px] text-v2-muted">{emptyText(filter)}</p>
        </div>
      ) : (
        <div data-testid="orders-list">
          {filtered.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              expanded={expandedId === order.id}
              onToggle={() => setExpandedId((prev) => (prev === order.id ? null : order.id))}
              onCancel={() => cancelOrder(order.id)}
              onRemove={() => removeOrder(order.id)}
              connectedChainId={connectedChainId}
            />
          ))}
        </div>
      )}
    </section>
  )
}
