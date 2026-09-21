// Tests for list-missing-fills.mjs — the read-only on-chain vs order_executions diff scanner.
//
// Pattern mirrors record-execution.test.mjs: import the pure/injectable functions directly (no
// live RPC, no live Supabase, no real network). The decode fixture (makeOrderExecutedLog) is
// reused from record-execution.test.mjs rather than redeclaring the OrderExecuted ABI.

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import { CONTRACT, makeOrderExecutedLog } from "./record-execution.test.mjs"
import { ChainVerificationError } from "./chain-verify.js"
import {
  USAGE,
  parseArgs,
  maskRpcUrl,
  formatBootLine,
  formatTable,
  formatSummaryLine,
  scanLogsChunked,
  diffMissing,
  buildRowFromLog,
  runScan,
} from "./list-missing-fills.mjs"

// ---- CLI usage / parseArgs ---------------------------------------------

describe("parseArgs / USAGE", () => {
  test("USAGE names both --from-block and --from-ts", () => {
    assert.match(USAGE, /--from-block/)
    assert.match(USAGE, /--from-ts/)
    assert.match(USAGE, /--out/)
  })
  test("parses --from-block and --out", () => {
    assert.deepEqual(parseArgs(["--from-block", "100", "--out", "./x.txt"]), {
      fromBlock: "100",
      out: "./x.txt",
    })
  })
  test("parses --from-ts", () => {
    assert.deepEqual(parseArgs(["--from-ts", "1753228800"]), { fromTs: "1753228800" })
  })
})

// ---- (a) chunking: full coverage, no gaps/overlaps, single retry on range error ----

describe("scanLogsChunked — contiguous chunk coverage + bounded single retry", () => {
  test("covers [fromBlock, toBlock] with no gaps or overlaps", async () => {
    const seen = []
    async function getLogs(from, to) {
      seen.push([from, to])
      return []
    }
    await scanLogsChunked({ getLogs, fromBlock: 0, toBlock: 25, chunkSize: 10 })
    assert.deepEqual(seen, [
      [0, 9],
      [10, 19],
      [20, 25],
    ])
  })

  test("retries once on a range error by halving the chunk, then continues at the original size", async () => {
    const seen = []
    let failedOnce = false
    async function getLogs(from, to) {
      seen.push([from, to])
      if (from === 0 && to === 9 && !failedOnce) {
        failedOnce = true
        throw new Error("block range exceeded")
      }
      return []
    }
    await scanLogsChunked({ getLogs, fromBlock: 0, toBlock: 25, chunkSize: 10 })
    // First attempt at [0,9] fails; retried at half size [0,4]; then the scan resumes at the
    // ORIGINAL chunk size for [5,25] — no gap, no overlap, no permanent shrink from one hiccup.
    assert.deepEqual(seen, [
      [0, 9],
      [0, 4],
      [5, 14],
      [15, 24],
      [25, 25],
    ])
  })

  test("a second failure on the retried (halved) range propagates — never silently skips a range", async () => {
    async function getLogs() {
      throw new Error("block range exceeded")
    }
    await assert.rejects(
      () => scanLogsChunked({ getLogs, fromBlock: 0, toBlock: 9, chunkSize: 10 }),
      /block range exceeded/,
    )
  })

  test("refuses a non-positive chunk size", async () => {
    await assert.rejects(
      () => scanLogsChunked({ getLogs: async () => [], fromBlock: 0, toBlock: 10, chunkSize: 0 }),
      /LOGS_CHUNK must be a positive number/,
    )
  })
})

// ---- (b) diff logic: on-chain vs recorded, ordered by block ------------

describe("diffMissing — on-chain fills vs recorded tx_hash set", () => {
  function row(blockNumber, txHash) {
    return { blockNumber, txHash, orderHash: "0x" + "ab".repeat(32), amountIn: "1", amountOut: "2" }
  }

  test("5 on-chain, 3 recorded -> 2 missing, correct hashes, ordered by block", () => {
    const onChain = [
      row(50, "0xaaaa"),
      row(10, "0xbbbb"),
      row(30, "0xcccc"),
      row(20, "0xdddd"),
      row(40, "0xeeee"),
    ]
    const recordedTxHashes = ["0xbbbb", "0xdddd", "0xeeee"]
    const result = diffMissing({ onChain, recordedTxHashes })
    assert.equal(result.onChainCount, 5)
    assert.equal(result.recordedCount, 3)
    assert.equal(result.missingCount, 2)
    assert.deepEqual(
      result.missing.map((r) => r.txHash),
      ["0xcccc", "0xaaaa"], // block 30 then block 50 — ordered by block, not input order
    )
    // rows are ordered by block ascending
    assert.deepEqual(
      result.rows.map((r) => r.blockNumber),
      [10, 20, 30, 40, 50],
    )
  })

  test("tx_hash comparison is case-insensitive", () => {
    const onChain = [row(1, "0xABCDEF")]
    const result = diffMissing({ onChain, recordedTxHashes: ["0xabcdef"] })
    assert.equal(result.missingCount, 0)
    assert.equal(result.recordedCount, 1)
  })

  test("empty recorded set -> everything missing", () => {
    const onChain = [row(1, "0x1"), row(2, "0x2")]
    const result = diffMissing({ onChain, recordedTxHashes: [] })
    assert.equal(result.missingCount, 2)
    assert.equal(result.recordedCount, 0)
  })
})

// ---- decode via the SAME decoder record-execution.js uses ---------------

describe("buildRowFromLog — decodes via record-execution.js's decodeOrderExecuted (no ABI redeclaration)", () => {
  test("builds a row from a real OrderExecuted log fixture", () => {
    const log = {
      ...makeOrderExecutedLog({ amountIn: 111n, amountOut: 222n, fee: 3n }),
      blockNumber: 123n,
      transactionHash: "0xfeed",
    }
    const r = buildRowFromLog(log, CONTRACT)
    assert.ok(r)
    assert.equal(r.blockNumber, 123)
    assert.equal(r.txHash, "0xfeed")
    assert.equal(r.amountIn, "111")
    assert.equal(r.amountOut, "222")
  })

  test("returns null for a log that is not OrderExecuted", () => {
    const log = { address: CONTRACT, topics: ["0x" + "cd".repeat(32)], data: "0x", blockNumber: 1n, transactionHash: "0x1" }
    assert.equal(buildRowFromLog(log, CONTRACT), null)
  })
})

// ---- (c) chain mismatch refuses before any getLogs -----------------------

describe("runScan — chain-verify gate runs BEFORE any getLogs call", () => {
  function fakeProvider({ chainId = 1 } = {}) {
    return {
      getChainId: async () => chainId,
      getCode: async () => "0x1234",
      readContract: async () => "0x" + "11".repeat(32),
    }
  }

  test("chain mismatch throws ChainVerificationError and getLogs is never called", async () => {
    let getLogsCalls = 0
    const getLogs = async () => {
      getLogsCalls++
      return []
    }
    await assert.rejects(
      () =>
        runScan({
          provider: fakeProvider({ chainId: 999 }), // does not match chainId below
          chainId: 8453,
          executorAddress: CONTRACT,
          expectedOrderTypehash: "0x" + "11".repeat(32),
          fromBlock: 0,
          toBlock: 100,
          getLogs,
          chunkSize: 50,
        }),
      ChainVerificationError,
    )
    assert.equal(getLogsCalls, 0, "getLogs must never be called when the chain check fails")
  })

  test("matching chain + identity proceeds to scan and decode logs", async () => {
    const log = {
      ...makeOrderExecutedLog({ amountIn: 5n, amountOut: 6n, fee: 0n }),
      blockNumber: 42n,
      transactionHash: "0xdeadbeef",
    }
    const expectedTypehash = "0x" + "11".repeat(32)
    const result = await runScan({
      provider: fakeProvider({ chainId: 8453 }),
      chainId: 8453,
      executorAddress: CONTRACT,
      expectedOrderTypehash: expectedTypehash,
      fromBlock: 0,
      toBlock: 100,
      getLogs: async () => [log],
      chunkSize: 200, // whole range fits one chunk — the fake returns the fixture once, not per-chunk
    })
    assert.equal(result.verified.chainId, 8453)
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0].txHash, "0xdeadbeef")
  })
})

// ---- (d) no env value ever appears in stdout -----------------------------

describe("no secret/env value ever reaches a print line", () => {
  test("maskRpcUrl always returns the flat mask, regardless of what the real RPC_URL looks like", () => {
    const secretMarker = "SUPER-SECRET-RPC-KEY-DO-NOT-LEAK"
    process.env.RPC_URL = `https://mainnet.example.com/v2/${secretMarker}`
    try {
      const masked = maskRpcUrl()
      assert.equal(masked, "<provider>")
      assert.doesNotMatch(masked, new RegExp(secretMarker))
    } finally {
      delete process.env.RPC_URL
    }
  })

  test("formatBootLine / formatTable / formatSummaryLine never take RPC_URL or Supabase creds as input", () => {
    // These functions' signatures only accept chain-derived / decoded data — proven here by
    // feeding them fixtures built from marker-tagged fake env values and asserting the markers
    // never appear in the rendered output.
    const rpcMarker = "MARKER-RPC-abc123"
    const supaUrlMarker = "MARKER-SUPA-URL-def456"
    const supaKeyMarker = "MARKER-SUPA-KEY-ghi789"
    process.env.RPC_URL = `https://provider.example/${rpcMarker}`
    process.env.SUPABASE_URL = `https://${supaUrlMarker}.supabase.co`
    process.env.SUPABASE_SERVICE_ROLE_KEY = supaKeyMarker
    try {
      const bootLine = formatBootLine({ chainId: 8453, address: CONTRACT, codeSize: 4096 })
      const table = formatTable([
        { blockNumber: 1, txHash: "0xabc", orderHash: "0x" + "ab".repeat(32), amountIn: "1", amountOut: "2", recorded: false },
      ])
      const summary = formatSummaryLine({ onChainCount: 1, recordedCount: 0, missingCount: 1 })
      const rendered = [bootLine, table, summary].join("\n")
      for (const marker of [rpcMarker, supaUrlMarker, supaKeyMarker]) {
        assert.doesNotMatch(rendered, new RegExp(marker), `leaked env value fragment: ${marker}`)
      }
    } finally {
      delete process.env.RPC_URL
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_SERVICE_ROLE_KEY
    }
  })

  test("runScan's injected `log` callback never receives an RPC URL or Supabase credential", async () => {
    const rpcMarker = "MARKER-RPC-runscan-xyz"
    process.env.RPC_URL = `https://provider.example/${rpcMarker}`
    const captured = []
    try {
      await runScan({
        provider: {
          getChainId: async () => 8453,
          getCode: async () => "0x1234",
          readContract: async () => "0x" + "11".repeat(32),
        },
        chainId: 8453,
        executorAddress: CONTRACT,
        expectedOrderTypehash: "0x" + "11".repeat(32),
        fromBlock: 0,
        toBlock: 0,
        getLogs: async () => [],
        chunkSize: 50,
        log: (msg) => captured.push(msg),
      })
      for (const line of captured) {
        assert.doesNotMatch(String(line), new RegExp(rpcMarker))
      }
    } finally {
      delete process.env.RPC_URL
    }
  })
})
