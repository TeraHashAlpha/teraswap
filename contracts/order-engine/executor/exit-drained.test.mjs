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
import { runWithHeldBackStdout } from "../../../scripts/lib/held-back-reader.mjs"
import { EXPECTED_ORDER_TYPEHASH_V3 } from "./chain-verify.js"
import { CONTRACT, makeOrderExecutedLog } from "./record-execution.test.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const LIST = join(HERE, "list-missing-fills.mjs")
const BACKFILL = join(HERE, "backfill-execution.mjs")
const DRAINED = join(HERE, "exit-drained.js")

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
