/**
 * freeze-score.js — PURE freeze-urgency scoring for the TeraSwap executor.
 *
 * Computes a 0..20 "freeze-urgency" score from a set of operational signals,
 * so that human operators can decide whether to FREEZE DCA execution via
 * `POST /api/admin/dca-freeze`. The bot NEVER freezes automatically — this
 * module only quantifies urgency and tiers it.
 *
 * This module is PURE: no imports, no I/O, no side effects, deterministic.
 * It is NOT in CI; freeze-score.test.mjs (node:test) is the proof of behaviour.
 *
 * Signals (all numbers / booleans, see computeFreezeScore):
 *   - unexplainedOutflowEth / outflowThresholdEth : DOMINANT signal. Funds
 *     leaving the executor wallet beyond what executed orders explain.
 *   - gasUsdValue : USD value of the wallet's ETH balance available for gas.
 *     A near-empty wallet means orders can't execute (and could indicate drain).
 *   - consecutiveExecFailures : repeated on-chain execution failures.
 *   - rpcDown : the RPC endpoint is unreachable.
 *
 * Total score is the sum of the per-signal contributions, capped to [0, 20].
 * Each contribution is monotonic in its driving signal.
 */

// ─── Weight constants (exported + documented) ───────────────────────────────

/**
 * Maximum contribution of the unexplained-outflow signal.
 * DOMINANT: a full-threshold (or larger) outflow alone reaches the `critical`
 * tier floor on its own, since 15 = critical and this caps at 12 (≥12 means a
 * single extra signal tips it to critical). Ramps linearly with
 * outflowEth / thresholdEth, clamped at the threshold ratio of 1.0.
 */
export const WEIGHT_OUTFLOW_MAX = 12

/**
 * Maximum contribution of the low/critical-gas signal.
 * Full weight when the wallet's gas value is ~$0 (can't pay for any tx /
 * possible drain); partial as it ramps up to the "low gas" ceiling; zero once
 * the wallet holds a comfortable gas buffer.
 */
export const WEIGHT_GAS_MAX = 4

/**
 * USD value at/above which the gas signal contributes nothing (comfortable).
 * Below this value the wallet is "low" and the signal fires. Per the contract:
 * <5 ⇒ partial, <1 ⇒ full, 0 ⇒ full.
 */
export const GAS_LOW_USD = 5

/**
 * USD value below which gas is "critical" (near-empty wallet ⇒ full weight,
 * possible drain / can't pay for any tx). Per the contract: <1 ⇒ full.
 */
export const GAS_CRITICAL_USD = 1

/**
 * Floor of the "low but not critical" partial gas contribution (at ~$5). Keeps
 * every low-gas value a strictly positive partial that survives integer
 * rounding of the total score (so $4.99 ⇒ a non-zero partial, never 0).
 */
export const GAS_LOW_PARTIAL_FLOOR = 1

/**
 * Maximum contribution of the repeated-execution-failures signal.
 * Each consecutive failure adds per-failure weight up to this cap. Repeated
 * failures suggest a systemic problem (bad calldata, paused contract,
 * slippage, RPC mempool issues).
 */
export const WEIGHT_FAILURES_MAX = 4

/**
 * Number of consecutive failures at which the failure signal reaches its cap.
 * Below this it ramps linearly; at/above it is pinned to WEIGHT_FAILURES_MAX.
 */
export const FAILURES_CAP_COUNT = 4

/**
 * Contribution of the rpc-down signal. Binary: present (rpcDown=true) ⇒ this
 * weight, absent ⇒ 0. RPC down means we are flying blind and cannot execute.
 */
export const WEIGHT_RPC_DOWN = 3

/**
 * Hard cap on the total score. The sum of all weights (12+4+4+3 = 23) exceeds
 * this on purpose so a worst-case "everything is wrong" input saturates at 20.
 */
export const SCORE_MAX = 20

// ─── Tier thresholds (exported + documented) ────────────────────────────────

/** Score at/above which the tier becomes 'warn'. */
export const TIER_WARN_THRESHOLD = 8

/** Score at/above which the tier becomes 'critical'. */
export const TIER_CRITICAL_THRESHOLD = 15

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Clamp `n` into the inclusive range [lo, hi]. Non-finite ⇒ lo.
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(n, lo, hi) {
  if (typeof n !== "number" || !Number.isFinite(n)) return lo
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

/**
 * Outflow contribution: 0..WEIGHT_OUTFLOW_MAX, ramps linearly with the ratio
 * outflowEth / thresholdEth, clamped at ratio 1.0 (≥ threshold ⇒ full weight).
 * @param {number} outflowEth
 * @param {number} thresholdEth
 * @returns {number}
 */
function outflowContribution(outflowEth, thresholdEth) {
  const outflow = clamp(outflowEth, 0, Number.POSITIVE_INFINITY)
  // A non-positive / non-finite threshold can't be ramped against; treat any
  // positive outflow as fully dominant, no outflow as zero.
  if (typeof thresholdEth !== "number" || !Number.isFinite(thresholdEth) || thresholdEth <= 0) {
    return outflow > 0 ? WEIGHT_OUTFLOW_MAX : 0
  }
  const ratio = clamp(outflow / thresholdEth, 0, 1)
  return ratio * WEIGHT_OUTFLOW_MAX
}

/**
 * Gas contribution: WEIGHT_GAS_MAX (full) when gas value is "low" (< GAS_LOW_USD),
 * extra-penalised when "critical" (< GAS_CRITICAL_USD), and 0 once the wallet
 * holds a comfortable buffer (>= GAS_LOW_USD). Per the contract:
 *   gasUsdValue 0   ⇒ full weight (critical: empty wallet / possible drain)
 *   gasUsdValue 4.99⇒ partial weight (low but not yet critical)
 *   gasUsdValue 10  ⇒ 0 (comfortable)
 *
 * A *missing* (undefined / non-finite) gasUsdValue is treated as "no signal"
 * (returns 0) — distinct from an explicit numeric 0 which means an empty wallet.
 * @param {number} gasUsdValue
 * @returns {number}
 */
function gasContribution(gasUsdValue) {
  // No signal supplied ⇒ no contribution (fail-open; don't invent urgency).
  if (typeof gasUsdValue !== "number" || !Number.isFinite(gasUsdValue)) return 0
  const gas = clamp(gasUsdValue, 0, Number.POSITIVE_INFINITY)
  if (gas >= GAS_LOW_USD) return 0
  // Critical (near-empty) ⇒ full weight. <1 ⇒ full per the contract.
  if (gas < GAS_CRITICAL_USD) return WEIGHT_GAS_MAX
  // Low (>= $1, < $5): partial. Ramps DOWN from WEIGHT_GAS_MAX (just above $1)
  // toward GAS_LOW_PARTIAL_FLOOR (just under $5) so every "low" value is a
  // distinct, integer-surviving partial.
  const span = GAS_LOW_USD - GAS_CRITICAL_USD
  const deficit = (GAS_LOW_USD - gas) / span // 1.0 at $1 → ~0 near $5
  const partial = GAS_LOW_PARTIAL_FLOOR + deficit * (WEIGHT_GAS_MAX - GAS_LOW_PARTIAL_FLOOR)
  return partial
}

/**
 * Failures contribution: ramps linearly with consecutiveExecFailures up to
 * FAILURES_CAP_COUNT, then pinned to WEIGHT_FAILURES_MAX.
 * @param {number} consecutiveExecFailures
 * @returns {number}
 */
function failuresContribution(consecutiveExecFailures) {
  const fails = clamp(consecutiveExecFailures, 0, Number.POSITIVE_INFINITY)
  const ratio = clamp(fails / FAILURES_CAP_COUNT, 0, 1)
  return ratio * WEIGHT_FAILURES_MAX
}

/**
 * Compute the freeze-urgency score (integer, 0..20) from the operational signals.
 * Monotonic in every signal and capped to [0, SCORE_MAX].
 *
 * @param {object} signals
 * @param {number} signals.unexplainedOutflowEth — ETH leaving the wallet unexplained by executed orders
 * @param {number} signals.outflowThresholdEth — ETH outflow considered "full alarm"
 * @param {number} signals.gasUsdValue — USD value of the wallet's gas (ETH) balance
 * @param {number} signals.consecutiveExecFailures — count of back-to-back execution failures
 * @param {boolean} signals.rpcDown — whether the RPC endpoint is unreachable
 * @returns {number} integer 0..20
 */
export function computeFreezeScore(signals) {
  const s = signals || {}

  const raw =
    outflowContribution(s.unexplainedOutflowEth, s.outflowThresholdEth) +
    gasContribution(s.gasUsdValue) +
    failuresContribution(s.consecutiveExecFailures) +
    (s.rpcDown === true ? WEIGHT_RPC_DOWN : 0)

  return Math.round(clamp(raw, 0, SCORE_MAX))
}

/**
 * Map a score to its urgency tier.
 *   score >= TIER_CRITICAL_THRESHOLD (15) ⇒ 'critical'
 *   score >= TIER_WARN_THRESHOLD     (8)  ⇒ 'warn'
 *   otherwise                              ⇒ 'info'
 * @param {number} score
 * @returns {'info' | 'warn' | 'critical'}
 */
export function scoreTier(score) {
  if (score >= TIER_CRITICAL_THRESHOLD) return "critical"
  if (score >= TIER_WARN_THRESHOLD) return "warn"
  return "info"
}
