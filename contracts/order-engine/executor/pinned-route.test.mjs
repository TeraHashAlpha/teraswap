/**
 * [SPRINT-P1B / ADR-014 option (a)] pinned-route.js — pinned calldata resolution + revert telemetry.
 *
 * Proves the rule that keeps non-DCA v3 orders executable: the keeper REPLAYS the calldata the
 * user signed, verbatim, and refuses to execute rather than rebuilding a route (a rebuilt route
 * hashes differently and would revert RouterDataMismatch at TeraSwapOrderExecutorV3.sol:465).
 * Also pins that a route revert keeps the order ACTIVE (never 'failed') while still paging ops
 * once it looks like a persistent liveness problem.
 *
 * Never imports executor.js (which auto-runs main() on import) — this module is pure.
 *
 * Run: node --test contracts/order-engine/executor/pinned-route.test.mjs
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { keccak256 } from "viem"
import {
  resolvePinnedRouterData,
  planPinnedRouteRevert,
  isMarketRevert,
  MAX_CONSECUTIVE_ROUTE_REVERTS,
  ZERO_HASH,
} from "./pinned-route.js"

// A realistic SwapRouter02 exactInputSingle blob (selector + 7 encoded words).
const PINNED_CALLDATA = "0x04e45aaf" + "11".repeat(224)
const PINNED_HASH = keccak256(PINNED_CALLDATA)

describe("resolvePinnedRouterData — DCA is untouched", () => {
  test("a DCA order is not pinned; the caller still builds its route", () => {
    const r = resolvePinnedRouterData({
      orderType: "dca",
      orderData: { routerData: undefined },
      signedRouterDataHash: ZERO_HASH,
    })
    assert.equal(r.pinned, false)
    assert.equal(r.ok, true)
    assert.equal(r.routerData, null)
  })

  test("DCA stays unpinned even if a routerData somehow sits in order_data", () => {
    const r = resolvePinnedRouterData({
      orderType: "dca",
      orderData: { routerData: PINNED_CALLDATA },
      signedRouterDataHash: ZERO_HASH,
    })
    assert.equal(r.pinned, false)
    assert.equal(r.routerData, null)
  })
})

describe("resolvePinnedRouterData — non-DCA replays the signed bytes", () => {
  test("valid stored calldata matching the signed hash is returned verbatim", () => {
    const r = resolvePinnedRouterData({
      orderType: "limit",
      orderData: { routerData: PINNED_CALLDATA },
      signedRouterDataHash: PINNED_HASH,
    })
    assert.equal(r.pinned, true)
    assert.equal(r.ok, true)
    assert.equal(r.routerData, PINNED_CALLDATA, "must be byte-identical to what was signed")
  })

  test("TAMPERED stored calldata is refused (the exact check the contract makes at :465)", () => {
    const tampered = "0x04e45aaf" + "22".repeat(224)
    const r = resolvePinnedRouterData({
      orderType: "limit",
      orderData: { routerData: tampered },
      signedRouterDataHash: PINNED_HASH,
    })
    assert.equal(r.ok, false)
    assert.equal(r.routerData, null)
    assert.match(r.reason, /does not match the SIGNED routerDataHash/)
  })

  test("a non-DCA order with ZeroHash is refused as structurally unexecutable (P1c landmine)", () => {
    const r = resolvePinnedRouterData({
      orderType: "limit",
      orderData: { routerData: PINNED_CALLDATA },
      signedRouterDataHash: ZERO_HASH,
    })
    assert.equal(r.ok, false)
    assert.match(r.reason, /RouterDataRequired/)
  })

  test("missing stored routerData is refused — never falls back to building a route", () => {
    const r = resolvePinnedRouterData({
      orderType: "limit",
      orderData: {},
      signedRouterDataHash: PINNED_HASH,
    })
    assert.equal(r.ok, false)
    assert.equal(r.routerData, null)
    assert.match(r.reason, /no stored order_data\.routerData/)
  })

  test("null order_data is refused, not crashed on", () => {
    const r = resolvePinnedRouterData({
      orderType: "limit",
      orderData: null,
      signedRouterDataHash: PINNED_HASH,
    })
    assert.equal(r.ok, false)
  })

  test("malformed calldata (non-hex / too short) is refused", () => {
    for (const bad of ["0xzz", "0x1234", "not-calldata", ""]) {
      const r = resolvePinnedRouterData({
        orderType: "limit",
        orderData: { routerData: bad },
        signedRouterDataHash: PINNED_HASH,
      })
      assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(bad)}`)
    }
  })

  test("stop_loss orders follow the same pinned path (they are non-DCA on-chain)", () => {
    const r = resolvePinnedRouterData({
      orderType: "stop_loss",
      orderData: { routerData: PINNED_CALLDATA },
      signedRouterDataHash: PINNED_HASH,
    })
    assert.equal(r.pinned, true)
    assert.equal(r.ok, true)
  })
})

describe("planPinnedRouteRevert — a revert is recoverable, never an order failure", () => {
  test("keeps the order ACTIVE at every count (a Limit/TP that does not fill is not failed)", () => {
    for (const n of [1, 2, 5, 50]) {
      assert.equal(planPinnedRouteRevert({ consecutiveReverts: n }).keepActive, true)
    }
  })

  test("does not alert below the threshold, alerts at and above it", () => {
    assert.equal(planPinnedRouteRevert({ consecutiveReverts: 1 }).alert, false)
    assert.equal(
      planPinnedRouteRevert({ consecutiveReverts: MAX_CONSECUTIVE_ROUTE_REVERTS - 1 }).alert,
      false,
    )
    assert.equal(planPinnedRouteRevert({ consecutiveReverts: MAX_CONSECUTIVE_ROUTE_REVERTS }).alert, true)
    assert.equal(planPinnedRouteRevert({ consecutiveReverts: MAX_CONSECUTIVE_ROUTE_REVERTS + 3 }).alert, true)
  })

  test("the alerting reason names the liveness problem, not a failure", () => {
    const p = planPinnedRouteRevert({ consecutiveReverts: MAX_CONSECUTIVE_ROUTE_REVERTS })
    assert.match(p.reason, /still active/)
    assert.match(p.reason, /dislocated/)
  })

  test("an explicit threshold overrides the default", () => {
    assert.equal(planPinnedRouteRevert({ consecutiveReverts: 2, threshold: 2 }).alert, true)
  })
})

describe("matrix — every (orderType, hash, storedData) combination", () => {
  const CASES = [
    ["dca", ZERO_HASH, null, { pinned: false, ok: true }],
    ["dca", ZERO_HASH, PINNED_CALLDATA, { pinned: false, ok: true }],
    ["limit", ZERO_HASH, PINNED_CALLDATA, { pinned: true, ok: false }],
    ["limit", PINNED_HASH, null, { pinned: true, ok: false }],
    ["limit", PINNED_HASH, PINNED_CALLDATA, { pinned: true, ok: true }],
    ["stop_loss", PINNED_HASH, PINNED_CALLDATA, { pinned: true, ok: true }],
  ]

  for (const [orderType, hash, stored, want] of CASES) {
    test(`${orderType} / ${hash === ZERO_HASH ? "zerohash" : "realhash"} / ${stored ? "stored" : "nostored"}`, () => {
      const r = resolvePinnedRouterData({
        orderType,
        orderData: stored ? { routerData: stored } : {},
        signedRouterDataHash: hash,
      })
      assert.equal(r.pinned, want.pinned)
      assert.equal(r.ok, want.ok)
    })
  }
})

// ── [FIX-P1B-M01] isMarketRevert — the classification the M-01 fix hinges on ────────────────
describe("isMarketRevert — SwapFailed OR the executor's own market errors, never permanent causes", () => {
  test("SwapFailed (a decoded swapReason) is a market revert", () => {
    assert.equal(isMarketRevert({ swapReason: "ERC20: transfer amount exceeds allowance" }), true)
  })

  test("InsufficientOutput is a market revert (the M-01 bug: this was previously missed)", () => {
    assert.equal(isMarketRevert({ executorErrorName: "InsufficientOutput" }), true)
  })

  test("PriceConditionNotMet is a market revert", () => {
    assert.equal(isMarketRevert({ executorErrorName: "PriceConditionNotMet" }), true)
  })

  test("a permanent-cause executor error name is NOT a market revert", () => {
    for (const name of ["OrderExpired", "RouterNotWhitelisted", "InsufficientBalance", "InvalidNonce"]) {
      assert.equal(isMarketRevert({ executorErrorName: name }), false, `${name} must not be market`)
    }
  })

  test("neither swapReason nor executorErrorName set ⇒ not a market revert (undecoded / RPC error)", () => {
    assert.equal(isMarketRevert({}), false)
    assert.equal(isMarketRevert(), false)
  })

  test("swapReason takes precedence even if executorErrorName is somehow also set", () => {
    assert.equal(isMarketRevert({ swapReason: "x", executorErrorName: "OrderExpired" }), true)
  })
})
