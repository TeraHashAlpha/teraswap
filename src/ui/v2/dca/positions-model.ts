/**
 * [ADR-025 / B7] The DCA Positions tab's pure decisions. v1 keeps them inline in its components (MissionControlCard, CountdownCenter,
 * OrbitStatRow, DCAOrderCard, DCAPositionStats, DCAFillsTimeline) — module-private, so there is nothing to import: this module restates
 * the SAME expressions over v1's own lib functions (`nextBuyAtMs`, `isDue`, `formatHMS`, `fillUsd`, `fmtToken`, …). The B7 tests render
 * v1 and v2 against one set of orders and fills and compare what each prints (content parity) and what each computed (countdown, P&L).
 * Display only — nothing here fetches, signs or sends.
 */
import { formatUnits } from 'viem'
import { isDue, nextBuyAtMs, type AutonomousOrder } from '@/lib/order-engine'
import { formatHMS } from '@/lib/order-engine/dca-countdown'
import { fillUsd } from '@/lib/order-engine/usd'
import { fmtToken, fmtUsd } from '@/lib/format'

/** v1 MissionControlCard `PULSE_THRESHOLD_MS`: under a minute to the next buy the accent turns green. */
export const PULSE_THRESHOLD_MS = 60_000

/** v1's "live" test (MissionControlCard `isLive`, DCAOrderCard `isActive`). */
export function isLiveStatus(status: string): boolean {
  return status === 'active' || status === 'executing' || status === 'partially_filled'
}

/** v1 MissionControlCard `isCompleted`: filled, or every planned buy executed. */
export function isCompletedOrder(o: Pick<AutonomousOrder, 'status' | 'dcaTotal' | 'dcaExecuted'>): boolean {
  return o.status === 'filled' || (o.dcaTotal > 0 && o.dcaExecuted >= o.dcaTotal)
}

/** v1 MissionControlCard `targetMs`: the next buy for a live order (`nextBuyAtMs` from the last fill, else the schedule start), else null. */
export function nextBuyTarget(order: AutonomousOrder, lastFillAtMs: number | null): number | null {
  if (!isLiveStatus(order.status)) return null
  const intervalSec = Number(BigInt(order.order.dcaInterval.toString()))
  return nextBuyAtMs({ lastFillAtMs, scheduleStartMs: order.createdAt, intervalSec })
}

/** v1 MissionControlCard `progress` (the ring): executed / total, capped at 1; a completed order draws a full ring. */
export function ringProgress(order: AutonomousOrder): number {
  if (isCompletedOrder(order)) return 1
  return order.dcaTotal > 0 ? Math.min(1, order.dcaExecuted / order.dcaTotal) : 0
}

/** v1 MissionControlCard `terminalLabel` — what the ring's centre says when there is no countdown. */
export function terminalLabel(order: AutonomousOrder): string | undefined {
  if (isCompletedOrder(order)) return 'Completed'
  if (order.status === 'cancelled') return 'Cancelled'
  if (order.status === 'expired') return 'Expired'
  if (order.status === 'signing') return 'Preparing…'
  return undefined
}

/** v1 MissionControlCard accent: green once the next buy is due or under a minute away, or the position is complete; else gold (v2: cream). */
export function ringAccent(order: AutonomousOrder, targetMs: number | null, now: number): 'success' | 'gold' {
  const remaining = targetMs == null ? Infinity : targetMs - now
  const imminent = isLiveStatus(order.status) && (isDue(remaining) || remaining < PULSE_THRESHOLD_MS)
  return isCompletedOrder(order) || imminent ? 'success' : 'gold'
}

export type CountdownView =
  | { kind: 'terminal'; text: string }
  | { kind: 'live'; label: string; value: string; due: boolean }

/** v1 CountdownCenter, as data: a terminal label (or "—"), else "Next buy in" + HH:MM:SS, or "Buying now" + "Executing soon…" once due. */
export function countdownView(targetMs: number | null, terminal: string | undefined, now: number, label = 'Next buy in'): CountdownView {
  if (targetMs == null) return { kind: 'terminal', text: terminal ?? '—' }
  const remaining = targetMs - now
  const due = isDue(remaining)
  return { kind: 'live', label: due ? 'Buying now' : label, value: due ? 'Executing soon…' : formatHMS(remaining), due }
}

/** v1 OrbitStatRow `fmtExpiry`. */
export function orbitExpiry(expiresAtMs: number, now: number): string {
  const ms = expiresAtMs - now
  if (ms <= 0) return 'Expired'
  const totalH = Math.floor(ms / 3_600_000)
  const d = Math.floor(totalH / 24)
  const h = totalH % 24
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h`
  return `${Math.max(1, Math.floor(ms / 60_000))}m`
}

/** v1 OrbitStatRow: per buy = total / dcaTotal (bigint floor, the keeper's split), both in the spend token's raw units. */
export function orbitAmounts(order: AutonomousOrder): { perBuyRaw: bigint; totalRaw: bigint } {
  const totalRaw = BigInt(order.order.amountIn.toString())
  const parts = order.dcaTotal > 0 ? order.dcaTotal : 1
  return { perBuyRaw: totalRaw / BigInt(parts), totalRaw }
}

/** v1 DCAOrderCard's "Expires in" (`daysLeft`d `hoursLeft`h, or `hoursLeft`h). Null when v1 hides it (not live, or past). */
export function expiresIn(order: AutonomousOrder, now: number): string | null {
  if (!isLiveStatus(order.status)) return null
  const timeLeft = order.expiresAt - now
  if (!(timeLeft > 0)) return null
  const daysLeft = Math.max(0, Math.floor(timeLeft / (1000 * 60 * 60 * 24)))
  const hoursLeft = Math.max(0, Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)))
  return daysLeft > 0 ? `${daysLeft}d ${hoursLeft}h` : `${hoursLeft}h`
}

/** v1 DCAOrderCard `statusLabel` (the HISTORY card's map — not MissionControlCard's). */
export function historyStatusLabel(order: AutonomousOrder): string {
  const map: Record<string, string> = {
    signing: 'Signing...',
    active: 'Active',
    executing: 'Executing...',
    partially_filled: `${order.dcaExecuted}/${order.dcaTotal} fills`,
    filled: 'Completed',
    cancelled: 'Cancelled',
    expired: 'Expired',
    error: 'Failed',
  }
  return map[order.status] || order.status
}

/** v1 MissionControlCard `STATUS_PILL` labels (the ACTIVE card's map). */
export const POSITION_STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  executing: 'Executing',
  partially_filled: 'Active',
  signing: 'Preparing',
  filled: 'Completed',
  error: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

/** v1 DCAOrderCard total: `fmtToken(formatUnits(amountIn, decimals))` — the same number through format.ts's bigint path. */
export function historyTotal(order: AutonomousOrder): string {
  if (!order.order?.amountIn) return '—'
  return fmtToken(BigInt(order.order.amountIn.toString()), order.tokenInDecimals)
}

// ── DCAFillsTimeline (v1) ──────────────────────────────────────────────────────

/** v1 DCAFillsTimeline `fmtAmount`: raw → `fmtToken` + symbol, "—" when absent or unparseable (bigint path, decimals given). */
export function fillAmount(raw: string | null | undefined, decimals: number, symbol: string): string {
  if (raw == null || raw === '') return '—'
  try {
    const v = BigInt(String(raw).split('.')[0])
    const n = Number(formatUnits(v, decimals))
    return Number.isFinite(n) ? `${fmtToken(v, decimals)} ${symbol}` : '—'
  } catch {
    return '—'
  }
}

/** v1 DCAFillsTimeline `fmtUsd`: per-fill USD via `fillUsd`; "—" when the token has no known price, `<$0.01`, else `~$x`. */
export function fillUsdText(raw: string | null | undefined, decimals: number, symbol: string): string {
  const v = fillUsd(raw, decimals, symbol)
  if (v == null) return '—'
  if (v > 0 && v < 0.01) return '<$0.01'
  return `~${fmtUsd(v)}`
}

/** v1 DCAFillsTimeline `relTime`. */
export function fillRelTime(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const m = Math.floor((now - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** v1's fill success test (DCAFillsTimeline / ExecutionTimeline). */
export function isFillSuccess(status: string): boolean {
  return status === 'success' || status === 'executed' || status === 'confirmed'
}

// ── DCAPositionStats (v1) ──────────────────────────────────────────────────────

/** v1 DCAPositionStats `fmtDate` (month + day, the viewer's locale). */
function statDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** v1 DCAPositionStats `dateRange`. */
export function statRange(first: string | null, last: string | null): string | null {
  if (!first || !last) return null
  const a = statDate(first)
  const b = statDate(last)
  return a === b ? a : `${a} – ${b}`
}
