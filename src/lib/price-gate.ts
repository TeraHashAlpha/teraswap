/**
 * [SPRINT-9J J1] Price-gate classifier — separates oracle-SAFETY from price-IMPACT.
 *
 * Background: the client Chainlink check (useChainlinkPrice → evaluateDeviation)
 * computes `deviation = |executionPrice - chainlinkPrice| / chainlinkPrice`,
 * where `executionPrice` is the swap's realised rate — which already bakes in
 * the trade's OWN price impact. On an illiquid PMM route a legit ~2.2% price
 * impact therefore produces a ~2.2% "deviation" and the swap was hard-blocked
 * ("PRICE OUTSIDE SAFE RANGE — WAITING") indefinitely, because every re-poll
 * recomputes the same impact.
 *
 * Price impact is expected, slippage-covered cost — NOT an oracle-safety event.
 * This classifier distinguishes:
 *   - 'block'   — an oracle-INTEGRITY failure (stale / invalid / incomplete
 *                 round). The oracle itself can't be trusted → HARD block; the
 *                 user must NOT be able to click through.
 *   - 'consent' — a deviation on a HEALTHY oracle. This is price impact /
 *                 slippage the user already accepts → informed consent: surface
 *                 it and let the user accept and proceed.
 *   - 'ok'      — within threshold, or oracle-unavailable (which is handled by
 *                 the separate tiered-USD gate in SwapBox).
 *
 * IMPORTANT (rule #9): this only governs the CLIENT Chainlink deviation gate.
 * Genuine cross-source manipulation / quorum disagreement is still hard-blocked
 * by the SERVER-side DefiLlama price guard (useSwap → priceGuardBlocked, which
 * cannot be overridden), and the on-chain minimumOutput caps realised loss.
 * Loosening this client gate to informed-consent does not weaken those.
 */
import type { PriceCheck } from './chainlink'
import { PRICE_IMPACT_CONSENT_CEILING } from './constants'

export type PriceGateMode = 'ok' | 'consent' | 'block'
export type PriceGateReason = 'none' | 'oracle-integrity' | 'price-impact' | 'extreme-deviation'

export interface PriceGateResult {
  mode: PriceGateMode
  reason: PriceGateReason
  deviation: number
}

/**
 * Classify a Chainlink PriceCheck into a swap-gate decision.
 *
 * - oracleUnavailable → 'ok' here (the no-feed case is gated separately by the
 *   tiered unverified-swap USD thresholds in SwapBox; this classifier must not
 *   double-block it).
 * - oracleIntegrityFailed → 'block' (genuine oracle-safety event, no override).
 * - level warn/danger on a healthy oracle → 'consent' (price impact).
 * - otherwise → 'ok'.
 */
export function evaluatePriceGate(check: PriceCheck): PriceGateResult {
  const deviation = check.deviation

  // [FIX-PRICE-ORACLE-FAIL-CLOSED] Integrity is tested BEFORE unavailability, and the order is
  // load-bearing. A feed we could not READ is now both `oracleUnavailable` (so the tiered USD gate
  // engages) and `oracleIntegrityFailed` (so this gate hard-blocks at every trade size). Under the
  // original ordering the unavailable branch matched first and returned 'ok', which would have left
  // a sub-threshold swap on an unreadable oracle passing — weaker than before that fix, not
  // stronger. This reorder is a no-op for the pre-existing no-feed case: a genuinely unfeeded token
  // never sets oracleIntegrityFailed (useChainlinkPrice leaves it unset; evaluatePairOracle sets it
  // from the legs, false when none failed), so it still falls through to the branch below.
  if (check.oracleIntegrityFailed) {
    return { mode: 'block', reason: 'oracle-integrity', deviation }
  }

  if (check.oracleUnavailable) {
    return { mode: 'ok', reason: 'none', deviation }
  }

  if (check.level === 'danger' || check.level === 'warn') {
    // [review F2] Beyond the consent ceiling it isn't plausible price impact —
    // treat it as possible manipulation / broken quote and HARD block.
    if (deviation > PRICE_IMPACT_CONSENT_CEILING) {
      return { mode: 'block', reason: 'extreme-deviation', deviation }
    }
    return { mode: 'consent', reason: 'price-impact', deviation }
  }

  return { mode: 'ok', reason: 'none', deviation }
}
