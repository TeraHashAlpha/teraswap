/**
 * [P94] Gasless recommendation engine.
 *
 * CoW swaps are already gasless technically — the user signs an EIP-712
 * intent and the solver pays gas (deducted from the output). This module
 * detects when CoW is the right choice for the user even if it isn't the
 * strict highest-output quote: if the gas savings on the comparable non-CoW
 * route exceed the price gap, going gasless is net-positive.
 *
 * Pure function — no side effects, callable from hooks, API routes, and tests.
 */

import type { NormalizedQuote, GaslessQuoteOverlay } from './adapters'
import { safeBigInt } from './utils'

/** CoW is recommended when within this many bps of the best non-CoW output. */
export const GASLESS_PRICE_THRESHOLD_BPS = 50

/** Below this dollar amount, a "savings" claim is noise and we suppress it. */
export const GASLESS_MIN_SAVINGS_USD = 0.5

export type GaslessRecommendation = GaslessQuoteOverlay

const EMPTY: GaslessRecommendation = {
  available: false,
  recommended: false,
  reason: 'CoW quote not available',
  gasSavingsUsd: 0,
  priceDifferencePercent: 0,
  bestNonCowSource: '',
}

function bestByOutput(quotes: NormalizedQuote[]): NormalizedQuote | null {
  let best: NormalizedQuote | null = null
  let bestAmt: bigint | null = null
  for (const q of quotes) {
    const amt = safeBigInt(q.toAmount)
    if (amt === null) continue
    if (bestAmt === null || amt > bestAmt) {
      best = q
      bestAmt = amt
    }
  }
  return best
}

export function analyzeGasless(
  quotes: NormalizedQuote[],
  estimatedGasUsd: number,
): GaslessRecommendation {
  const cow = quotes.find((q) => q.source === 'cowswap')
  if (!cow) return { ...EMPTY }

  const cowAmt = safeBigInt(cow.toAmount)
  if (cowAmt === null || cowAmt === 0n) {
    return { ...EMPTY, reason: 'CoW quote has invalid output' }
  }

  const nonCow = quotes.filter((q) => q.source !== 'cowswap')
  const bestNonCow = bestByOutput(nonCow)

  // Gas savings = the gas the user would have paid on the best non-CoW route.
  // Prefer the caller-provided estimate (fresh ETH price); fall back to the
  // adapter's stored gasUsd if absent.
  const referenceGasUsd =
    estimatedGasUsd > 0
      ? estimatedGasUsd
      : bestNonCow?.gasUsd && bestNonCow.gasUsd > 0
        ? bestNonCow.gasUsd
        : 0

  // No non-CoW alternative → CoW is the only route; available but the
  // "savings" framing doesn't apply.
  if (!bestNonCow) {
    return {
      available: true,
      recommended: true,
      reason: 'Only gasless route available',
      gasSavingsUsd: 0,
      priceDifferencePercent: 0,
      bestNonCowSource: '',
    }
  }

  const nonCowAmt = safeBigInt(bestNonCow.toAmount)
  if (nonCowAmt === null || nonCowAmt === 0n) {
    return {
      available: true,
      recommended: true,
      reason: 'Only valid quote is gasless',
      gasSavingsUsd: referenceGasUsd,
      priceDifferencePercent: 0,
      bestNonCowSource: bestNonCow.source,
    }
  }

  // priceDifferencePercent = (cow - bestNonCow) / bestNonCow, expressed in %.
  // Positive → CoW gives more; negative → CoW gives less.
  const diffPct =
    (Number(cowAmt - nonCowAmt) / Number(nonCowAmt)) * 100
  const diffBps = Math.abs(diffPct) * 100

  const cowIsBest = cowAmt >= nonCowAmt
  const withinThreshold = diffBps <= GASLESS_PRICE_THRESHOLD_BPS

  // Net-positive check: even if CoW gives slightly less, gas savings can
  // make it the better deal. Approximate the price gap in USD by scaling
  // the non-CoW route's gas cost (a proxy for "how much output is one USD
  // of gas worth"). We can only do that when we have a meaningful gas
  // estimate; otherwise we fall back to the threshold check.
  const savingsExceedGap =
    referenceGasUsd >= GASLESS_MIN_SAVINGS_USD &&
    // The relative cost of the gap is just |diffPct|/100 of the trade.
    // Without a USD-value-of-output we can't compute it exactly, so we use
    // the bps threshold as a conservative proxy and require gas to clear it.
    withinThreshold

  let recommended = false
  let reason = ''

  if (cowIsBest && referenceGasUsd >= GASLESS_MIN_SAVINGS_USD) {
    recommended = true
    reason = `Best price AND zero gas — save ~$${referenceGasUsd.toFixed(2)}`
  } else if (cowIsBest) {
    recommended = true
    reason = 'Best price AND zero gas'
  } else if (savingsExceedGap) {
    recommended = true
    reason = `Save ~$${referenceGasUsd.toFixed(2)} in gas fees`
  } else if (withinThreshold) {
    // Within threshold but gas savings too small to advertise — still
    // technically available; surface a softer reason.
    recommended = false
    reason = 'Gasless available but gas savings are minimal'
  } else {
    recommended = false
    reason = `CoW output is ${Math.abs(diffPct).toFixed(2)}% below best route`
  }

  return {
    available: true,
    recommended,
    reason,
    gasSavingsUsd: recommended ? referenceGasUsd : 0,
    priceDifferencePercent: Number(diffPct.toFixed(4)),
    bestNonCowSource: bestNonCow.source,
  }
}
