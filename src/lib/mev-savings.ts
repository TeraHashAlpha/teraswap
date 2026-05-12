/**
 * [LP-05] MEV-savings estimation helpers.
 *
 * Pure functions; no React, no IO. Used by:
 *   - QuoteBreakdown (display the pre-swap estimate)
 *   - SwapBox (log the same estimate to analytics on swap success so a
 *     downstream join with mev_savings_actual gives a stored estimate
 *     vs reality delta)
 *
 * The estimate is a deliberately conservative one: we compare CoW
 * Protocol's quoted output against the median of the non-CoW quotes
 * for the same pair/amount. The intuition is that the public-mempool
 * venues form a baseline of what a non-protected route would deliver;
 * the median (rather than min/max) damps source-specific outliers.
 * Surplus over that baseline is a rough lower-bound estimate of the
 * MEV that would have been extracted on a non-protected execution.
 */

import type { MetaQuoteResult } from '@/lib/api'
import { safeBigInt } from '@/lib/utils'

export interface MevSavingsEstimate {
  /** Output-token surplus over the non-CoW median, raw wei. */
  amountWei: bigint
  /** Surplus as a percentage of the non-CoW median (e.g. 0.85 = 0.85%). */
  pct: number
}

/**
 * Compute pre-swap MEV-savings estimate for the winning quote.
 *
 * Returns null when:
 *   - The winning quote is not from CoW (only CoW is meaningfully MEV-protected).
 *   - There are fewer than two non-CoW quotes (median is unstable).
 *   - CoW's output is at or below the non-CoW median (no positive surplus).
 *
 * Caller is expected to format the amount with the output token's
 * decimals; this helper stays in raw wei to avoid float rounding.
 */
export function estimateMevSavings(meta: MetaQuoteResult): MevSavingsEstimate | null {
  if (meta.best.source !== 'cowswap' || meta.all.length <= 1) return null

  // [10-L-01] Filter out malformed toAmount values via safeBigInt so a
  // single bad quote from one source doesn't poison the whole median.
  const nonCow: bigint[] = []
  for (const q of meta.all) {
    if (q.source === 'cowswap') continue
    const parsed = safeBigInt(q.toAmount)
    if (parsed !== null) nonCow.push(parsed)
  }
  nonCow.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  if (nonCow.length === 0) return null

  // Median (average of the two middle elements for even counts).
  const mid = nonCow.length >> 1
  const median = nonCow.length % 2 === 0
    ? (nonCow[mid - 1] + nonCow[mid]) / 2n
    : nonCow[mid]

  if (median === 0n) return null

  const cow = safeBigInt(meta.best.toAmount)
  if (cow === null || cow <= median) return null

  const surplusWei = cow - median
  // bps × 100 = pct × 10_000; convert via two's-complement-safe BigInt math.
  const pct = Number((surplusWei * 10_000n) / median) / 100

  return { amountWei: surplusWei, pct }
}
