/**
 * executor-routing.test.mjs — node:test proof for the PURE dual-executor routing module.
 * Run: node --test contracts/order-engine/executor/executor-routing.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert"

import { resolveExecutorRouting } from "./executor-routing.js"

const V2_ADDR = "0x2222222222222222222222222222222222222222"
const V2_ABI = [{ name: "v2" }]
const V3_ADDR = "0x3333333333333333333333333333333333333333"
const V3_ABI = [{ name: "v3" }]

test("a v2 order (no maxSlippageBps in order_data) always routes to v2, regardless of v3 config", () => {
  const withoutV3 = resolveExecutorRouting({
    orderData: { owner: "0xabc" },
    v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: "", v3Abi: V3_ABI,
  })
  assert.strictEqual(withoutV3.ok, true)
  assert.strictEqual(withoutV3.isV3, false)
  assert.strictEqual(withoutV3.execAddress, V2_ADDR)
  assert.strictEqual(withoutV3.execAbi, V2_ABI)

  const withV3Configured = resolveExecutorRouting({
    orderData: { owner: "0xabc" },
    v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: V3_ADDR, v3Abi: V3_ABI,
  })
  assert.strictEqual(withV3Configured.isV3, false)
  assert.strictEqual(withV3Configured.execAddress, V2_ADDR, "v3 being configured must not hijack a v2 order")
})

test("a v3 order (maxSlippageBps present) routes to v3 when configured", () => {
  const r = resolveExecutorRouting({
    orderData: { owner: "0xabc", maxSlippageBps: 300 },
    v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: V3_ADDR, v3Abi: V3_ABI,
  })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.isV3, true)
  assert.strictEqual(r.execAddress, V3_ADDR)
  assert.strictEqual(r.execAbi, V3_ABI)
})

test("a v3 order with v3 UNCONFIGURED (empty address) is SKIPPED — never falls back to v2", () => {
  const r = resolveExecutorRouting({
    orderData: { owner: "0xabc", maxSlippageBps: 300 },
    v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: "", v3Abi: V3_ABI,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.isV3, true)
  assert.strictEqual(r.execAddress, null, "must never resolve to v2's address for a v3 order")
  assert.strictEqual(r.execAbi, null)
})

test("maxSlippageBps === 0 still counts as a v3 order (presence, not truthiness)", () => {
  // A real order should never actually sign 0 (rejected server-side), but the routing decision
  // itself must key on FIELD PRESENCE, not JS truthiness — 0 is a valid uint16 value structurally.
  const r = resolveExecutorRouting({
    orderData: { owner: "0xabc", maxSlippageBps: 0 },
    v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: V3_ADDR, v3Abi: V3_ABI,
  })
  assert.strictEqual(r.isV3, true)
})

test("null/undefined maxSlippageBps is a v2 order", () => {
  assert.strictEqual(
    resolveExecutorRouting({ orderData: { maxSlippageBps: null }, v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: V3_ADDR, v3Abi: V3_ABI }).isV3,
    false,
  )
  assert.strictEqual(
    resolveExecutorRouting({ orderData: { maxSlippageBps: undefined }, v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: V3_ADDR, v3Abi: V3_ABI }).isV3,
    false,
  )
})

test("missing/empty orderData never throws — degrades to a v2 routing decision", () => {
  assert.doesNotThrow(() => resolveExecutorRouting({ orderData: null, v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: "", v3Abi: V3_ABI }))
  assert.doesNotThrow(() => resolveExecutorRouting({ orderData: undefined, v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: "", v3Abi: V3_ABI }))
  const r = resolveExecutorRouting({ orderData: undefined, v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: "", v3Abi: V3_ABI })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.isV3, false)
})

test("routing matrix — every (order kind × v3-configured) combination", () => {
  const cases = [
    { label: "v2 order, v3 unconfigured", od: {}, v3: "", expectOk: true, expectV3: false, expectAddr: V2_ADDR },
    { label: "v2 order, v3 configured", od: {}, v3: V3_ADDR, expectOk: true, expectV3: false, expectAddr: V2_ADDR },
    { label: "v3 order, v3 unconfigured", od: { maxSlippageBps: 300 }, v3: "", expectOk: false, expectV3: true, expectAddr: null },
    { label: "v3 order, v3 configured", od: { maxSlippageBps: 300 }, v3: V3_ADDR, expectOk: true, expectV3: true, expectAddr: V3_ADDR },
  ]
  for (const c of cases) {
    const r = resolveExecutorRouting({ orderData: c.od, v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: c.v3, v3Abi: V3_ABI })
    assert.strictEqual(r.ok, c.expectOk, c.label)
    assert.strictEqual(r.isV3, c.expectV3, c.label)
    assert.strictEqual(r.execAddress, c.expectAddr, c.label)
  }
})

// [SPRINT-V3-P3] "Keeper: NO routing change — on-chain checks authoritative; add a test
// asserting a cancelled/invalidated v3 order is skipped."
//
// resolveExecutorRouting has NO concept of an order's cancelled/invalidated state — routing
// only decides WHICH contract+ABI the keeper calls, exactly the same way regardless of whether
// that order has been cancelled on-chain. The skip itself happens one layer up in executor.js's
// existing, UNCHANGED `if (!canExec) { ...skip... }` check after calling `canExecute()` against
// the address routing resolved (contracts/order-engine/executor/executor.js — v3's canExecute
// already returns canExec=false with reason "Order cancelled" for a cancelled hash, or "Nonce
// used" for a v3 order whose bitmap bit is now set, per TeraSwapOrderExecutorV3.sol's
// cancelledOrders/isNonceUsed checks — see :364 and :377). That generic check is orthogonal to
// v2/v3 and was not touched by this sprint or #299.
//
// What IS worth proving here: a cancelled/invalidated order's order_data is STILL routed
// correctly (never silently rerouted to v2, never dropped from consideration by routing itself)
// — routing resolves purely from order_data.maxSlippageBps + config, so the SAME v3
// address+ABI is used whether the order later turns out live or cancelled. The contract call
// that follows (canExecute, mocked out of scope for this pure module) is what actually skips it.
test("routing is ORTHOGONAL to order cancellation state — a v3 order still routes to v3 regardless (the contract's canExecute skip is a separate, unchanged layer)", () => {
  const liveOrder = { maxSlippageBps: 300 }
  // order_data carries no 'cancelled' flag at all — cancellation lives on-chain
  // (cancelledOrders[orderHash] / nonceBitmap), not in the DB row's signed struct. Routing can
  // only ever see the signed struct, so it MUST resolve identically either way.
  const sameShapeOrder = { maxSlippageBps: 300 }

  const rLive = resolveExecutorRouting({ orderData: liveOrder, v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: V3_ADDR, v3Abi: V3_ABI })
  const rAlsoV3 = resolveExecutorRouting({ orderData: sameShapeOrder, v2Address: V2_ADDR, v2Abi: V2_ABI, v3Address: V3_ADDR, v3Abi: V3_ABI })

  assert.strictEqual(rLive.execAddress, V3_ADDR)
  assert.strictEqual(rAlsoV3.execAddress, V3_ADDR)
  assert.deepStrictEqual(rLive, rAlsoV3, "routing must be a pure function of order_data + config, never of a status the module never receives")
})
