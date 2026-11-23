// [A93 R2-2] (Low, pre-existing) An unparseable SUPABASE_URL was printed whole by fetch's own error, `Failed to parse URL
// from <value>/rest/v1/…`: a wrong env value (a key pasted into the wrong variable) went to the operator's terminal.
// Both CLIs now check SUPABASE_URL and the RPC URL they read with `new URL()` (http or https) at startup and refuse
// with a line that names only the variable, before any request is made. A value shorter than 12 characters is not a
// configured secret (redact.js SECRET_MIN_LENGTH), so only this refusal keeps it out of the output.
//
// Run: node --test contracts/order-engine/executor/redact-a93-r2-2-cli-url.test.mjs

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { EXPECTED_ORDER_TYPEHASH_V3 } from "./chain-verify.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const EXECUTOR = "0x686b4f812291F4De238E59ED00BA6dD6129e60a0"
const TX = `0x${"ab".repeat(32)}`
// DUMMY values an operator could paste into the wrong variable.
const PASTED_KEY = "A93r22PastedServiceKey0001"
const SHORT = "A93short" // 8 characters: below the configured-secret floor

const cleanups = []
after(async () => {
  for (const c of cleanups) await c()
})

/** A JSON-RPC stub that answers list-missing-fills' happy path and counts every request. */
async function rpcStub() {
  const seen = []
  const sockets = new Set()
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const call = JSON.parse(raw)
      seen.push(call.method)
      const result = { eth_chainId: "0x2105", eth_blockNumber: "0x10", eth_getCode: "0x6080604052", eth_call: EXPECTED_ORDER_TYPEHASH_V3, eth_getLogs: [] }[call.method] ?? null
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }))
    })
  })
  server.on("connection", (s) => {
    sockets.add(s)
    s.on("close", () => sockets.delete(s))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  cleanups.push(async () => {
    for (const s of sockets) s.destroy()
    server.close()
    await once(server, "close")
  })
  return { seen, url: `http://127.0.0.1:${server.address().port}/v2/A93r22RpcPathKey0001` }
}

async function runCli(cli, args, env) {
  const cwd = mkdtempSync(join(tmpdir(), "a93-r22-"))
  cleanups.push(async () => rmSync(cwd, { recursive: true, force: true }))
  const child = spawn(process.execPath, [join(HERE, cli), ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CHAIN_ID: "8453", ORDER_EXECUTOR_V3_ADDRESS: EXECUTOR, SUPABASE_SERVICE_ROLE_KEY: "A93r22ServiceRoleKey01", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (c) => (stdout += c))
  child.stderr.on("data", (c) => (stderr += c))
  const exitCode = await new Promise((resolve) => {
    // A guard against a CLI that never exits, not a wait: every case below ends in a few seconds.
    const kill = setTimeout(() => {
      child.kill("SIGKILL")
      resolve("KILLED")
    }, 60_000)
    child.on("exit", (code) => {
      clearTimeout(kill)
      resolve(code)
    })
  })
  return { exitCode, stdout, stderr }
}

/** The refusal is the one FATAL line, it names the variable, the value is nowhere, and nothing was requested. */
function assertRefused(run, stub, name, value) {
  assert.equal(run.exitCode, 1, run.stderr)
  const fatal = run.stderr.split("\n").filter((l) => l.startsWith("FATAL"))
  assert.deepEqual(fatal, [`FATAL: ${name} is not a valid http(s) URL.`], run.stderr)
  assert.ok(!`${run.stdout}${run.stderr}`.includes(value), `the value is in the output:\n${run.stdout}${run.stderr}`)
  assert.deepEqual(stub.seen, [], "a request was made before the refusal")
}

describe("[A93 R2-2] list-missing-fills.mjs refuses an unparseable URL by name, at startup", { concurrency: true }, () => {
  for (const [label, value] of [["a key pasted into SUPABASE_URL", PASTED_KEY], ["a short value", SHORT]]) {
    test(`SUPABASE_URL: ${label}`, { timeout: 90_000 }, async () => {
      const stub = await rpcStub()
      const run = await runCli("list-missing-fills.mjs", ["--from-block", "0"], { RPC_URL: stub.url, SUPABASE_URL: value })
      assertRefused(run, stub, "SUPABASE_URL", value)
    })
  }

  for (const value of [PASTED_KEY, "ftp://rpc.example.org/A93r22FtpPath0001"]) {
    test(`RPC_URL: ${value.startsWith("ftp") ? "not http(s)" : "a key pasted into RPC_URL"}`, { timeout: 90_000 }, async () => {
      const stub = await rpcStub()
      const run = await runCli("list-missing-fills.mjs", ["--from-block", "0"], { RPC_URL: value, SUPABASE_URL: "http://127.0.0.1:9" })
      assertRefused(run, stub, "RPC_URL", value)
    })
  }
})

describe("[A93 R2-2] backfill-execution.mjs refuses an unparseable URL by name, at startup", { concurrency: true }, () => {
  for (const [label, value] of [["a key pasted into SUPABASE_URL", PASTED_KEY], ["a short value", SHORT]]) {
    test(`SUPABASE_URL: ${label}`, { timeout: 90_000 }, async () => {
      const stub = await rpcStub()
      const run = await runCli("backfill-execution.mjs", [TX], { BACKFILL_RPC_URL: stub.url, SUPABASE_URL: value })
      assertRefused(run, stub, "SUPABASE_URL", value)
    })
  }

  test("BACKFILL_RPC_URL: a short value", { timeout: 90_000 }, async () => {
    const stub = await rpcStub()
    const run = await runCli("backfill-execution.mjs", [TX], { BACKFILL_RPC_URL: SHORT, SUPABASE_URL: "http://127.0.0.1:9" })
    assertRefused(run, stub, "BACKFILL_RPC_URL", SHORT)
  })
})

describe("[A93 R2-2] isHttpUrl", () => {
  test("http and https URLs only", async () => {
    const { isHttpUrl } = await import("./list-missing-fills.mjs")
    for (const ok of ["http://127.0.0.1:8545", "https://base-mainnet.g.alchemy.example/v2/x", "https://user:pw@h.example/"]) assert.equal(isHttpUrl(ok), true, ok)
    for (const bad of ["", "A93short", "127.0.0.1:8545", "http//h.example", "ftp://h.example", "wss://h.example", undefined, null]) assert.equal(isHttpUrl(bad), false, String(bad))
  })
})
