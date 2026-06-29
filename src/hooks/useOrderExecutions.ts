'use client'

/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] useOrderExecutions — ONE fetch per active DCA card, feeding BOTH the
 * countdown ring (lastFillAtMs) and the fills timeline (kills the double-fetch a separate timeline
 * would cause). Refreshes every 30s, PAUSES while the tab is hidden (no background hammering),
 * refetches once visible again, and refetches immediately when a `dca_execution` event lands for this
 * order. The 1s countdown ticks live in CountdownCenter — this hook never ticks per-second.
 *
 * Order state (dcaExecuted/status) stays on useOrderEngine's own poll + realtime; this hook only owns
 * the per-fill detail + the last-fill timestamp.
 */

import { useState, useEffect, useCallback } from 'react'
import type { OrderEngineEvent } from '@/lib/order-engine'

export interface FillRow {
  id: string
  execution_number: number
  tx_hash: string | null
  amount_in: string | null
  amount_out: string | null
  fee_amount?: string | null
  gas_used?: string | null
  price_at_execution?: string | null
  status: string
  error?: string | null
  executed_at?: string | null
  created_at?: string | null
}

export interface OrderExecMeta {
  chain_id?: number | null
  token_in_symbol?: string | null
  token_out_symbol?: string | null
  token_in_decimals?: number | null
  token_out_decimals?: number | null
  dca_total?: number | null
  dca_executed?: number | null
}

const REFRESH_MS = 30_000

export function useOrderExecutions(
  orderId: string,
  wallet: string | undefined,
  opts: { enabled?: boolean; latestEvent?: OrderEngineEvent | null } = {},
) {
  const { enabled = true, latestEvent = null } = opts
  const [executions, setExecutions] = useState<FillRow[]>([])
  const [orderMeta, setOrderMeta] = useState<OrderExecMeta | null>(null)
  const [loading, setLoading] = useState(true)

  // `force` bypasses the tab-hidden guard (used for mount, on-visible, and event-driven refetches —
  // one-shot, not the 30s poll).
  const refetch = useCallback(async (force = false) => {
    if (!enabled || !orderId || !wallet) return
    if (!force && typeof document !== 'undefined' && document.hidden) return
    try {
      const res = await fetch(`/api/orders/${orderId}/executions?wallet=${wallet}`)
      const data = await res.json()
      setExecutions(Array.isArray(data.executions) ? data.executions : [])
      setOrderMeta(data.order ?? null)
    } catch {
      /* keep last good data on a transient error */
    } finally {
      setLoading(false)
    }
  }, [enabled, orderId, wallet])

  // Mount + 30s poll (poll respects tab visibility); refetch when the tab becomes visible again.
  useEffect(() => {
    if (!enabled) return
    void refetch(true)
    const id = setInterval(() => void refetch(false), REFRESH_MS)
    const onVisible = () => { if (!document.hidden) void refetch(true) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refetch])

  // Immediate refresh when THIS order records a fill.
  useEffect(() => {
    if (latestEvent?.type === 'dca_execution' && latestEvent.orderId === orderId) void refetch(true)
  }, [latestEvent, orderId, refetch])

  const lastFillAtMs = executions.length
    ? executions.reduce((max, e) => {
        const t = e.created_at ? Date.parse(e.created_at) : NaN
        return Number.isFinite(t) && t > max ? t : max
      }, -Infinity)
    : null

  return {
    executions,
    orderMeta,
    lastFillAtMs: lastFillAtMs === -Infinity ? null : lastFillAtMs,
    loading,
  }
}
