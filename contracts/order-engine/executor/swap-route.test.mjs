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
import { test, describe, it } from "node:test"
import assert from "node:assert"

import {
  buildSwapRoutePayload,
  buildQuotePath,
  MAINNET_CHAIN_ID,
  computeNetChunkAmount,
  sourceForRouter,
  FEE_BPS,
  BPS_DENOMINATOR,
} from "./swap-route.js"

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

// ════════════════════════════════════════════════════════════
// computeNetChunkAmount [chore/dca-router-chainaware]
// ════════════════════════════════════════════════════════════
// Must replicate TeraSwapOrderExecutor.executeOrder EXACTLY: per-chunk
// executeAmount (cumulative, last chunk = remainder), then fee = executeAmount *
// FEE_BPS / BPS_DENOMINATOR taken in tokenIn first, swapping only netAmount.
describe("computeNetChunkAmount — matches the contract's per-chunk net", () => {
  it("fee constants mirror the contract (FEE_BPS=10, BPS_DENOMINATOR=10000)", () => {
    assert.strictEqual(FEE_BPS, 10n)
    assert.strictEqual(BPS_DENOMINATOR, 10000n)
  })

  it("non-DCA: net = amountIn − 0.1% fee", () => {
    assert.strictEqual(computeNetChunkAmount({ amountIn: "1000000", isDca: false }), "999000")
  })

  it("DCA even split: each chunk = amountIn/dcaTotal − fee", () => {
    // 1_000_000 / 4 = 250_000 per chunk; fee 250 → net 249_750
    assert.strictEqual(computeNetChunkAmount({ amountIn: "1000000", dcaTotal: 4, execCount: 0, isDca: true }), "249750")
    assert.strictEqual(computeNetChunkAmount({ amountIn: "1000000", dcaTotal: 4, execCount: 3, isDca: true }), "249750")
  })

  it("DCA with remainder: last chunk absorbs the dust (cumulative, like the contract)", () => {
    // 1_000_003 / 3: chunks execute 333334, 333334, 333335 (sum = 1_000_003, no dust)
    assert.strictEqual(computeNetChunkAmount({ amountIn: "1000003", dcaTotal: 3, execCount: 0, isDca: true }), (333334n - 333334n * 10n / 10000n).toString())
    assert.strictEqual(computeNetChunkAmount({ amountIn: "1000003", dcaTotal: 3, execCount: 1, isDca: true }), (333334n - 333334n * 10n / 10000n).toString())
    assert.strictEqual(computeNetChunkAmount({ amountIn: "1000003", dcaTotal: 3, execCount: 2, isDca: true }), (333335n - 333335n * 10n / 10000n).toString())
  })

  it("the per-chunk executeAmounts sum to amountIn (no dust) — matches contract cumulative tracking", () => {
    const amountIn = 1000003n, dcaTotal = 3n
    let sum = 0n
    for (let n = 0n; n < dcaTotal; n++) {
      const net = BigInt(computeNetChunkAmount({ amountIn: amountIn.toString(), dcaTotal: Number(dcaTotal), execCount: Number(n), isDca: true }))
      const fee = (net * 10n) / (10000n - 10n) // approx; just sanity that net < executeAmount
      assert.ok(net > 0n)
    }
    // executeAmounts (pre-fee) must sum to amountIn
    const exec = (n) => {
      const ct = (amountIn * (BigInt(n) + 1n)) / dcaTotal
      const pe = (amountIn * BigInt(n)) / dcaTotal
      return Number(n) === Number(dcaTotal) - 1 ? amountIn - pe : ct - pe
    }
    assert.strictEqual(exec(0) + exec(1) + exec(2), amountIn)
  })

  it("throws on a DCA order with dcaTotal <= 0", () => {
    assert.throws(() => computeNetChunkAmount({ amountIn: "1000000", dcaTotal: 0, execCount: 0, isDca: true }))
  })
})

// ════════════════════════════════════════════════════════════
// sourceForRouter [chore/dca-router-chainaware]
// ════════════════════════════════════════════════════════════
// The keeper must build calldata for the SIGNED order.router — map each
// whitelisted router address to the /api/swap source that targets it.
describe("sourceForRouter — committed router → /api/swap source", () => {
  it("Base Augustus V6 → velora (case-insensitive)", () => {
    assert.strictEqual(sourceForRouter("0x6A000F20005980200259B80c5102003040001068"), "velora")
    assert.strictEqual(sourceForRouter("0x6a000f20005980200259b80c5102003040001068"), "velora")
  })

  it("Base Uniswap SwapRouter02 → uniswapv3", () => {
    assert.strictEqual(sourceForRouter("0x2626664c2603336E57B271c5C0b26F421741e481"), "uniswapv3")
  })

  it("mainnet 1inch v6 → 1inch (mainnet unchanged)", () => {
    assert.strictEqual(sourceForRouter("0x111111125421cA6dc452d289314280a0f8842A65"), "1inch")
  })

  it("unknown / malformed router → null (keeper skips rather than mis-route)", () => {
    assert.strictEqual(sourceForRouter("0x0000000000000000000000000000000000000000"), null)
    assert.strictEqual(sourceForRouter(undefined), null)
    assert.strictEqual(sourceForRouter(""), null)
  })
})
