// Tests for record-execution.js — the pure helpers that turn a CONFIRMED
// executeOrder receipt into ONE idempotent order_executions row + the parent
// order's exec-count/status transition.
//
// Pattern mirrors swap-route.test.mjs / revert-decode.test.mjs: import the pure
// functions, build real viem fixtures (no network, no Supabase, no provider),
// assert on returned values. The Supabase write is tested via an INJECTED
// supabaseFetch fake (dependency injection) so executor.js (which auto-runs
// main() on import) is never imported.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { encodeEventTopics, encodeAbiParameters } from "viem"

import {
  ORDER_EXECUTED_EVENT,
  decodeOrderExecuted,
  shouldRecord,
  executionNumberFor,
  nextOrderStatus,
  perChunkAmountIn,
  buildExecutionRow,
  recordExecutionRow,
} from "./record-execution.js"

// ---- fixtures ----------------------------------------------------------

const CONTRACT = "0x000000000000000000000000000000000000c0de"

// Build a real OrderExecuted log the way the OrderExecutor contract emits it,
// so decodeOrderExecuted round-trips it through viem's decodeEventLog.
function makeOrderExecutedLog({
  address = CONTRACT,
  orderHash = "0x" + "ab".repeat(32),
  owner = "0x2222222222222222222222222222222222222222",
  orderType = 2, // DCA
  tokenIn = "0x3333333333333333333333333333333333333333",
  tokenOut = "0x4444444444444444444444444444444444444444",
  amountIn = 1000000n,
  amountOut = 2000000n,
  fee = 1000n,
} = {}) {
  const topics = encodeEventTopics({
    abi: [ORDER_EXECUTED_EVENT],
    eventName: "OrderExecuted",
    args: { orderHash, owner, orderType },
  })
  const data = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [tokenIn, tokenOut, amountIn, amountOut, fee],
  )
  return { address, topics, data }
}

// A log from the same contract that is NOT OrderExecuted (different topic0).
function makeJunkLog(address = CONTRACT) {
  return { address, topics: ["0x" + "cd".repeat(32)], data: "0x" }
}

// Injected Supabase fake: differentiates the idempotency GET
// ("order_executions?...") from the insert POST ("order_executions").
function makeFakeSupabase({ existing = [], postOk = true, postStatus = 201 } = {}) {
  const calls = []
  async function supabaseFetch(path, options = {}) {
    calls.push({ path, options })
    if (typeof path === "string" && path.includes("?")) {
      return {
        ok: true,
        status: 200,
        json: async () => existing,
        text: async () => JSON.stringify(existing),
      }
    }
    return {
      ok: postOk,
      status: postStatus,
      json: async () => ({}),
      text: async () => (postOk ? "" : "duplicate key value violates unique constraint"),
    }
  }
  return { supabaseFetch, calls }
}

// ---- shouldRecord: confirmed-only --------------------------------------

describe("shouldRecord — confirmed-only (never record un-confirmed txs)", () => {
  test("records when receipt.status === 'success'", () => {
    assert.equal(shouldRecord({ status: "success" }), true)
  })
  test("does NOT record a reverted tx", () => {
    assert.equal(shouldRecord({ status: "reverted" }), false)
  })
  test("does NOT record a missing/undefined receipt", () => {
    assert.equal(shouldRecord(undefined), false)
    assert.equal(shouldRecord(null), false)
  })
})

// ---- executionNumberFor ------------------------------------------------

describe("executionNumberFor — 1-based fill index", () => {
  test("DCA first chunk (dca_executed=0) → 1", () => {
    assert.equal(executionNumberFor({ order_type: "dca", dca_executed: 0, dca_total: 3 }), 1)
  })
  test("DCA third chunk (dca_executed=2) → 3", () => {
    assert.equal(executionNumberFor({ order_type: "dca", dca_executed: 2, dca_total: 3 }), 3)
  })
  test("limit order → 1", () => {
    assert.equal(executionNumberFor({ order_type: "limit" }), 1)
  })
  test("stop_loss order → 1", () => {
    assert.equal(executionNumberFor({ order_type: "stop_loss" }), 1)
  })
})

// ---- nextOrderStatus — exec-count/status transition --------------------

describe("nextOrderStatus — advance parent order (active→completed on last chunk)", () => {
  test("DCA mid-cycle re-arms to active and bumps dca_executed", () => {
    const r = nextOrderStatus({ order_type: "dca", dca_executed: 0, dca_total: 3 })
    assert.deepEqual(r, { status: "active", dca_executed: 1, complete: false })
  })
  test("DCA final chunk completes (status executed)", () => {
    const r = nextOrderStatus({ order_type: "dca", dca_executed: 2, dca_total: 3 })
    assert.deepEqual(r, { status: "executed", dca_executed: 3, complete: true })
  })
  test("DCA single-chunk (dca_total=1) completes on first fill", () => {
    const r = nextOrderStatus({ order_type: "dca", dca_executed: 0, dca_total: 1 })
    assert.deepEqual(r, { status: "executed", dca_executed: 1, complete: true })
  })
  test("limit/stop_loss completes immediately (no dca_executed)", () => {
    assert.deepEqual(nextOrderStatus({ order_type: "limit" }), { status: "executed", complete: true })
    assert.deepEqual(nextOrderStatus({ order_type: "stop_loss" }), { status: "executed", complete: true })
  })
})

// ---- perChunkAmountIn (fallback only) ----------------------------------

describe("perChunkAmountIn — floor(total / dca_total), matches analytics perChunkAmount", () => {
  test("DCA splits the total evenly (floor)", () => {
    assert.equal(perChunkAmountIn({ amount_in: "1000", dca_total: 3 }), "333")
  })
  test("limit (no dca_total) → full amount", () => {
    assert.equal(perChunkAmountIn({ amount_in: "1000" }), "1000")
  })
  test("invalid amount_in → '0' (never throws)", () => {
    assert.equal(perChunkAmountIn({ amount_in: undefined, dca_total: 3 }), "0")
  })
})

// ---- decodeOrderExecuted -----------------------------------------------

describe("decodeOrderExecuted — authoritative per-chunk amounts from the on-chain event", () => {
  test("decodes amountIn / amountOut / fee from the OrderExecuted log", () => {
    const log = makeOrderExecutedLog({ amountIn: 111n, amountOut: 222n, fee: 3n })
    const d = decodeOrderExecuted([log], CONTRACT)
    assert.ok(d)
    assert.equal(d.amountIn, "111")
    assert.equal(d.amountOut, "222")
    assert.equal(d.fee, "3")
    assert.equal(d.tokenIn.toLowerCase(), "0x3333333333333333333333333333333333333333")
  })
  test("finds the OrderExecuted log among junk logs from the same contract", () => {
    const logs = [makeJunkLog(), makeOrderExecutedLog({ amountOut: 999n }), makeJunkLog()]
    const d = decodeOrderExecuted(logs, CONTRACT)
    assert.ok(d)
    assert.equal(d.amountOut, "999")
  })
  test("ignores an OrderExecuted log emitted by a DIFFERENT address", () => {
    const log = makeOrderExecutedLog({ address: "0x000000000000000000000000000000000000dead" })
    assert.equal(decodeOrderExecuted([log], CONTRACT), null)
  })
  test("returns null for empty / missing logs", () => {
    assert.equal(decodeOrderExecuted([], CONTRACT), null)
    assert.equal(decodeOrderExecuted(null, CONTRACT), null)
    assert.equal(decodeOrderExecuted([makeJunkLog()], CONTRACT), null)
  })
  test("case-insensitive contract address match", () => {
    const d = decodeOrderExecuted([makeOrderExecutedLog()], CONTRACT.toUpperCase())
    assert.ok(d)
  })
})

// ---- buildExecutionRow -------------------------------------------------

describe("buildExecutionRow — schema-valid row (all NOT-NULL cols, no phantom executed_at)", () => {
  const dbOrder = { id: "order-uuid", order_type: "dca", dca_executed: 0, dca_total: 3, amount_in: "3000" }
  const receipt = { status: "success", gasUsed: 21000n, logs: [] }

  test("populates every NOT-NULL column required by order_executions", () => {
    const decoded = { amountIn: "1000", amountOut: "2000", fee: "1" }
    const row = buildExecutionRow({ dbOrder, txHash: "0xfeed", receipt, decoded })
    assert.equal(row.order_id, "order-uuid")
    assert.equal(row.execution_number, 1)
    assert.equal(row.tx_hash, "0xfeed")
    assert.equal(row.amount_in, "1000")
    assert.equal(row.amount_out, "2000")
    assert.equal(row.fee_amount, "1")
    assert.equal(row.gas_used, "21000")
    assert.equal(row.status, "confirmed")
  })
  test("uses the decoded event amounts (per-chunk), NOT the order total", () => {
    const decoded = { amountIn: "1000", amountOut: "2000", fee: "1" }
    const row = buildExecutionRow({ dbOrder, txHash: "0xfeed", receipt, decoded })
    assert.equal(row.amount_in, "1000") // decoded per-chunk, not the 3000 total
  })
  test("NEVER writes the phantom executed_at column that 400'd the old insert", () => {
    const row = buildExecutionRow({ dbOrder, txHash: "0xfeed", receipt, decoded: null })
    assert.equal("executed_at" in row, false)
  })
  test("falls back to per-chunk amount_in and '0' out/fee when the event can't be decoded (no fabricated USD)", () => {
    const row = buildExecutionRow({ dbOrder, txHash: "0xfeed", receipt, decoded: null })
    assert.equal(row.amount_in, "1000") // 3000 / 3
    assert.equal(row.amount_out, "0")
    assert.equal(row.fee_amount, "0")
  })
  test("execution_number follows the DCA fill index", () => {
    const row = buildExecutionRow({
      dbOrder: { ...dbOrder, dca_executed: 2 },
      txHash: "0xfeed",
      receipt,
      decoded: { amountIn: "1", amountOut: "1", fee: "0" },
    })
    assert.equal(row.execution_number, 3)
  })
})

// ---- [CHORE-DCA-AGGREGATION-VALUE] next_best_out / next_best_source ----

describe("buildExecutionRow — additive next_best_out/next_best_source (CHORE-DCA-AGGREGATION-VALUE)", () => {
  const dbOrder = { id: "order-uuid", order_type: "dca", dca_executed: 0, dca_total: 3, amount_in: "3000" }
  const receipt = { status: "success", gasUsed: 21000n, logs: [] }
  const decoded = { amountIn: "1000", amountOut: "2000", fee: "1" }

  test("sets both columns when a runner-up was captured", () => {
    const row = buildExecutionRow({
      dbOrder, txHash: "0xfeed", receipt, decoded,
      nextBestOut: "1950", nextBestSource: "1inch",
    })
    assert.equal(row.next_best_out, "1950")
    assert.equal(row.next_best_source, "1inch")
  })

  test("omits both columns (never writes null explicitly, never fabricates) when no runner-up existed", () => {
    const row = buildExecutionRow({
      dbOrder, txHash: "0xfeed", receipt, decoded,
      nextBestOut: null, nextBestSource: null,
    })
    assert.equal("next_best_out" in row, false)
    assert.equal("next_best_source" in row, false)
  })

  test("omits both columns when the params are absent entirely (non-DCA fills never pass them)", () => {
    const row = buildExecutionRow({ dbOrder, txHash: "0xfeed", receipt, decoded })
    assert.equal("next_best_out" in row, false)
    assert.equal("next_best_source" in row, false)
  })

  test("a present nextBestOut with a missing nextBestSource (malformed pair) sets NEITHER column", () => {
    // Defence in depth: never persist an amount without its source label, or vice versa.
    const row = buildExecutionRow({
      dbOrder, txHash: "0xfeed", receipt, decoded,
      nextBestOut: "1950", nextBestSource: null,
    })
    assert.equal("next_best_out" in row, false)
    assert.equal("next_best_source" in row, false)
  })

  test("does not disturb any existing NOT-NULL column", () => {
    const row = buildExecutionRow({
      dbOrder, txHash: "0xfeed", receipt, decoded,
      nextBestOut: "1950", nextBestSource: "1inch",
    })
    assert.equal(row.order_id, "order-uuid")
    assert.equal(row.amount_out, "2000")
    assert.equal(row.status, "confirmed")
  })
})

// ---- recordExecutionRow — idempotent insert ----------------------------

describe("recordExecutionRow — idempotent (keyed by tx_hash), checks res.ok", () => {
  const row = {
    order_id: "order-uuid",
    execution_number: 1,
    tx_hash: "0xdeadbeef",
    amount_in: "1000",
    amount_out: "2000",
    fee_amount: "1",
    gas_used: "21000",
    status: "confirmed",
  }

  test("inserts exactly one row when none exists for this tx_hash", async () => {
    const { supabaseFetch, calls } = makeFakeSupabase({ existing: [] })
    const result = await recordExecutionRow(supabaseFetch, row)
    assert.equal(result.recorded, true)
    const posts = calls.filter((c) => c.options.method === "POST")
    assert.equal(posts.length, 1)
    assert.deepEqual(JSON.parse(posts[0].options.body), row)
  })

  test("idempotency key is tx_hash — the dedup GET filters on it", async () => {
    const { supabaseFetch, calls } = makeFakeSupabase({ existing: [] })
    await recordExecutionRow(supabaseFetch, row)
    const get = calls.find((c) => !c.options.method || c.options.method === "GET")
    assert.ok(get, "expected an idempotency GET")
    assert.ok(get.path.includes("tx_hash=eq.0xdeadbeef"))
  })

  test("does NOT insert a duplicate when a row with this tx_hash already exists", async () => {
    const { supabaseFetch, calls } = makeFakeSupabase({ existing: [{ id: "already-here" }] })
    const result = await recordExecutionRow(supabaseFetch, row)
    assert.equal(result.recorded, false)
    assert.equal(result.reason, "duplicate")
    const posts = calls.filter((c) => c.options.method === "POST")
    assert.equal(posts.length, 0)
  })

  test("surfaces a failed insert instead of swallowing it (the original bug)", async () => {
    const { supabaseFetch } = makeFakeSupabase({ existing: [], postOk: false, postStatus: 400 })
    const result = await recordExecutionRow(supabaseFetch, row)
    assert.equal(result.recorded, false)
    assert.ok(result.error, "expected an error to be reported, not swallowed")
  })

  // [CHORE-DCA-AGGREGATION-VALUE] The fill has ALREADY been confirmed on-chain by the time
  // executor.js calls recordExecutionRow (it runs in the post-execution block, after
  // `executed++`'s preceding tx-success branch) — recording is best-effort telemetry, and
  // executor.js's call site does NOT wrap it in try/catch. The only way a write failure could
  // ever affect a fill is if this function THREW instead of resolving with an error object; it
  // must not, on any failure mode.
  test("a hard network failure (fetch rejects) resolves, never throws — proves recording can never crash/block a confirmed fill", async () => {
    async function throwingSupabaseFetch() {
      throw new Error("ECONNRESET")
    }
    let result
    await assert.doesNotReject(async () => {
      result = await recordExecutionRow(throwingSupabaseFetch, row)
    })
    assert.equal(result.recorded, false)
  })
})
