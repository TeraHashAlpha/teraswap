// Tests for backfill-execution.mjs's pure/injectable helpers — [FIX-BACKFILL-EXECUTION-NUMBER-AND-TIMESTAMP].
//
// Pattern mirrors list-missing-fills.test.mjs / record-execution.test.mjs: import the exported pure
// functions directly (no live RPC, no live Supabase, no real network — computeExecutionNumber takes
// injected getLogs/getLatestBlock/getBlockTimestamp, same shape as list-missing-fills.mjs's
// scanLogsChunked/resolveBlockFromTimestamp, which it reuses internally).

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import { computeExecutionNumber, computeOrderPatch, resolveRepairTarget, canRepair } from "./backfill-execution.mjs"

// ---- (a) + (b) computeExecutionNumber — chain-derived, order-of-input-independent ------------

describe("computeExecutionNumber — 1-based rank by (blockNumber, logIndex)", () => {
  // Three fills of ONE order in blocks 10/20/30.
  const LOGS = [
    { blockNumber: 10, logIndex: 0, transactionHash: "0xAAA1" },
    { blockNumber: 20, logIndex: 0, transactionHash: "0xAAA2" },
    { blockNumber: 30, logIndex: 0, transactionHash: "0xAAA3" },
  ]

  function computeFor(txHash) {
    return computeExecutionNumber({
      orderHash: "0xorder",
      txHash,
      sinceTs: undefined,
      chunkSize: 1000,
      getLogs: async () => LOGS,
      getLatestBlock: async () => 100,
      getBlockTimestamp: async () => 0,
    })
  }

  test("(a) three fills in blocks 10/20/30 get numbers 1/2/3, whatever order the hashes are queried in", async () => {
    // Query out of order (3rd, then 1st, then 2nd) — the result must depend only on chain
    // position, never on the order backfill happens to process hashes in.
    const r3 = await computeFor("0xaaa3")
    const r1 = await computeFor("0xaaa1")
    const r2 = await computeFor("0xaaa2")
    assert.equal(r1.executionNumber, 1)
    assert.equal(r2.executionNumber, 2)
    assert.equal(r3.executionNumber, 3)
    assert.equal(r3.totalOnChain, 3)
  })

  test("case-insensitive tx hash match", async () => {
    const r = await computeFor("0xAAA2")
    assert.equal(r.executionNumber, 2)
  })

  test("logIndex breaks ties within the same block", async () => {
    const sameBlock = [
      { blockNumber: 5, logIndex: 3, transactionHash: "0xlater" },
      { blockNumber: 5, logIndex: 1, transactionHash: "0xearlier" },
    ]
    const r = await computeExecutionNumber({
      orderHash: "0xorder",
      txHash: "0xearlier",
      chunkSize: 1000,
      getLogs: async () => sameBlock,
      getLatestBlock: async () => 100,
      getBlockTimestamp: async () => 0,
    })
    assert.equal(r.executionNumber, 1)
  })

  test("throws when the tx is not among the on-chain OrderExecuted logs for this order", async () => {
    await assert.rejects(() => computeFor("0xdeadbeef"), /not found/)
  })

  test("sinceTs bounds the scan via resolveBlockFromTimestamp (fromBlock derived, not 0)", async () => {
    const seenRanges = []
    await computeExecutionNumber({
      orderHash: "0xorder",
      txHash: "0xaaa2",
      sinceTs: 500,
      chunkSize: 1000,
      getLogs: async (from, to) => {
        seenRanges.push([from, to])
        return LOGS
      },
      getLatestBlock: async () => 100,
      // Blocks 0..99 have timestamp = block number * 10 → block 50 is the first >= 500.
      getBlockTimestamp: async (n) => n * 10,
    })
    assert.equal(seenRanges.length, 1)
    assert.equal(seenRanges[0][0], 50)
  })
})

// ---- (c) resolveRepairTarget — exactly-one-row guard -------------------------------------------

describe("resolveRepairTarget — --repair only ever patches a uniquely-identified row", () => {
  test("(c) exactly one existing row → ok, returns it", () => {
    const r = resolveRepairTarget([{ id: "row-1" }])
    assert.equal(r.ok, true)
    assert.equal(r.row.id, "row-1")
  })
  test("(c) zero existing rows → refuses", () => {
    const r = resolveRepairTarget([])
    assert.equal(r.ok, false)
    assert.equal(r.count, 0)
  })
  test("(c) two existing rows → refuses", () => {
    const r = resolveRepairTarget([{ id: "row-1" }, { id: "row-2" }])
    assert.equal(r.ok, false)
    assert.equal(r.count, 2)
  })
  test("(c) non-array response → refuses without throwing", () => {
    const r = resolveRepairTarget(null)
    assert.equal(r.ok, false)
    assert.equal(r.count, 0)
  })
})

describe("canRepair — --repair refuses to patch execution_number without created_at", () => {
  test("refuses when the block timestamp could not be fetched (null), allows when present", () => {
    assert.equal(canRepair(null), false)
    assert.equal(canRepair(1577836800), true)
  })
})

// ---- computeOrderPatch — generalizes the old hard-coded-1 orderPatch logic ---------------------

describe("computeOrderPatch — parent-order transition for a chain-derived execution number", () => {
  test("DCA 3rd-of-3 chunk completes the order", () => {
    const order = { order_type: "dca", status: "active", dca_executed: 1, dca_total: 3, dca_last_exec: null }
    const patch = computeOrderPatch({ order, executionNumber: 3, blockIso: "2026-01-01T00:00:00.000Z" })
    assert.equal(patch.status, "executed")
    assert.equal(patch.dca_executed, 3)
    assert.equal(patch.dca_last_exec, "2026-01-01T00:00:00.000Z")
  })
  test("DCA 2nd-of-3 chunk stays active", () => {
    const order = { order_type: "dca", status: "active", dca_executed: 0, dca_total: 3, dca_last_exec: null }
    const patch = computeOrderPatch({ order, executionNumber: 2, blockIso: "2026-01-01T00:00:00.000Z" })
    assert.equal(patch.status, "active")
    assert.equal(patch.dca_executed, 2)
  })
  test("never reactivates a terminal order (cancelled stays cancelled)", () => {
    const order = { order_type: "dca", status: "cancelled", dca_executed: 1, dca_total: 3 }
    const patch = computeOrderPatch({ order, executionNumber: 2, blockIso: null })
    assert.equal("status" in patch, false)
  })
  test("never regresses an already-set dca_last_exec", () => {
    const order = { order_type: "dca", status: "active", dca_executed: 0, dca_total: 3, dca_last_exec: "2020-01-01T00:00:00.000Z" }
    const patch = computeOrderPatch({ order, executionNumber: 1, blockIso: "2026-01-01T00:00:00.000Z" })
    assert.equal("dca_last_exec" in patch, false)
  })
})
