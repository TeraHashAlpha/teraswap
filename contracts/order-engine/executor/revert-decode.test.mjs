/**
 * revert-decode.test.mjs — node:test proof for the SwapFailed(bytes) decoder.
 *
 * executeOrder wraps the inner DEX-router revert as SwapFailed(bytes reason)
 * (selector 0xff9fa595). The keeper logged only the raw blob, hiding the cause.
 * This decoder unwraps it → human-readable inner reason for the keeper log.
 */
import { test } from "node:test"
import assert from "node:assert"
import { encodeErrorResult, toHex } from "viem"

import { decodeSwapFailed, SWAP_FAILED_SELECTOR } from "./revert-decode.js"

const SWAP_FAILED_ABI = [{ type: "error", name: "SwapFailed", inputs: [{ type: "bytes", name: "reason" }] }]
const ERROR_ABI = [{ type: "error", name: "Error", inputs: [{ type: "string" }] }]

// Build a real SwapFailed(bytes) blob wrapping an inner Error(string).
function swapFailedWrapping(innerHex) {
  return encodeErrorResult({ abi: SWAP_FAILED_ABI, errorName: "SwapFailed", args: [innerHex] })
}
function errorString(msg) {
  return encodeErrorResult({ abi: ERROR_ABI, errorName: "Error", args: [msg] })
}

test("selector constant is the SwapFailed(bytes) selector", () => {
  assert.strictEqual(SWAP_FAILED_SELECTOR, "0xff9fa595")
})

test("decodes SwapFailed wrapping Error(string) → the inner string", () => {
  const blob = swapFailedWrapping(errorString("ERC20: transfer amount exceeds allowance"))
  const out = decodeSwapFailed(blob)
  assert.ok(out, "should decode")
  assert.match(out.reason, /transfer amount exceeds allowance/)
})

test("decodes SwapFailed wrapping an empty inner revert → 'empty' hint", () => {
  const blob = swapFailedWrapping("0x")
  const out = decodeSwapFailed(blob)
  assert.ok(out)
  assert.match(out.reason, /empty/i)
})

test("decodes SwapFailed wrapping non-standard bytes → raw hex", () => {
  const raw = toHex("velora-not-1inch", { size: 16 })
  const blob = swapFailedWrapping(raw)
  const out = decodeSwapFailed(blob)
  assert.ok(out)
  assert.ok(out.innerHex.toLowerCase() === raw.toLowerCase())
})

test("returns null for non-SwapFailed data", () => {
  assert.strictEqual(decodeSwapFailed(errorString("some other error")), null)
  assert.strictEqual(decodeSwapFailed("0x"), null)
  assert.strictEqual(decodeSwapFailed(undefined), null)
  assert.strictEqual(decodeSwapFailed("not-hex"), null)
})

// ── [FIX-P1B-M01] The executor's own market/route custom errors ─────────────────────────────
import { decodeExecutorMarketRevert, EXECUTOR_MARKET_REVERT_SELECTORS } from "./revert-decode.js"

test("EXECUTOR_MARKET_REVERT_SELECTORS pins the real selectors (keccak256 of the error signature)", () => {
  assert.strictEqual(EXECUTOR_MARKET_REVERT_SELECTORS.InsufficientOutput, "0xbb2875c3")
  assert.strictEqual(EXECUTOR_MARKET_REVERT_SELECTORS.PriceConditionNotMet, "0x3bef7afd")
})

test("decodes a raw InsufficientOutput() revert (no payload to ABI-decode)", () => {
  const out = decodeExecutorMarketRevert("0xbb2875c3")
  assert.ok(out)
  assert.strictEqual(out.name, "InsufficientOutput")
})

test("decodes a raw PriceConditionNotMet() revert", () => {
  const out = decodeExecutorMarketRevert("0x3bef7afd")
  assert.ok(out)
  assert.strictEqual(out.name, "PriceConditionNotMet")
})

test("is case-insensitive on the selector", () => {
  const out = decodeExecutorMarketRevert("0xBB2875C3")
  assert.ok(out)
  assert.strictEqual(out.name, "InsufficientOutput")
})

test("returns null for SwapFailed's own selector (a different revert class)", () => {
  assert.strictEqual(decodeExecutorMarketRevert("0xff9fa595"), null)
})

test("returns null for a PERMANENT-cause executor error (must NOT be classified as market)", () => {
  // OrderExpired() = 0xc56873ba — deliberately absent from the market table.
  assert.strictEqual(decodeExecutorMarketRevert("0xc56873ba"), null)
})

test("returns null for non-hex / absent data", () => {
  assert.strictEqual(decodeExecutorMarketRevert(null), null)
  assert.strictEqual(decodeExecutorMarketRevert(undefined), null)
  assert.strictEqual(decodeExecutorMarketRevert("not-hex"), null)
  assert.strictEqual(decodeExecutorMarketRevert(""), null)
})

test("returns null for an unrelated selector", () => {
  assert.strictEqual(decodeExecutorMarketRevert("0x12345678"), null)
})
