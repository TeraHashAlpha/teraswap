// [A92 S-1] (High, pre-existing on origin/main) The operator CLIs printed viem's raw err.message, whose `URL:` line is
// the RPC URL with the provider key in its path: list-missing-fills.mjs at :325 (getBlockNumber via :246), :287 (the
// scan) and :110 (scanLogsChunked's retry log line, which backfill-execution.mjs reaches too; owner answer 2), and
// backfill-execution.mjs at :297; backfill-execution.mjs also printed the whole RPC URL at :149 on every run.
//
// Each case starts the REAL CLI (`node <cli>`) against a local JSON-RPC stub reached through a keyed URL
// (`/v2/<marker>`), with a provider that answers HTTP 503 or never answers, and asserts that neither stdout nor stderr
// carries the marker. A hung provider is a real open socket; the child runs with short-viem-timeout.fixture.mjs, which
// turns only viem's own 10 s request timer into 200 ms (owner answer 3), so viem's real TimeoutError is what reaches
// the print. RPC_URL (list-missing-fills) and BACKFILL_RPC_URL (backfill-execution) both carry the marker.
//
// Run: node --test contracts/order-engine/executor/redact-a92-s1-cli.test.mjs

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { EXPECTED_ORDER_TYPEHASH_V3 } from "./chain-verify.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const PRELOAD = pathToFileURL(join(HERE, "short-viem-timeout.fixture.mjs")).href
// A DUMMY provider key (never a real one), in the path where a provider URL carries it.
const MARKER = "A92s1Marker5x7q"
const EXECUTOR = "0x000000000000000000000000000000000000beef"
const TX_HASH = `0x${"ab".repeat(32)}`

const cwds = []
after(() => {
  for (const dir of cwds) rmSync(dir, { recursive: true, force: true })
})

/**
 * A JSON-RPC stub. `failAt` is a method name, or "*" for every method; `spec` is `{ http: 503 }` (a provider error
 * page) or `{ hang: true }` (never answers; the socket stays open until stop()). Every other method gets a plumbing
 * answer that lets list-missing-fills.mjs pass its chain verification (chain 8453, code at the executor, the v3
 * ORDER_TYPEHASH).
 */
async function startStub({ failAt, spec }) {
  const seen = []
  const sockets = new Set()
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      let call = {}
      try {
        call = JSON.parse(body)
      } catch {
        /* not JSON: answered as an unknown method */
      }
      const method = String(call.method ?? "")
      seen.push(method)
      if (failAt === "*" || method === failAt) {
        if (spec.hang) return
        res.writeHead(spec.http, { "content-type": "text/plain" }).end("Service Unavailable")
        return
      }
      const results = {
        eth_chainId: "0x2105",
        eth_blockNumber: "0x10",
        eth_getCode: "0x6080604052",
        eth_call: EXPECTED_ORDER_TYPEHASH_V3,
      }
      const payload =
        method in results
          ? { jsonrpc: "2.0", id: call.id ?? 1, result: results[method] }
          : { jsonrpc: "2.0", id: call.id ?? 1, error: { code: -32601, message: `stub: ${method} not served` } }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload))
    })
  })
  server.on("connection", (s) => {
    sockets.add(s)
    s.on("close", () => sockets.delete(s))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    seen,
    keyedUrl: `http://127.0.0.1:${server.address().port}/v2/${MARKER}`,
    async stop() {
      for (const s of sockets) s.destroy()
      server.close()
      await once(server, "close")
    },
  }
}

/** Run `node --import <preload> <cli> …args` from an empty cwd (no .env.executor), env built from scratch. */
async function runCli(cli, args, stub) {
  const cwd = mkdtempSync(join(tmpdir(), "a92-s1-cli-"))
  cwds.push(cwd)
  const child = spawn(process.execPath, ["--import", PRELOAD, join(HERE, cli), ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RPC_URL: stub.keyedUrl,
      BACKFILL_RPC_URL: stub.keyedUrl,
      CHAIN_ID: "8453",
      ORDER_EXECUTOR_V3_ADDRESS: EXECUTOR,
      SUPABASE_URL: "http://127.0.0.1:9/unused",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    },
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

function assertNoKey(run, label) {
  for (const [stream, text] of [["stdout", run.stdout], ["stderr", run.stderr]]) {
    const leaked = text.split("\n").filter((line) => line.includes(MARKER))
    assert.deepEqual(leaked, [], `${label}: the provider key is in ${stream}:\n${leaked.join("\n")}`)
  }
}

const PROVIDERS = {
  "answers HTTP 503": { http: 503 },
  "never answers (viem's timeout)": { hang: true },
}

describe("[A92 S-1] list-missing-fills.mjs never prints the keyed RPC URL", { concurrency: true }, () => {
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    test(`a provider that ${name} on every call: the FATAL line at :325`, { timeout: 90_000 }, async () => {
      const stub = await startStub({ failAt: "*", spec })
      try {
        const run = await runCli("list-missing-fills.mjs", ["--from-block", "0"], stub)
        assert.equal(run.exitCode, 1, run.stderr)
        assert.ok(stub.seen.includes("eth_blockNumber"), `saw ${stub.seen.join(", ")}`)
        assertNoKey(run, name)
        assert.match(run.stderr, /^FATAL: .*(?:HTTP request failed|took too long to respond)/m)
        assert.match(run.stderr, /127\.0\.0\.1:\d+/, "the operator still sees which provider")
      } finally {
        await stub.stop()
      }
    })

    test(`a provider that ${name} on eth_getLogs only: the retry line at :110 and the refusal at :287`, { timeout: 90_000 }, async () => {
      const stub = await startStub({ failAt: "eth_getLogs", spec })
      try {
        const run = await runCli("list-missing-fills.mjs", ["--from-block", "0"], stub)
        assert.equal(run.exitCode, 1, run.stderr)
        assert.equal(stub.seen.filter((m) => m === "eth_getLogs").length > 0, true, `saw ${stub.seen.join(", ")}`)
        assertNoKey(run, name)
        assert.match(run.stdout, /range error on 0-16 \(.*(?:HTTP request failed|took too long to respond)/)
        assert.match(run.stderr, /Refusing to scan against <provider>/)
      } finally {
        await stub.stop()
      }
    })
  }
})

describe("[A92 S-1] backfill-execution.mjs never prints the keyed RPC URL", { concurrency: true }, () => {
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    test(`a provider that ${name}: the banner at :149 and the FATAL line at :297`, { timeout: 90_000 }, async () => {
      const stub = await startStub({ failAt: "*", spec })
      try {
        const run = await runCli("backfill-execution.mjs", [TX_HASH], stub)
        assert.equal(run.exitCode, 1, run.stderr)
        assert.ok(stub.seen.includes("eth_getTransactionReceipt"), `saw ${stub.seen.join(", ")}`)
        assertNoKey(run, name)
        assert.match(run.stdout, /via RPC host=127\.0\.0\.1:\d+ ===/, "the banner names the host only")
        assert.match(run.stderr, /^FATAL: .*(?:HTTP request failed|took too long to respond)/m)
      } finally {
        await stub.stop()
      }
    })
  }
})
