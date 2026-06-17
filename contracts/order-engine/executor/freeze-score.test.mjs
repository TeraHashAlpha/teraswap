/**
 * freeze-score.test.mjs — node:test proof for the PURE freeze-score module.
 * Run: node --test contracts/order-engine/executor/freeze-score.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert"

import {
  computeFreezeScore,
  scoreTier,
  WEIGHT_OUTFLOW_MAX,
  WEIGHT_GAS_MAX,
  WEIGHT_FAILURES_MAX,
  WEIGHT_RPC_DOWN,
  GAS_LOW_USD,
  FAILURES_CAP_COUNT,
  SCORE_MAX,
  TIER_WARN_THRESHOLD,
  TIER_CRITICAL_THRESHOLD,
} from "./freeze-score.js"

// A baseline "everything healthy" signal set: no urgency.
const HEALTHY = {
  unexplainedOutflowEth: 0,
  outflowThresholdEth: 1,
  gasUsdValue: 100, // comfortable buffer, well above GAS_LOW_USD
  consecutiveExecFailures: 0,
  rpcDown: false,
}

test("zero signals ⇒ score 0", () => {
  const score = computeFreezeScore(HEALTHY)
  assert.strictEqual(score, 0)
  // A completely empty / undefined input must also be 0 (fail-open, no NaN).
  assert.strictEqual(computeFreezeScore({}), 0)
  assert.strictEqual(computeFreezeScore(undefined), 0)
})

test("outflow at threshold ⇒ dominant contribution (>=12)", () => {
  const score = computeFreezeScore({
    ...HEALTHY,
    unexplainedOutflowEth: 1,
    outflowThresholdEth: 1,
  })
  assert.ok(
    score >= 12,
    `expected dominant outflow contribution >=12, got ${score}`,
  )
  assert.strictEqual(WEIGHT_OUTFLOW_MAX, 12)
})

test("outflow above threshold is clamped (no overflow beyond the weight)", () => {
  const atThreshold = computeFreezeScore({
    ...HEALTHY,
    unexplainedOutflowEth: 1,
    outflowThresholdEth: 1,
  })
  const wayAbove = computeFreezeScore({
    ...HEALTHY,
    unexplainedOutflowEth: 1000,
    outflowThresholdEth: 1,
  })
  // Outflow alone (healthy otherwise) maxes at WEIGHT_OUTFLOW_MAX.
  assert.strictEqual(atThreshold, WEIGHT_OUTFLOW_MAX)
  assert.strictEqual(wayAbove, WEIGHT_OUTFLOW_MAX)
})

test("gas: $0 ⇒ full weight, $4.99 ⇒ partial, $10 ⇒ 0", () => {
  const full = computeFreezeScore({ ...HEALTHY, gasUsdValue: 0 })
  assert.strictEqual(full, WEIGHT_GAS_MAX) // 4

  const partial = computeFreezeScore({ ...HEALTHY, gasUsdValue: 4.99 })
  assert.ok(
    partial > 0 && partial < WEIGHT_GAS_MAX,
    `expected partial gas weight in (0, ${WEIGHT_GAS_MAX}), got ${partial}`,
  )

  const none = computeFreezeScore({ ...HEALTHY, gasUsdValue: 10 })
  assert.strictEqual(none, 0)

  // Exactly at the ceiling ⇒ no contribution.
  assert.strictEqual(computeFreezeScore({ ...HEALTHY, gasUsdValue: GAS_LOW_USD }), 0)
})

test("gas: critical (<$1) ⇒ full weight per the contract", () => {
  assert.strictEqual(computeFreezeScore({ ...HEALTHY, gasUsdValue: 0 }), WEIGHT_GAS_MAX)
  assert.strictEqual(computeFreezeScore({ ...HEALTHY, gasUsdValue: 0.5 }), WEIGHT_GAS_MAX)
  assert.strictEqual(computeFreezeScore({ ...HEALTHY, gasUsdValue: 0.99 }), WEIGHT_GAS_MAX)
})

test("gas: missing/undefined value contributes nothing (fail-open, no invented urgency)", () => {
  // undefined gas must not be treated as $0.
  assert.strictEqual(
    computeFreezeScore({
      unexplainedOutflowEth: 0,
      outflowThresholdEth: 1,
      consecutiveExecFailures: 0,
      rpcDown: false,
    }),
    0,
  )
})

test("gas contribution is monotonic decreasing as gas rises", () => {
  const at0 = computeFreezeScore({ ...HEALTHY, gasUsdValue: 0 })
  const at2 = computeFreezeScore({ ...HEALTHY, gasUsdValue: 2 })
  const at4 = computeFreezeScore({ ...HEALTHY, gasUsdValue: 4 })
  assert.ok(at0 >= at2 && at2 >= at4, `expected ${at0} >= ${at2} >= ${at4}`)
  assert.ok(at0 > at4, "gas urgency at $0 must exceed urgency near the ceiling")
})

test("many consecutive failures ⇒ capped failure weight", () => {
  const oneFail = computeFreezeScore({ ...HEALTHY, consecutiveExecFailures: 1 })
  const capFail = computeFreezeScore({
    ...HEALTHY,
    consecutiveExecFailures: FAILURES_CAP_COUNT,
  })
  const manyFail = computeFreezeScore({
    ...HEALTHY,
    consecutiveExecFailures: 9999,
  })
  assert.ok(oneFail > 0 && oneFail < WEIGHT_FAILURES_MAX, `partial at 1 failure, got ${oneFail}`)
  assert.strictEqual(capFail, WEIGHT_FAILURES_MAX) // 4
  // Beyond the cap count must NOT exceed the cap weight.
  assert.strictEqual(manyFail, WEIGHT_FAILURES_MAX)
})

test("rpcDown adds exactly its weight", () => {
  const without = computeFreezeScore(HEALTHY)
  const withRpc = computeFreezeScore({ ...HEALTHY, rpcDown: true })
  assert.strictEqual(without, 0)
  assert.strictEqual(withRpc, WEIGHT_RPC_DOWN) // 3
})

test("worst-case all-signals input caps at 20", () => {
  const worst = computeFreezeScore({
    unexplainedOutflowEth: 10_000,
    outflowThresholdEth: 1,
    gasUsdValue: 0,
    consecutiveExecFailures: 1000,
    rpcDown: true,
  })
  // 12 + 4 + 4 + 3 = 23 raw, capped to SCORE_MAX.
  assert.strictEqual(worst, SCORE_MAX)
  assert.strictEqual(SCORE_MAX, 20)
})

test("score is always an integer in [0, 20]", () => {
  const inputs = [
    { ...HEALTHY, gasUsdValue: 4.99 },
    { ...HEALTHY, consecutiveExecFailures: 1 },
    { ...HEALTHY, unexplainedOutflowEth: 0.37, outflowThresholdEth: 1 },
    { unexplainedOutflowEth: 7, outflowThresholdEth: 3, gasUsdValue: 1, consecutiveExecFailures: 2, rpcDown: true },
  ]
  for (const sig of inputs) {
    const score = computeFreezeScore(sig)
    assert.ok(Number.isInteger(score), `score must be an integer, got ${score}`)
    assert.ok(score >= 0 && score <= SCORE_MAX, `score out of range: ${score}`)
  }
})

test("scoreTier boundaries: 7→info, 8→warn, 14→warn, 15→critical", () => {
  assert.strictEqual(scoreTier(0), "info")
  assert.strictEqual(scoreTier(7), "info")
  assert.strictEqual(scoreTier(8), "warn")
  assert.strictEqual(scoreTier(14), "warn")
  assert.strictEqual(scoreTier(15), "critical")
  assert.strictEqual(scoreTier(20), "critical")
  // Threshold constants must agree with the tested boundaries.
  assert.strictEqual(TIER_WARN_THRESHOLD, 8)
  assert.strictEqual(TIER_CRITICAL_THRESHOLD, 15)
})
