/**
 * swap-route.test.mjs — node:test proof for the PURE keeper /api/swap payload builder.
 * Run: node --test contracts/order-engine/executor/swap-route.test.mjs
 *
 * Guards the chain-awareness fix: the keeper must send chainId (as a BODY field,
 * per src/app/api/swap/route.ts + the frontend useSwap contract) so Base DCA
 * chunks route on Base instead of mainnet (the "Swap API error: 400" on Base).
 * Mainnet (CHAIN_ID=1) must stay byte-identical to the legacy request.
 */
import { test } from "node:test"
import assert from "node:assert"

import { buildSwapRoutePayload, MAINNET_CHAIN_ID } from "./swap-route.js"

const BASE = {
  tokenIn: "0x4200000000000000000000000000000000000006", // Base WETH
  tokenOut: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
  amount: "1000000000000000000",
  from: "0x00000000000000000000000000000000000000F0", // executor contract
  router: "0xUniversalRouter",
}

test("includes chainId as a body field for a Base (8453) order", () => {
  const payload = buildSwapRoutePayload({ ...BASE, chainId: 8453 })
  assert.strictEqual(payload.chainId, 8453)
})

test("carries the core /api/swap fields the route requires", () => {
  const payload = buildSwapRoutePayload({ ...BASE, chainId: 8453 })
  assert.strictEqual(payload.source, "best")
  assert.strictEqual(payload.src, BASE.tokenIn)
  assert.strictEqual(payload.dst, BASE.tokenOut)
  assert.strictEqual(payload.amount, BASE.amount)
  assert.strictEqual(payload.from, BASE.from)
  assert.strictEqual(payload.preferredRouter, BASE.router)
  assert.strictEqual(payload.slippage, 0.5)
})

test("omits chainId on mainnet (CHAIN_ID=1) → byte-identical legacy request", () => {
  const payload = buildSwapRoutePayload({ ...BASE, chainId: MAINNET_CHAIN_ID })
  assert.ok(!("chainId" in payload), "mainnet payload must not carry chainId")
  // The legacy request body had exactly these fields, in this order.
  const legacy = {
    source: "best",
    src: BASE.tokenIn,
    dst: BASE.tokenOut,
    amount: BASE.amount,
    from: BASE.from,
    slippage: 0.5,
    preferredRouter: BASE.router,
  }
  assert.strictEqual(JSON.stringify(payload), JSON.stringify(legacy))
})

test("omits chainId when undefined/null (defaults to mainnet at the route)", () => {
  assert.ok(!("chainId" in buildSwapRoutePayload({ ...BASE })))
  assert.ok(!("chainId" in buildSwapRoutePayload({ ...BASE, chainId: undefined })))
  assert.ok(!("chainId" in buildSwapRoutePayload({ ...BASE, chainId: null })))
})
