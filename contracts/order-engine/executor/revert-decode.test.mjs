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
