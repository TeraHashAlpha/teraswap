/**
 * [CHORE-DCA-VISIBILITY-AND-STATS #3] Per-position DCA statistics, computed
 * PURELY from the recorded fills.
 *
 * Source of truth: `order_executions.amount_in` / `amount_out` — the ACTUAL
 * per-fill amounts the keeper decoded from the on-chain `OrderExecuted` event
 * (input-token in, output-token out). `price_at_execution` is all-NULL on live
 * data and is deliberately IGNORED here: the realized rate is derived from the
 * amounts, which is higher-fidelity data than a historical oracle read anyway.
 *
 * All math is exact (BigInt sums, decimals-aware human conversion). No oracle is
 * needed for the realized stats; only the P&L-vs-spot layer takes live prices.
 */
import { formatUnits } from 'viem'

/** The subset of an `order_executions` row these stats need. */
export interface StatFill {
  amount_in?: string | null
  amount_out?: string | null
  status?: string | null
  created_at?: string | null
}

export interface PositionStatsInput {
  /** orders.dca_total — the planned number of fills (M). */
  dcaTotal?: number | null
  tokenInDecimals?: number | null
  tokenOutDecimals?: number | null
}

export interface PositionStats {
  fillsExecuted: number // confirmed fills actually summed (N)
  fillsPlanned: number // planned fills (M) — never below fillsExecuted
  pctComplete: number // 0..100
  totalInvestedRaw: string // Σ amount_in, raw input-token units
  totalReceivedRaw: string // Σ amount_out, raw output-token units
  totalInvested: number // Σ amount_in, human (input token)
  totalReceived: number // Σ amount_out, human (output token)
  avgBuyPrice: number | null // cost basis = invested ÷ received (input per output)
  firstFillAt: string | null
  lastFillAt: string | null
}

// order_executions.status ∈ {confirmed, failed, pending}; synonyms accepted for
// legacy/synthetic rows. Only settled fills contribute to invested/received.
const COUNTED = new Set(['confirmed', 'success', 'executed'])

function isCounted(status?: string | null): boolean {
  // A missing status is treated as counted (legacy rows predate the column).
  if (status == null || status === '') return true
  return COUNTED.has(status.toLowerCase())
}

/** Sum decimal-integer raw wei strings, skipping nulls / non-integers. */
function sumRaw(values: Array<string | null | undefined>): bigint {
  let total = 0n
  for (const v of values) {
    if (v == null || v === '') continue
    try {
      total += BigInt(String(v).split('.')[0])
    } catch {
      /* skip non-integer amount (DB stores amounts as free TEXT) */
    }
  }
  return total
}

function toHuman(raw: bigint, decimals: number): number {
  try {
    return Number(formatUnits(raw, decimals))
  } catch {
    return 0
  }
}

function firstLastFill(fills: StatFill[]): { first: string | null; last: string | null } {
  let firstMs: number | null = null
  let lastMs: number | null = null
  let first: string | null = null
  let last: string | null = null
  for (const f of fills) {
    if (!f.created_at) continue
    const t = Date.parse(f.created_at)
    if (!Number.isFinite(t)) continue
    if (firstMs === null || t < firstMs) {
      firstMs = t
      first = f.created_at
    }
    if (lastMs === null || t > lastMs) {
      lastMs = t
      last = f.created_at
    }
  }
  return { first, last }
}

export function computePositionStats(
  fills: StatFill[] | null | undefined,
  input: PositionStatsInput = {},
): PositionStats {
  const counted = (fills ?? []).filter((f) => isCounted(f.status))
  const tokenInDecimals = input.tokenInDecimals ?? 18
  const tokenOutDecimals = input.tokenOutDecimals ?? 18

  const investedRaw = sumRaw(counted.map((f) => f.amount_in))
  const receivedRaw = sumRaw(counted.map((f) => f.amount_out))
  const totalInvested = toHuman(investedRaw, tokenInDecimals)
  const totalReceived = toHuman(receivedRaw, tokenOutDecimals)

  const fillsExecuted = counted.length
  const fillsPlanned = Math.max(input.dcaTotal ?? fillsExecuted, fillsExecuted)
  const pctComplete =
    fillsPlanned > 0 ? Math.min(100, Math.round((fillsExecuted / fillsPlanned) * 100)) : 0

  // Cost basis: how much input each unit of output cost (input per output).
  const avgBuyPrice = totalReceived > 0 ? totalInvested / totalReceived : null

  const { first, last } = firstLastFill(counted)

  return {
    fillsExecuted,
    fillsPlanned,
    pctComplete,
    totalInvestedRaw: investedRaw.toString(),
    totalReceivedRaw: receivedRaw.toString(),
    totalInvested,
    totalReceived,
    avgBuyPrice,
    firstFillAt: first,
    lastFillAt: last,
  }
}

export interface PnlPrices {
  /** USD spot of the INPUT (spent) token. */
  priceIn?: number | null
  /** USD spot of the OUTPUT (accumulated) token. */
  priceOut?: number | null
}

export interface PositionPnl {
  investedUsd: number
  currentValueUsd: number
  pnlUsd: number
  pnlPct: number | null
  direction: 'up' | 'down' | 'flat'
}

/**
 * P&L vs current spot = value the ACCUMULATED output at today's price minus what
 * was actually spent. `direction` drives a calm, non-alarmist cue (not a red
 * alert). Returns null when either token is unpriceable — no fabricated P&L.
 */
export function computePositionPnl(
  stats: PositionStats,
  prices: PnlPrices,
): PositionPnl | null {
  const { priceIn, priceOut } = prices
  if (priceIn == null || priceOut == null || priceIn <= 0 || priceOut <= 0) return null

  const investedUsd = stats.totalInvested * priceIn
  const currentValueUsd = stats.totalReceived * priceOut
  const pnlUsd = currentValueUsd - investedUsd
  const pnlPct = investedUsd > 0 ? (pnlUsd / investedUsd) * 100 : null
  const direction: PositionPnl['direction'] =
    Math.abs(pnlUsd) < 1e-9 ? 'flat' : pnlUsd > 0 ? 'up' : 'down'

  return { investedUsd, currentValueUsd, pnlUsd, pnlPct, direction }
}
