/**
 * [CHORE-DCA-COST-PREVIEW] Per-buy cost preview shown at DCA creation, before signing.
 *
 * Transparency-brand invariant (owner, 2026-07-23): never say "free" or "gasless" — DCA
 * execution has a real cost, and the honest claim is WHO pays it today, not that it's absent.
 *
 * Two components, both sourced (never hardcoded ad hoc):
 *   - fee: 0.1% of the per-CHUNK notional, reusing the SAME ORDER_FEE_BPS / ORDER_BPS_DENOMINATOR
 *     canonical-route.ts already mirrors from the deployed contract's `FEE_BPS` constant
 *     (TeraSwapOrderExecutorV3.sol:131) — one source of truth, no independent 0.001 literal here.
 *   - network cost: a conservative, LABELLED constant (see DCA_NETWORK_COST_ESTIMATE_USD below).
 *     No live gas read exists client-side today (that's a keeper/RPC concern, out of scope for
 *     this display-only chore), so per the fallback the spec allows, this is a sourced constant
 *     rather than a live estimate.
 */

import { ORDER_FEE_BPS, ORDER_BPS_DENOMINATOR } from './canonical-route'

/**
 * Conservative per-fill Base network-cost estimate, in USD.
 *
 * Source: docs/Reports/FILL-ECONOMICS-CALIBRATION.md measured the two real DCA fills (blocks
 * 48934744/48934819) at 1,364,707 / 1,347,595 gas units (aggregator route — DCA does not use the
 * P1B pinned canonical route, that's Limit/TP-only). The keeper's PRE-fix effective gas price was
 * 1.505 gwei (mainnet-calibrated PRIORITY_FEE_NORMAL), costing ~$3.90/fill.
 *
 * FIX-KEEPER-GAS-TIER-BASE (contracts/order-engine/executor/gas-tier.js) closed that gap with a
 * Base-specific NORMAL tier: priority 0.02 gwei + baseFee×2 (~0.005 gwei observed baseFee) ≈
 * 0.03 gwei effective price. Applying that to the SAME measured aggregator gas
 * (~1,364,707 × 0.03 gwei × ~$1947.73/ETH, the live Chainlink ETH/USD read the calibration used)
 * ≈ $0.066/fill — the upper end of the report's stated $0.03-$0.07 post-fix range. Using the
 * upper bound is the conservative choice: this is OUR cost estimate for a line that says "covered
 * by TeraSwap", so it should not understate what we're actually covering.
 *
 * REVISIT alongside any future gas-tier recalibration (see gas-tier.js's own revisit note on
 * Base's thresholds — this repo has not yet observed a real Base congestion event).
 */
export const DCA_NETWORK_COST_ESTIMATE_USD = 0.07

/**
 * Single source for "who pays the network cost today" — v3 truth: the keeper pays gas, not the
 * user. ADR-015 D2 specifies v4 changes this to a user-paid, capped charge ("paid by you, capped
 * at $Z"); when that ships, this is the ONE constant to update — every caller reads it, none
 * hardcodes the phrase.
 */
export const DCA_NETWORK_COST_COVERAGE_LABEL = 'covered by TeraSwap'

export interface DcaCostPreview {
  /** 0.1% of perChunkNotionalUsd, in USD. */
  feeUsd: number
  /** The sourced network-cost estimate, in USD (see DCA_NETWORK_COST_ESTIMATE_USD). */
  networkCostUsd: number
  /** Who currently covers the network cost — see DCA_NETWORK_COST_COVERAGE_LABEL. */
  coverageLabel: string
}

export interface ComputeDcaCostPreviewParams {
  /** The USD value of ONE chunk (whole-DCA total ÷ number of buys) — null/invalid ⇒ no preview. */
  perChunkNotionalUsd: number | null
}

/**
 * Compute the per-buy cost preview, or null when the notional cannot be priced/is invalid —
 * callers must hide the preview entirely rather than show a fabricated $0.00 line.
 */
export function computeDcaCostPreview({
  perChunkNotionalUsd,
}: ComputeDcaCostPreviewParams): DcaCostPreview | null {
  if (
    perChunkNotionalUsd == null ||
    !Number.isFinite(perChunkNotionalUsd) ||
    perChunkNotionalUsd <= 0
  ) {
    return null
  }

  return {
    feeUsd: perChunkNotionalUsd * (Number(ORDER_FEE_BPS) / Number(ORDER_BPS_DENOMINATOR)),
    networkCostUsd: DCA_NETWORK_COST_ESTIMATE_USD,
    coverageLabel: DCA_NETWORK_COST_COVERAGE_LABEL,
  }
}
