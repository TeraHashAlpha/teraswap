// Tests for order-floor.js — the pure oracle-bounded per-fill floor for DCA.
//
// [SPRINT-ORDER-ONCHAIN-FLOOR / P1a] The keeper's only economic floor for DCA was
// a flat 0.5% off the aggregator's OWN quote, so a manipulated/loose/self-
// consistent bad quote could drain a chunk to dust (the on-chain minOut is 1 wei
// for DCA). This module adds an INDEPENDENT fair-value floor: reject a fill whose
// built output is below reference × (1 − maxSlippage). Pure, never-throwing —
// same pattern as deviation-guard.test.mjs: import the pure fns, assert values,
// never import executor.js (which auto-runs main() on import).

import { test, describe, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  computeReferenceExpectedOut,
  decideFloor,
  getFloorMaxSlippageBps,
  DCA_ORACLE_FLOOR_BPS,
  DCA_ORACLE_FLOOR_BPS_MIN,
  DCA_ORACLE_FLOOR_BPS_MAX,
} from "./order-floor.js"

afterEach(() => {
  delete process.env.DCA_ORACLE_FLOOR_BPS
})

describe("computeReferenceExpectedOut — fair-value expected output", () => {
  test("1 WETH (18dp) @ $3000 → USDC (6dp) @ $1 ⇒ 3000 USDC raw", () => {
    const out = computeReferenceExpectedOut({
      netAmountIn: 10n ** 18n, // 1 WETH
      srcDecimals: 18,
      dstDecimals: 6,
      priceInUsd: 3000,
      priceOutUsd: 1,
    })
    assert.equal(out, 3000_000000n) // 3000 * 1e6
  })

  test("USDC (6dp) $500 → WETH (18dp) @ $2500 ⇒ 0.2 WETH raw", () => {
    const out = computeReferenceExpectedOut({
      netAmountIn: 500_000000n, // 500 USDC
      srcDecimals: 6,
      dstDecimals: 18,
      priceInUsd: 1,
      priceOutUsd: 2500,
    })
    assert.equal(out, 2n * 10n ** 17n) // 0.2 WETH
  })

  test("same-decimals pair scales purely by price ratio", () => {
    // 100 tokenIn (18dp) @ $2 → tokenOut (18dp) @ $4 ⇒ 50 tokenOut
    const out = computeReferenceExpectedOut({
      netAmountIn: 100n * 10n ** 18n,
      srcDecimals: 18,
      dstDecimals: 18,
      priceInUsd: 2,
      priceOutUsd: 4,
    })
    assert.equal(out, 50n * 10n ** 18n)
  })

  test("accepts a decimal-string raw amount", () => {
    const out = computeReferenceExpectedOut({
      netAmountIn: "1000000000000000000",
      srcDecimals: 18, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 1,
    })
    assert.equal(out, 3000_000000n)
  })

  test("null on unusable inputs (zero/negative price, unparseable amount, bad decimals)", () => {
    assert.equal(computeReferenceExpectedOut({ netAmountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 0 }), null)
    assert.equal(computeReferenceExpectedOut({ netAmountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 6, priceInUsd: -1, priceOutUsd: 1 }), null)
    assert.equal(computeReferenceExpectedOut({ netAmountIn: "not-a-number", srcDecimals: 18, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 1 }), null)
    assert.equal(computeReferenceExpectedOut({ netAmountIn: "0", srcDecimals: 18, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 1 }), null)
    assert.equal(computeReferenceExpectedOut({ netAmountIn: 10n ** 18n, srcDecimals: 18.5, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 1 }), null)
  })

  test("precision holds for a large (1000-token) chunk — no float-mantissa loss", () => {
    // 1000 WETH @ $3000 → USDC @ $1 ⇒ 3,000,000 USDC exactly.
    const out = computeReferenceExpectedOut({
      netAmountIn: 1000n * 10n ** 18n, srcDecimals: 18, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 1,
    })
    assert.equal(out, 3_000_000_000000n)
  })
})

describe("decideFloor — reject sub-reference fills", () => {
  const ref = 3000_000000n // 3000 USDC fair value
  const bps = 300 // 3%

  test("built output at fair value passes", () => {
    const d = decideFloor({ builtExpectedOut: ref, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, true)
    assert.equal(d.flagged, false)
    assert.equal(d.floorOut, (ref * 9700n) / 10000n)
  })

  test("built output exactly at the floor passes (inclusive)", () => {
    const floor = (ref * 9700n) / 10000n // reference × (1 − 3%)
    const d = decideFloor({ builtExpectedOut: floor, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, true)
  })

  test("built output one wei below the floor is REJECTED", () => {
    const floor = (ref * 9700n) / 10000n
    const d = decideFloor({ builtExpectedOut: floor - 1n, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, false)
    assert.equal(d.flagged, true)
  })

  test("ADVERSARIAL: a drain-to-dust built output cannot fill", () => {
    // A compromised keeper / loose calldata quotes ~1 wei out.
    const d = decideFloor({ builtExpectedOut: 1n, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, false)
  })

  test("ADVERSARIAL: a 50%-below-fair manipulated quote cannot fill", () => {
    const d = decideFloor({ builtExpectedOut: ref / 2n, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, false)
  })

  test("unparseable built output is REFUSED (fail-safe, not filled)", () => {
    const d = decideFloor({ builtExpectedOut: "garbage", referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, false)
    assert.equal(d.flagged, true)
  })

  test("no reference ⇒ fills but FLAGGED (conservative flat floor, not blind)", () => {
    const d = decideFloor({ builtExpectedOut: ref, referenceExpectedOut: null, maxSlippageBps: bps, hasReference: false })
    assert.equal(d.ok, true)
    assert.equal(d.flagged, true)
    assert.equal(d.hasReference, false)
  })

  test("hasReference=true but reference ≤ 0 falls back to the flagged no-reference path", () => {
    const d = decideFloor({ builtExpectedOut: ref, referenceExpectedOut: 0n, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, true)
    assert.equal(d.flagged, true)
    assert.equal(d.hasReference, false)
  })

  test("deterministic and side-effect-free over repeated calls", () => {
    const args = { builtExpectedOut: ref - 1n, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true }
    const first = decideFloor(args)
    for (let i = 0; i < 50; i++) assert.deepEqual(decideFloor(args), first)
  })
})

describe("getFloorMaxSlippageBps — env override, clamped", () => {
  test("defaults to 300 bps", () => {
    assert.equal(DCA_ORACLE_FLOOR_BPS, 300)
    assert.equal(getFloorMaxSlippageBps(), 300)
  })

  test("honours a valid override", () => {
    process.env.DCA_ORACLE_FLOOR_BPS = "150"
    assert.equal(getFloorMaxSlippageBps(), 150)
  })

  test("clamps below MIN and above MAX (never disables the floor)", () => {
    process.env.DCA_ORACLE_FLOOR_BPS = "0"
    assert.equal(getFloorMaxSlippageBps(), DCA_ORACLE_FLOOR_BPS_MIN)
    process.env.DCA_ORACLE_FLOOR_BPS = "99999"
    assert.equal(getFloorMaxSlippageBps(), DCA_ORACLE_FLOOR_BPS_MAX)
  })

  test("falls back to default on a non-numeric override", () => {
    process.env.DCA_ORACLE_FLOOR_BPS = "banana"
    assert.equal(getFloorMaxSlippageBps(), DCA_ORACLE_FLOOR_BPS)
  })
})
