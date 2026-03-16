'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import { useOrderEngine } from '@/hooks/useOrderEngine'
import { OrderType } from '@/lib/order-engine'
import type { AutonomousOrder, AutonomousOrderStatus } from '@/lib/order-engine'
import ExecutionTimeline from './ExecutionTimeline'
import { playTouchMP3 } from '@/lib/sounds'

// ── Status config ──────────────────────────────────────
const STATUS_CONFIG: Record<AutonomousOrderStatus, { label: string; color: string; dot: string }> = {
  signing:          { label: 'Signing',          color: 'text-amber-300',  dot: 'bg-amber-400'  },
  active:           { label: 'Active',           color: 'text-emerald-300', dot: 'bg-emerald-400' },
  executing:        { label: 'Executing',        color: 'text-blue-300',   dot: 'bg-blue-400'   },
  partially_filled: { label: 'Partially Filled', color: 'text-blue-300',   dot: 'bg-blue-400'   },
  filled:           { label: 'Filled',           color: 'text-emerald-300', dot: 'bg-emerald-400' },
  cancelled:        { label: 'Cancelled',        color: 'text-cream-40',   dot: 'bg-cream-40'   },
  expired:          { label: 'Expired',          color: 'text-cream-40',   dot: 'bg-cream-40'   },
  error:            { label: 'Failed',           color: 'text-red-400',    dot: 'bg-red-400'    },
}

const TYPE_LABELS: Record<number, { label: string; icon: string }> = {
  [OrderType.LIMIT]:     { label: 'Limit',          icon: '⇅' },
  [OrderType.STOP_LOSS]: { label: 'Stop Loss / TP', icon: '⛨' },
  [OrderType.DCA]:       { label: 'DCA',            icon: '⟳' },
}

type FilterType = 'all' | 'active' | 'history'

// ── Main component ─────────────────────────────────────
export default function OrderDashboard() {
  const { address } = useAccount()
  const {
    orders, activeOrders, historyOrders,
    cancelOrder, cancelAllOrders, removeOrder,
    isLoading,
  } = useOrderEngine()

  const [filter, setFilter] = useState<FilterType>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const filteredOrders = filter === 'active' ? activeOrders
    : filter === 'history' ? historyOrders
    : orders

  if (!address) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-cream-08 bg-surface-secondary/60 px-6 py-12 text-center backdrop-blur-md">
        <span className="text-4xl">🔗</span>
        <p className="text-sm text-cream-50">Connect your wallet to view orders</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-cream-08 bg-surface-secondary/60 px-6 py-12 backdrop-blur-md">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-cream-20 border-t-cream" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-cream">
          My Orders
          {orders.length > 0 && (
            <span className="ml-2 rounded-full bg-cream-08 px-2 py-0.5 text-xs font-medium text-cream-50">
              {orders.length}
            </span>
          )}
        </h3>
        {activeOrders.length > 1 && (
          <button
            onClick={() => { playTouchMP3(); cancelAllOrders() }}
            className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
          >
            Cancel All ({activeOrders.length})
          </button>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 rounded-xl border border-cream-08 bg-surface-secondary/40 p-0.5">
        {([
          ['all', `All (${orders.length})`],
          ['active', `Active (${activeOrders.length})`],
          ['history', `History (${historyOrders.length})`],
        ] as [FilterType, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => { playTouchMP3(); setFilter(key) }}
            className={`flex-1 rounded-lg py-1.5 text-[11px] font-semibold transition-all ${
              filter === key
                ? 'bg-cream-gold text-[#080B10]'
                : 'text-cream-50 hover:text-cream'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Order list */}
      {filteredOrders.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-cream-08 bg-surface-secondary/60 px-6 py-10 text-center backdrop-blur-md">
          <span className="text-3xl opacity-30">📋</span>
          <p className="text-xs text-cream-40">
            {filter === 'active' ? 'No active orders' : filter === 'history' ? 'No order history' : 'No orders yet'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filteredOrders.map(order => (
            <OrderCard
              key={order.id}
              order={order}
              expanded={expandedId === order.id}
              onToggle={() => setExpandedId(prev => prev === order.id ? null : order.id)}
              onCancel={() => cancelOrder(order.id)}
              onRemove={() => removeOrder(order.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Order Card ─────────────────────────────────────────
function OrderCard({
  order, expanded, onToggle, onCancel, onRemove,
}: {
  order: AutonomousOrder
  expanded: boolean
  onToggle: () => void
  onCancel: () => void
  onRemove: () => void
}) {
  const statusCfg = STATUS_CONFIG[order.status] || STATUS_CONFIG.error
  const typeCfg = TYPE_LABELS[order.orderType] || TYPE_LABELS[OrderType.LIMIT]
  const isActive = ['signing', 'active', 'executing', 'partially_filled'].includes(order.status)
  const isDCA = order.orderType === OrderType.DCA
  const dcaProgress = isDCA && order.dcaTotal > 0
    ? Math.min((order.dcaExecuted ?? 0) / order.dcaTotal, 1)
    : 0

  // Format amounts
  const amountIn = (() => {
    try {
      const raw = BigInt(order.order.amountIn.toString())
      return formatUnits(raw, order.tokenInDecimals || 18)
    } catch { return '?' }
  })()

  // Time remaining
  const timeLeft = (() => {
    if (!isActive || !order.expiresAt) return null
    const diff = order.expiresAt - Date.now()
    if (diff <= 0) return 'Expired'
    const hrs = Math.floor(diff / 3600000)
    const mins = Math.floor((diff % 3600000) / 60000)
    if (hrs > 24) return `${Math.floor(hrs / 24)}d ${hrs % 24}h`
    if (hrs > 0) return `${hrs}h ${mins}m`
    return `${mins}m`
  })()

  return (
    <div className="overflow-hidden rounded-2xl border border-cream-08 bg-surface-secondary/60 backdrop-blur-md transition-all">
      {/* Clickable header */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-cream-04"
      >
        {/* Type icon */}
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cream-08 text-lg">
          {typeCfg.icon}
        </span>

        {/* Main info */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-cream">
              {amountIn} {order.tokenInSymbol || '?'}
            </span>
            <span className="text-cream-30">→</span>
            <span className="text-sm font-semibold text-cream">
              {order.tokenOutSymbol || '?'}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="rounded bg-cream-08 px-1.5 py-0.5 font-medium text-cream-50">
              {typeCfg.label}
            </span>
            {isDCA && order.dcaTotal > 0 && (
              <span className="text-cream-40">
                {order.dcaExecuted ?? 0}/{order.dcaTotal} fills
              </span>
            )}
            {timeLeft && (
              <span className="text-cream-30">⏱ {timeLeft}</span>
            )}
          </div>
        </div>

        {/* Status badge */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className={`h-1.5 w-1.5 rounded-full ${statusCfg.dot} ${isActive ? 'animate-pulse' : ''}`} />
          <span className={`text-[11px] font-semibold ${statusCfg.color}`}>
            {statusCfg.label}
          </span>
          <svg
            className={`h-3.5 w-3.5 text-cream-30 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* DCA progress bar */}
      {isDCA && order.dcaTotal > 0 && (
        <div className="mx-4 mb-1 h-1 overflow-hidden rounded-full bg-cream-08">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cream-gold to-amber-400 transition-all duration-500"
            style={{ width: `${dcaProgress * 100}%` }}
          />
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-cream-08 px-4 py-3">
          {/* Order details grid */}
          <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
            <div>
              <span className="text-cream-40">Created</span>
              <p className="font-medium text-cream-70">
                {new Date(order.createdAt).toLocaleDateString()} {new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            {order.executedAt && (
              <div>
                <span className="text-cream-40">Executed</span>
                <p className="font-medium text-cream-70">
                  {new Date(order.executedAt).toLocaleDateString()} {new Date(order.executedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            )}
            {order.expiresAt && (
              <div>
                <span className="text-cream-40">Expires</span>
                <p className="font-medium text-cream-70">
                  {new Date(order.expiresAt).toLocaleDateString()} {new Date(order.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            )}
            {order.amountOut && (
              <div>
                <span className="text-cream-40">Received</span>
                <p className="font-medium text-emerald-300">
                  {formatUnits(BigInt(order.amountOut), order.tokenOutDecimals || 18)} {order.tokenOutSymbol}
                </p>
              </div>
            )}
          </div>

          {/* Error message */}
          {order.error && (
            <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
              {order.error}
            </div>
          )}

          {/* Tx hash */}
          {order.txHash && (
            <a
              href={`https://etherscan.io/tx/${order.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-3 flex items-center gap-1 text-[11px] text-cream-40 hover:text-cream transition-colors"
            >
              <span>📎</span>
              <span className="font-mono">{order.txHash.slice(0, 10)}...{order.txHash.slice(-8)}</span>
              <span>↗</span>
            </a>
          )}

          {/* DCA Execution Timeline */}
          {isDCA && order.dcaTotal > 0 && (order.dcaExecuted ?? 0) > 0 && (
            <ExecutionTimeline orderId={order.id} wallet={order.order.owner} />
          )}

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            {isActive && (
              <button
                onClick={(e) => { e.stopPropagation(); playTouchMP3(); onCancel() }}
                className="flex-1 rounded-xl border border-red-500/20 bg-red-500/10 py-2 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/20"
              >
                Cancel Order
              </button>
            )}
            {!isActive && (
              <button
                onClick={(e) => { e.stopPropagation(); playTouchMP3(); onRemove() }}
                className="flex-1 rounded-xl border border-cream-08 py-2 text-xs font-semibold text-cream-40 transition-colors hover:bg-cream-08 hover:text-cream"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
