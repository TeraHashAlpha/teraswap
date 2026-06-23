/**
 * swap-route.test.mjs — node:test proof for the keeper's /api/swap + /api/quote
 * request builders.
 *
 * Background: the keeper POSTed { source: "best", ... } with no decimals, which
 * /api/swap rejects: source "best" is not an AGGREGATOR_APIS key → 400
 * INVALID_SOURCE; and absent srcDecimals/dstDecimals mis-scales non-18-decimal
 * tokens → 422 DefiLlama priceGuard. The keeper must mirror the frontend:
 * GET /api/quote to pick a concrete best source, then POST /api/swap with that
 * source + token decimals. Captured evidence in FEEDBACK.md.
 *
 * /api/swap accepted params (src/app/api/swap/route.ts:61-76):
 *   source, src, dst, amount, from, slippage, srcDecimals, dstDecimals,
 *   quoteMeta, chainId, recipient   (NOTE: preferredRouter is NOT accepted)
 */
import { test } from "node:test"
import assert from "node:assert"

import { buildSwapRoutePayload, buildQuotePath, MAINNET_CHAIN_ID } from "./swap-route.js"

// The closed set /api/swap destructures from its JSON body.
const ACCEPTED_SWAP_PARAMS = new Set([
  "source", "src", "dst", "amount", "from", "slippage",
  "srcDecimals", "dstDecimals", "quoteMeta", "chainId", "recipient",
])

const BASE = {
  source: "velora", // a concrete AGGREGATOR_APIS source from /api/quote (never "best")
  tokenIn: "0x4200000000000000000000000000000000000006", // Base WETH
  tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base USDC (6 decimals)
  amount: "10000000000000000",
  from: "0x00000000000000000000000000000000000000F0",
  srcDecimals: 18,
  dstDecimals: 6,
}

// ── buildSwapRoutePayload ───────────────────────────────────
test("uses the concrete source from the quote — never 'best'", () => {
  const p = buildSwapRoutePayload({ ...BASE, chainId: 8453 })
  assert.strictEqual(p.source, "velora")
  assert.notStrictEqual(p.source, "best")
})

test("carries token decimals (fixes the 422 priceGuard on non-18-dec tokens)", () => {
  const p = buildSwapRoutePayload({ ...BASE, chainId: 8453 })
  assert.strictEqual(p.srcDecimals, 18)
  assert.strictEqual(p.dstDecimals, 6)
})

test("every payload key is an accepted /api/swap param (no preferredRouter)", () => {
  const p = buildSwapRoutePayload({ ...BASE, chainId: 8453 })
  for (const k of Object.keys(p)) {
    assert.ok(ACCEPTED_SWAP_PARAMS.has(k), `unexpected param "${k}" not in /api/swap schema`)
  }
  assert.ok(!("preferredRouter" in p), "preferredRouter is not an /api/swap param")
  for (const req of ["source", "src", "dst", "amount", "from"]) {
    assert.ok(p[req] != null, `required field ${req} missing`)
  }
})

test("maps src/dst/amount/from correctly", () => {
  const p = buildSwapRoutePayload({ ...BASE, chainId: 8453 })
  assert.strictEqual(p.src, BASE.tokenIn)
  assert.strictEqual(p.dst, BASE.tokenOut)
  assert.strictEqual(p.amount, BASE.amount)
  assert.strictEqual(p.from, BASE.from)
  assert.strictEqual(p.slippage, 0.5)
})

test("includes chainId for Base (8453); omits it on mainnet/absent (byte-identical chainId handling)", () => {
  assert.strictEqual(buildSwapRoutePayload({ ...BASE, chainId: 8453 }).chainId, 8453)
  assert.ok(!("chainId" in buildSwapRoutePayload({ ...BASE, chainId: MAINNET_CHAIN_ID })))
  assert.ok(!("chainId" in buildSwapRoutePayload({ ...BASE })))
})

test("throws when no concrete source is supplied (guards the 'best' regression)", () => {
  assert.throws(() => buildSwapRoutePayload({ ...BASE, source: undefined, chainId: 8453 }))
  assert.throws(() => buildSwapRoutePayload({ ...BASE, source: "", chainId: 8453 }))
})

// ── buildQuotePath ──────────────────────────────────────────
test("buildQuotePath includes src/dst/amount/decimals and chainId for Base", () => {
  const path = buildQuotePath({ ...BASE, chainId: 8453 })
  assert.ok(path.startsWith("/api/quote?"))
  assert.ok(path.includes(`src=${BASE.tokenIn}`))
  assert.ok(path.includes(`dst=${BASE.tokenOut}`))
  assert.ok(path.includes(`amount=${BASE.amount}`))
  assert.ok(path.includes("srcDecimals=18"))
  assert.ok(path.includes("dstDecimals=6"))
  assert.ok(path.includes("chainId=8453"))
})

test("buildQuotePath omits chainId on mainnet/absent (byte-identical quote on mainnet)", () => {
  assert.ok(!buildQuotePath({ ...BASE, chainId: MAINNET_CHAIN_ID }).includes("chainId"))
  assert.ok(!buildQuotePath({ ...BASE }).includes("chainId"))
})
