/**
 * [ADR-025 / B7 C2] The Orders tab's pure decisions. v1 keeps them inline in OrderDashboard.tsx (STATUS_CONFIG, the filters, OrderCard's
 * type / target / time-left / live-price expressions, ExecutionTimeline's formatters) — module-private, so this module restates the SAME
 * expressions over v1's lib functions. Amounts go through format.ts's bigint path with the order's decimals (owner rule); every label is
 * v1's. The C2 tests render v1's OrderDashboard and the v2 tab against one engine and compare. Display only.
 */
import { formatUnits } from 'viem'
import { OrderType, PriceCondition, type AutonomousOrder, type AutonomousOrderStatus } from '@/lib/order-engine'
import { fmtFixed, fmtGas, fmtPct, fmtToken, fmtUsd } from '@/lib/format'

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

export type StatusTone = 'amber' | 'green' | 'teal' | 'muted' | 'red'

/** v1 OrderDashboard `STATUS_CONFIG` labels, verbatim; v1's colours mapped onto the v2 palette (blue → teal). */
export const ORDER_STATUS: Record<AutonomousOrderStatus, { label: string; tone: StatusTone }> = {
  signing: { label: 'Signing', tone: 'amber' },
  active: { label: 'Active', tone: 'green' },
  executing: { label: 'Executing', tone: 'teal' },
  partially_filled: { label: 'Partially Filled', tone: 'teal' },
  filled: { label: 'Filled', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  expired: { label: 'Expired', tone: 'muted' },
  error: { label: 'Failed', tone: 'red' },
}

export function statusOf(o: AutonomousOrder) {
  return ORDER_STATUS[o.status] || ORDER_STATUS.error
}

export type OrderFilter = 'active' | 'completed' | 'cancelled'

/** v1 OrderCard `isActive`. */
export function isActiveOrder(status: AutonomousOrderStatus): boolean {
  return ['signing', 'active', 'executing', 'partially_filled'].includes(status)
}

/** v1 OrderDashboard's derived lists: Active = the engine's `activeOrders`; Completed = filled; Cancelled = cancelled / expired / error. */
export function orderLists(orders: AutonomousOrder[], activeOrders: AutonomousOrder[]) {
  const completed = orders.filter((o) => o.status === 'filled')
  const cancelled = orders.filter((o) => ['cancelled', 'expired', 'error'].includes(o.status))
  return { active: activeOrders, completed, cancelled }
}

/** v1's filter tab labels, with v1's counts. */
export function filterTabs(lists: ReturnType<typeof orderLists>): Array<{ id: OrderFilter; label: string }> {
  return [
    { id: 'active', label: `Active (${lists.active.length})` },
    { id: 'completed', label: `Completed (${lists.completed.length})` },
    { id: 'cancelled', label: `Cancelled (${lists.cancelled.length})` },
  ]
}

/** v1's empty-list words, per filter. */
export function emptyText(filter: OrderFilter): string {
  return filter === 'active' ? 'No active orders' : filter === 'completed' ? 'No completed orders' : 'No cancelled orders'
}

/** v1 OrderCard `typeCfg` — Limit / DCA / Take Profit (STOP_LOSS + ABOVE) / Stop Loss, with v1's glyph. */
export function orderTypeCfg(o: AutonomousOrder): { label: string; icon: string } {
  if (o.orderType === OrderType.LIMIT) return { label: 'Limit', icon: '⇅' }
  if (o.orderType === OrderType.DCA) return { label: 'DCA', icon: '⟳' }
  if (o.order.condition === PriceCondition.ABOVE) return { label: 'Take Profit', icon: '🎯' }
  return { label: 'Stop Loss', icon: '🛡️' }
}

/** v1 `hasPrice`: a non-DCA order with a Chainlink feed. */
export function hasPriceFeed(o: AutonomousOrder): boolean {
  return o.orderType !== OrderType.DCA && o.order.priceFeed !== ZERO_ADDR
}

/** v1 `targetLabel`: `@ $x` (Limit), `SL ≤ $x`, `TP ≥ $x` — the 8-decimal target through `fmtFixed(…, 2)`. */
export function targetLabel(o: AutonomousOrder): string | null {
  if (!hasPriceFeed(o)) return null
  let str: string
  try {
    str = fmtFixed(Number(formatUnits(BigInt(o.order.targetPrice.toString()), 8)), 2)
  } catch {
    return null
  }
  if (o.orderType === OrderType.LIMIT) return `@ $${str}`
  if (o.order.condition === PriceCondition.BELOW) return `SL ≤ $${str}`
  return `TP ≥ $${str}`
}

/** v1 `amountIn` (raw `formatUnits`), here format.ts's bigint render with the order's decimals; v1's '?' when it cannot be read. */
export function amountInText(o: AutonomousOrder): string {
  try {
    return fmtToken(BigInt(o.order.amountIn.toString()), o.tokenInDecimals || 18)
  } catch {
    return '?'
  }
}

/** v1 `formatUnits(amountIn, decimals)` — what v1 prints, for the parity tests' format remap only. */
export function v1AmountInText(o: AutonomousOrder): string {
  try {
    return formatUnits(BigInt(o.order.amountIn.toString()), o.tokenInDecimals || 18)
  } catch {
    return '?'
  }
}

/** v1 "Received": `order.amountOut` in the out token's decimals (format.ts here). */
export function receivedText(o: AutonomousOrder): string | null {
  if (!o.amountOut) return null
  return `${fmtToken(BigInt(o.amountOut), o.tokenOutDecimals || 18)} ${o.tokenOutSymbol}`
}

/** v1 `timeLeft`: only while active, `Expired` at/after expiry, else `Nd Nh` (over a day), `Nh Nm`, `Nm`. */
export function timeLeftText(o: AutonomousOrder, now: number): string | null {
  if (!isActiveOrder(o.status) || !o.expiresAt) return null
  const diff = o.expiresAt - now
  if (diff <= 0) return 'Expired'
  const hrs = Math.floor(diff / 3600000)
  const mins = Math.floor((diff % 3600000) / 60000)
  if (hrs > 24) return `${Math.floor(hrs / 24)}d ${hrs % 24}h`
  if (hrs > 0) return `${hrs}h ${mins}m`
  return `${mins}m`
}

/** v1 `dcaProgress`. */
export function dcaProgress(o: AutonomousOrder): number {
  return o.orderType === OrderType.DCA && o.dcaTotal > 0 ? Math.min((o.dcaExecuted ?? 0) / o.dcaTotal, 1) : 0
}

/** v1 LivePrice: the feed's answer vs the target (both 8-dec), `Now $x (+y%)`, amber within 2 %. Null where v1 renders nothing. */
export function livePrice(answer: bigint | undefined, targetPrice: string, decimals = 8): { now: string; pct: string; close: boolean } | null {
  if (!answer || answer <= 0n) return null
  const currentPrice = Number(formatUnits(answer, decimals))
  const target = Number(formatUnits(BigInt(targetPrice), decimals))
  if (target === 0) return null
  const pctDiff = ((currentPrice - target) / target) * 100
  return { now: fmtUsd(currentPrice), pct: fmtPct(pctDiff, 1, { sign: true }), close: Math.abs(pctDiff) < 2 }
}

/** v1 OrderCard: the Execution History block shows once something executed (or a tx exists). */
export function showsExecutionHistory(o: AutonomousOrder): boolean {
  return o.status === 'filled' || o.status === 'partially_filled' || (o.dcaExecuted ?? 0) > 0 || !!o.txHash
}

// ── ExecutionTimeline (v1) formatters ──────────────────────────────────────────

/** v1 `formatAmount`: raw wei → `fmtToken` + symbol; null when absent / unparseable. Bigint path, decimals given. */
export function execAmount(raw: string | null | undefined, decimals: number, symbol: string): string | null {
  if (raw == null || raw === '') return null
  try {
    const v = BigInt(raw)
    const num = Number(formatUnits(v, decimals))
    if (!Number.isFinite(num)) return `${formatUnits(v, decimals)} ${symbol}`
    return `${fmtToken(v, decimals)} ${symbol}`
  } catch {
    return null
  }
}

/** v1 `formatPrice`: an 8-decimal Chainlink price as USD; null for 0 / absent. */
export function execPrice(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null
  try {
    const num = Number(formatUnits(BigInt(raw), 8))
    if (!Number.isFinite(num) || num === 0) return null
    return fmtUsd(num)
  } catch {
    return null
  }
}

/** v1 `formatGasEth`. */
export function execGas(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null
  try {
    const num = Number(formatUnits(BigInt(raw), 18))
    if (!Number.isFinite(num) || num === 0) return null
    return `${fmtGas(num)} ETH`
  } catch {
    return null
  }
}

/** v1 `sumWei`. */
export function sumWei(values: Array<string | null | undefined>): bigint {
  let total = 0n
  for (const v of values) {
    if (v == null || v === '') continue
    try {
      total += BigInt(v)
    } catch {
      /* skip non-integer */
    }
  }
  return total
}

/** v1 `avgPrice` (8-dec bigint mean). */
export function avgPrice(prices: Array<string | null | undefined>): string | null {
  const valid: bigint[] = []
  for (const p of prices) {
    if (p == null || p === '') continue
    try {
      valid.push(BigInt(p))
    } catch {
      /* skip */
    }
  }
  if (valid.length === 0) return null
  return (valid.reduce((a, b) => a + b, 0n) / BigInt(valid.length)).toString()
}
