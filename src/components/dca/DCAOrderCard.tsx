'use client'

/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] DCAOrderCard — the compact card used for HISTORY orders (completed /
 * cancelled / expired / failed). Moved verbatim from DCAPanel (defensive about partial order data),
 * with one fix: the tx link is now chain-aware (BaseScan for Base) via explorerTxUrl instead of the
 * hardcoded mainnet Etherscan URL. Active orders use the richer MissionControlCard.
 */

import { formatUnits } from 'viem'
import type { AutonomousOrder } from '@/lib/order-engine'
import { failedOrderReason } from '@/lib/order-engine'
import { explorerTxUrl } from '@/lib/chains/tokens'

export default function DCAOrderCard({
  order,
  onCancel,
  onRemove,
}: {
  order: AutonomousOrder
  onCancel?: () => void
  onRemove?: () => void
}) {
  const progress = order.dcaTotal > 0 ? order.dcaExecuted / order.dcaTotal : 0
  const isActive = order.status === 'active' || order.status === 'executing' || order.status === 'partially_filled'

  const statusColor: Record<string, string> = {
    signing: 'bg-yellow-400',
    active: 'bg-success',
    executing: 'bg-blue-400',
    partially_filled: 'bg-cyan-400',
    filled: 'bg-cream-50',
    cancelled: 'bg-danger',
    expired: 'bg-cream-35',
    error: 'bg-danger',
  }

  const statusLabel: Record<string, string> = {
    signing: 'Signing...',
    active: 'Active',
    executing: 'Executing...',
    partially_filled: `${order.dcaExecuted}/${order.dcaTotal} fills`,
    filled: 'Completed',
    cancelled: 'Cancelled',
    expired: 'Expired',
    error: 'Failed',
  }

  const amountIn = order.order?.amountIn
    ? formatUnits(BigInt(order.order.amountIn.toString()), order.tokenInDecimals)
    : '—'

  // Time remaining
  const timeLeft = order.expiresAt - Date.now()
  const daysLeft = Math.max(0, Math.floor(timeLeft / (1000 * 60 * 60 * 24)))
  const hoursLeft = Math.max(0, Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)))

  return (
    <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-cream">
            {order.tokenInSymbol} → {order.tokenOutSymbol}
          </span>
          <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
            isActive ? 'bg-success/15 text-success' : order.status === 'error' ? 'bg-danger/15 text-danger' : 'bg-cream-08 text-cream-35'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${statusColor[order.status] || 'bg-cream-35'}`} />
            {statusLabel[order.status] || order.status}
          </span>
        </div>
        {isActive && onCancel && (
          <button onClick={onCancel} className="inline-flex min-h-[44px] items-center rounded-lg border border-danger/30 px-3 text-xs text-danger/70 hover:text-danger transition-colors">
            Cancel
          </button>
        )}
        {!isActive && onRemove && (
          <button onClick={onRemove} className="inline-flex min-h-[44px] items-center rounded-lg border border-cream-08 px-3 text-xs text-cream-50 hover:text-cream transition-colors">
            Remove
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="mb-2 h-1.5 rounded-full bg-cream-08 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-gold to-gold-light transition-all duration-500"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <div className="flex justify-between text-[11px] text-cream-35 mb-3">
        <span>{order.dcaExecuted} of {order.dcaTotal} buys</span>
        <span>{Number(amountIn).toFixed(2)} {order.tokenInSymbol} total</span>
      </div>

      {/* Time remaining */}
      {isActive && timeLeft > 0 && (
        <div className="rounded-xl border border-cream-08 bg-surface-primary p-2.5 text-[12px] mb-3">
          <div className="flex justify-between">
            <span className="text-cream-35">Expires in</span>
            <span className="font-semibold text-cream">{daysLeft > 0 ? `${daysLeft}d ${hoursLeft}h` : `${hoursLeft}h`}</span>
          </div>
        </div>
      )}

      {/* Error / failure reason — [CHORE-DCA-UX-FIXES] Bug 3b: a failed order always shows a reason,
          even when the keeper persisted none (order.error === null). */}
      {(order.error || order.status === 'error') && (
        <p className="mb-2 text-[11px] text-red-400">{failedOrderReason(order.error)}</p>
      )}

      {/* Tx hash — chain-aware (BaseScan for Base DCA). */}
      {order.txHash && (
        <a
          href={explorerTxUrl(order.txHash, order.chainId ?? 1)}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-[11px] text-cream-gold hover:underline"
        >
          View on explorer ↗
        </a>
      )}
    </div>
  )
}
