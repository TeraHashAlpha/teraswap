'use client'

/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] OrbitStatRow — the four quiet facts orbiting the countdown: per-buy
 * + total (REAL decimals, the keeper splits amountIn over dcaTotal), the route, and the expiry. No USD
 * here (per-fill USD lives in the timeline where it's grounded in real fills).
 */

import { formatUnits } from 'viem'
import type { AutonomousOrder } from '@/lib/order-engine'
import RouteBadge from './RouteBadge'

const AMOUNT_FMT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })

function fmtAmount(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals))
  return Number.isFinite(n) ? AMOUNT_FMT.format(n) : '—'
}

function fmtExpiry(expiresAtMs: number): string {
  const ms = expiresAtMs - Date.now()
  if (ms <= 0) return 'Expired'
  const totalH = Math.floor(ms / 3_600_000)
  const d = Math.floor(totalH / 24)
  const h = totalH % 24
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h`
  return `${Math.max(1, Math.floor(ms / 60_000))}m`
}

function StatBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-cream-08 bg-cream-04 px-2.5 py-1.5">
      <span className="text-[9px] font-medium uppercase tracking-wide text-cream-35">{label}</span>
      <span className="truncate text-[12px] font-semibold text-cream">{children}</span>
    </div>
  )
}

export default function OrbitStatRow({ order }: { order: AutonomousOrder }) {
  const decimals = order.tokenInDecimals
  const totalRaw = BigInt(order.order.amountIn.toString())
  const parts = order.dcaTotal > 0 ? order.dcaTotal : 1
  const perBuyRaw = totalRaw / BigInt(parts)

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <StatBox label="Per buy">{fmtAmount(perBuyRaw, decimals)} {order.tokenInSymbol}</StatBox>
      <StatBox label="Total">{fmtAmount(totalRaw, decimals)} {order.tokenInSymbol}</StatBox>
      <StatBox label="Route"><RouteBadge router={order.order.router as string} /></StatBox>
      <StatBox label="Expires">{fmtExpiry(order.expiresAt)}</StatBox>
    </div>
  )
}
