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
