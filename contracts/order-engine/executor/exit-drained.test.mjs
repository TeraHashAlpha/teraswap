// [fix/script-stdout-truncated-on-exit] The operator CLIs must not lose stdout when they end.
//
// stdout is a pipe nobody reads until the CLI has produced everything (held-back-reader.mjs: the reader starts when the CLI's stderr
// shows its last message), which is what a slow `| tee`, `| less` or CI reader looks like. No sleep, no timer, no load.
//
//   1. the helper itself: 20,000 lines then exitAfterDrain(3) -> every line, exit code 3
//   2. list-missing-fills.mjs against a local RPC + Supabase stub: a table far bigger than a pipe, then a failure (the --out path is
//      a directory) -> the whole table and the summary line still arrive, exit code 1 (on the unfixed CLI the table is cut)
//   3. both CLIs' early refusals keep their text and exit code
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runWithHeldBackStdout, runWithHeldBackOutput } from "../../../scripts/lib/held-back-reader.mjs"
import { EXPECTED_ORDER_TYPEHASH_V3 } from "./chain-verify.js"
import { CONTRACT, makeOrderExecutedLog } from "./record-execution.test.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const LIST = join(HERE, "list-missing-fills.mjs")
const BACKFILL = join(HERE, "backfill-execution.mjs")
const DRAINED = join(HERE, "exit-drained.js")
const PRELOAD = resolve(HERE, "../../../scripts/lib/signal-at-exit-point.mjs")

// A child's environment: no inherited secrets or RPC settings that could change what a CLI does.
const cleanEnv = (extra) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra })
// The first import of each CLI warns on stderr when the working directory has no dotenv file; that line is not the CLI's own message.
const ownStderr = (stderr) => stderr.split("\n").filter((l) => !l.startsWith("WARNING: Could not load ")).join("\n")

describe("exitAfterDrain", () => {
  test("20,000 lines then exit code 3: every line arrives", async () => {
    const script = `
      import { exitAfterDrain } from ${JSON.stringify(DRAINED)}
      for (let i = 0; i < 20000; i++) console.log("line " + String(i).padStart(6, "0") + " " + "x".repeat(60))
      console.error("DONE-WRITING")
      exitAfterDrain(3)
    `
    const r = await runWithHeldBackStdout({
      command: process.execPath,
      args: ["--input-type=module", "-e", script],
      env: cleanEnv({}),
      releaseWhen: (stderr) => stderr.includes("DONE-WRITING"),
    })
    const lines = r.stdout.toString("utf8").split("\n").filter(Boolean)
    assert.equal(lines.length, 20000)
    assert.equal(lines[19999], "line 019999 " + "x".repeat(60))
    assert.equal(r.code, 3)
  })
})

// ── list-missing-fills.mjs end to end against stubs ───────────────────────────────────────────────
const N_LOGS = 3000 // ~150 bytes a table row: far more than the ~128 KB a pipe plus the reader's buffer hold

function startStub() {
  const logs = Array.from({ length: N_LOGS }, (_, i) => ({
    ...makeOrderExecutedLog({ orderHash: "0x" + (i + 1).toString(16).padStart(64, "0") }),
    blockNumber: "0x10",
    blockHash: "0x" + "11".repeat(32),
    transactionHash: "0x" + (i + 1).toString(16).padStart(64, "a"),
    transactionIndex: "0x0",
    logIndex: "0x" + i.toString(16),
    removed: false,
  }))
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.url && req.url.startsWith("/rest/v1/")) { res.end("[]"); return } // no execution is recorded: every fill is "missing"
      const call = JSON.parse(body)
      const result = {
        eth_blockNumber: "0x64",
        eth_chainId: "0x2105",
        eth_getCode: "0x6001",
        eth_call: EXPECTED_ORDER_TYPEHASH_V3,
        eth_getLogs: logs,
      }[call.method]
      res.end(JSON.stringify(result === undefined
        ? { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "no stub for " + call.method } }
        : { jsonrpc: "2.0", id: call.id, result }))
    })
  })
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)))
}

describe("list-missing-fills.mjs", () => {
  let server, base, work
  before(async () => {
    server = await startStub()
    base = `http://127.0.0.1:${server.address().port}`
    work = mkdtempSync(join(tmpdir(), "lmf-"))
    mkdirSync(join(work, "out-is-a-directory"))
  })
  after(() => { server.close(); rmSync(work, { recursive: true, force: true }) })

  test("a table bigger than a pipe, then a failing --out: the whole table and the summary line arrive, exit 1", async () => {
    const r = await runWithHeldBackStdout({
      command: process.execPath,
      args: [LIST, "--from-block", "1", "--out", "out-is-a-directory"],
      cwd: work,
      env: cleanEnv({
        RPC_URL: base,
        SUPABASE_URL: base,
        SUPABASE_SERVICE_ROLE_KEY: "stub-key",
        ORDER_EXECUTOR_V3_ADDRESS: CONTRACT,
        CHAIN_ID: "8453",
      }),
      releaseWhen: (stderr) => stderr.includes("FATAL:"),
    })
    const lines = r.stdout.toString("utf8").split("\n")
    assert.ok(r.stdout.length > 256 * 1024, `the table must overflow both buffers (got ${r.stdout.length} bytes)`)
    assert.ok(lines.includes(`on-chain=${N_LOGS} recorded=0 missing=${N_LOGS}`), `summary line missing; stderr: ${r.stderr.slice(0, 300)}`)
    assert.equal(lines.filter((l) => /\|\s+no$/.test(l)).length, N_LOGS)
    assert.equal(r.code, 1)
  })

  test("refusals keep their text and exit code 1", async () => {
    const noArgs = await runWithHeldBackStdout({ command: process.execPath, args: [LIST], cwd: work, env: cleanEnv({}), releaseWhen: () => true })
    assert.equal(noArgs.code, 1)
    assert.match(ownStderr(noArgs.stderr), /^Usage: node list-missing-fills\.mjs/)
    const noEnv = await runWithHeldBackStdout({ command: process.execPath, args: [LIST, "--from-block", "1"], cwd: work, env: cleanEnv({}), releaseWhen: () => true })
    assert.equal(noEnv.code, 1)
    assert.equal(ownStderr(noEnv.stderr), "FATAL: RPC_URL must be set in the environment.\n")
  })
})

// ── backfill-execution.mjs end to end against stubs ──────────────────────────────────────────────
// Its stdout is a dozen lines, EXCEPT the range-error retry lines of the log scan: one per chunk. A provider that refuses multi-block
// eth_getLogs ranges (stubbed) plus LOGS_CHUNK=2 makes one line per block; the default dry run then ends with an exit.
const FIRST_BLOCK = 24
const LATEST_BLOCK = 1024
const FILL_BLOCK = 600
const T0 = 1_700_000_000
const hex = (n) => "0x" + n.toString(16)
const BF_TX = "0x" + "aa".repeat(32)
const BF_ORDER_HASH = "0x" + "ab".repeat(32)

function startBackfillStub() {
  const fill = {
    ...makeOrderExecutedLog({ orderHash: BF_ORDER_HASH }),
    blockNumber: hex(FILL_BLOCK),
    blockHash: "0x" + "11".repeat(32),
    transactionHash: BF_TX,
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
  }
  const block = (n) => ({
    number: hex(n), hash: "0x" + "22".repeat(32), parentHash: "0x" + "33".repeat(32), timestamp: hex(T0 + 2 * n),
    transactions: [], uncles: [], gasLimit: "0x1", gasUsed: "0x0", miner: "0x" + "00".repeat(20), extraData: "0x", nonce: "0x0000000000000000",
    logsBloom: "0x" + "00".repeat(256), sha3Uncles: "0x" + "44".repeat(32), stateRoot: "0x" + "55".repeat(32),
    receiptsRoot: "0x" + "66".repeat(32), transactionsRoot: "0x" + "77".repeat(32), difficulty: "0x0", totalDifficulty: "0x0", size: "0x1",
  })
  const order = {
    id: "order-1", order_type: "dca", status: "active", dca_executed: 0, dca_total: 3, chain_id: 8453, router: "0x" + "99".repeat(20),
    token_in_symbol: "USDC", token_out_symbol: "WETH", created_at: new Date((T0 + 2 * FIRST_BLOCK) * 1000).toISOString(),
    amount_in: "3000000", order_hash: BF_ORDER_HASH,
  }
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.url && req.url.startsWith("/rest/v1/orders")) { res.end(JSON.stringify([order])); return }
      if (req.url && req.url.startsWith("/rest/v1/")) { res.end("[]"); return }
      const call = JSON.parse(body)
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }))
      const fail = (message) => res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message } }))
      const [p0] = call.params ?? []
      switch (call.method) {
        case "eth_getTransactionReceipt":
          return reply({
            status: "0x1", blockNumber: hex(FILL_BLOCK), blockHash: "0x" + "11".repeat(32), to: CONTRACT, from: "0x" + "88".repeat(20),
            gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", transactionHash: BF_TX, transactionIndex: "0x0",
            logsBloom: "0x" + "00".repeat(256), type: "0x2", contractAddress: null, logs: [fill],
          })
        case "eth_blockNumber": return reply(hex(LATEST_BLOCK))
        case "eth_getBlockByNumber": return reply(block(Number(BigInt(p0))))
        case "eth_getLogs": {
          const from = Number(BigInt(p0.fromBlock))
          const to = Number(BigInt(p0.toBlock))
          if (to > from) return fail("query returned more than 10000 results or range too large")
          return reply(from === FILL_BLOCK ? [fill] : [])
        }
        default: return fail("no stub for " + call.method)
      }
    })
  })
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)))
}

describe("backfill-execution.mjs, dry run with hundreds of scan-retry lines", () => {
  let server, base, work
  before(async () => {
    server = await startBackfillStub()
    base = `http://127.0.0.1:${server.address().port}`
    work = mkdtempSync(join(tmpdir(), "bfe-big-"))
  })
  after(() => { server.close(); rmSync(work, { recursive: true, force: true }) })

  test("every scan line, the dry-run notice and exit code 0 arrive", async () => {
    const r = await runWithHeldBackOutput({
      command: process.execPath,
      args: ["--import", PRELOAD, BACKFILL, BF_TX],
      cwd: work,
      env: cleanEnv({ SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: "stub-key", BACKFILL_RPC_URL: base, LOGS_CHUNK: "2" }),
    })
    const text = r.stdout.toString("utf8")
    assert.ok(r.signalled, `the exit point was never reached; stderr: ${r.stderr.toString("utf8").slice(0, 400)}`)
    assert.equal((text.match(/range error on /g) ?? []).length, LATEST_BLOCK - FIRST_BLOCK)
    assert.ok(text.includes("DRY RUN — nothing written"), "the dry-run notice (the last output) is missing")
    assert.ok(text.length > 200 * 1024, `the scan lines must overflow both buffers, or the lines above prove nothing (got ${text.length} bytes)`)
    assert.equal(r.code, 0)
  })
})

describe("backfill-execution.mjs", () => {
  test("refusals keep their text and exit code 1", async () => {
    const work = mkdtempSync(join(tmpdir(), "bfe-"))
    try {
      const noEnv = await runWithHeldBackStdout({ command: process.execPath, args: [BACKFILL, "0x" + "ab".repeat(32)], cwd: work, env: cleanEnv({}), releaseWhen: () => true })
      assert.equal(noEnv.code, 1)
      assert.equal(ownStderr(noEnv.stderr), "FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.\n")
      const noTx = await runWithHeldBackStdout({
        command: process.execPath, args: [BACKFILL], cwd: work,
        env: cleanEnv({ SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "k", BACKFILL_RPC_URL: "http://127.0.0.1:9" }),
        releaseWhen: () => true,
      })
      assert.equal(noTx.code, 1)
      assert.match(ownStderr(noTx.stderr), /^Usage: node backfill-execution\.mjs <txHash>/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
