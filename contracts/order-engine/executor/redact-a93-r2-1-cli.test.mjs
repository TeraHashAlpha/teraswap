// [A93 R2-1] The audit's 30 CLI runs: both operator CLIs as real child processes against a local JSON-RPC stub reached
// through a keyed URL (`/v2/<key>?apikey=<key>`). Each run fails ONE method the CLI calls, with one of three echo shapes:
//   - echoPath:       a JSON-RPC error `no route for /v2/<key>?apikey=<key>` (the request target, no host);
//   - express404:     an HTTP 404 page `<pre>Cannot POST /v2/<key>?apikey=<key></pre>`;
//   - echoSchemeless: a JSON-RPC error `upstream refused request to 127.0.0.1:<port>/v2/<key>?…` (host in front:
//                     already redacted on b367f054, kept here as a guard).
// 5 methods of list-missing-fills --from-block, 1 of --from-ts, 4 of backfill-execution, x 3 shapes = 30 runs. Neither
// stdout nor stderr may hold the key or the query value, in any case or as an 8-character fragment; the provider's
// words around it and the RPC host stay.
//
// Two more runs pin that EVERY print of each CLI is scrubbed, not only what passes redactError: an operator who pastes
// the keyed RPC URL as --from-block (the refusal echoes the argument), and a gateway whose 401 body echoes the
// service key back (backfill prints the body).
//
// Run: node --test contracts/order-engine/executor/redact-a93-r2-1-cli.test.mjs

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { encodeAbiParameters, encodeEventTopics } from "viem"

import { EXPECTED_ORDER_TYPEHASH_V3 } from "./chain-verify.js"
import { ORDER_EXECUTED_EVENT } from "./record-execution.js"

const HERE = dirname(fileURLToPath(import.meta.url))
// DUMMY secrets (never real ones).
const KEY = "A93cliPathKeyR7m2Xq9V"
const QUERY = "A93cliQueryW4n8Jt"
const SERVICE_KEY = "A93cliServiceRoleKey6Hd3"
const SECRETS = [KEY, QUERY, SERVICE_KEY]

const EXECUTOR = "0x686b4f812291F4De238E59ED00BA6dD6129e60a0"
const TX = `0x${"ab".repeat(32)}`
const ORDER_HASH = `0x${"cd".repeat(32)}`
const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const LOG = {
  address: EXECUTOR.toLowerCase(),
  topics: encodeEventTopics({ abi: [ORDER_EXECUTED_EVENT], eventName: "OrderExecuted", args: { orderHash: ORDER_HASH, owner: OWNER, orderType: 2 } }),
  data: encodeAbiParameters(
    ORDER_EXECUTED_EVENT.inputs.filter((i) => !i.indexed),
    ["0x4200000000000000000000000000000000000006", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 10n ** 18n, 3_000_000_000n, 1000n],
  ),
  blockNumber: "0x5",
  transactionHash: TX,
  transactionIndex: "0x0",
  blockHash: `0x${"55".repeat(32)}`,
  logIndex: "0x0",
  removed: false,
}
const z32 = `0x${"00".repeat(32)}`
const block = (n) => ({
  number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, parentHash: z32, timestamp: `0x${(1_700_000_000 + n * 12).toString(16)}`,
  transactions: [], baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: `0x${"00".repeat(20)}`, extraData: "0x",
  logsBloom: `0x${"00".repeat(256)}`, difficulty: "0x0", nonce: "0x0000000000000000", sha3Uncles: z32, size: "0x1", stateRoot: z32,
  receiptsRoot: z32, transactionsRoot: z32, uncles: [],
})
const RECEIPT = {
  status: "0x1", blockNumber: "0x5", blockHash: LOG.blockHash, to: EXECUTOR.toLowerCase(), from: OWNER.toLowerCase(), logs: [LOG],
  gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", transactionHash: TX, transactionIndex: "0x0",
  contractAddress: null, logsBloom: `0x${"00".repeat(256)}`, type: "0x2",
}
function happy(method, params) {
  switch (method) {
    case "eth_chainId": return "0x2105"
    case "eth_blockNumber": return "0x10"
    case "eth_getCode": return "0x6080604052"
    case "eth_call": return EXPECTED_ORDER_TYPEHASH_V3
    case "eth_getLogs": return [LOG]
    case "eth_getTransactionReceipt": return RECEIPT
    case "eth_getBlockByNumber": return block(Number(BigInt(params?.[0] ?? "0x10")))
    default: return null
  }
}

const servers = []
const cwds = []
after(async () => {
  for (const s of servers) await s.stop()
  for (const dir of cwds) rmSync(dir, { recursive: true, force: true })
})

async function listen(handler) {
  const sockets = new Set()
  const server = createServer(handler)
  server.on("connection", (s) => {
    sockets.add(s)
    s.on("close", () => sockets.delete(s))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const handle = {
    port: server.address().port,
    async stop() {
      for (const s of sockets) s.destroy()
      if (server.listening) {
        server.close()
        await once(server, "close")
      }
    },
  }
  servers.push(handle)
  return handle
}

/** A JSON-RPC stub: `failAt` answers with `shape`, every other method the happy path. */
async function rpcStub(failAt, shape) {
  const seen = new Set()
  const handle = await listen((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const call = JSON.parse(raw)
      seen.add(call.method)
      if (call.method === failAt) {
        if (shape === "express404") {
          res.writeHead(404, { "content-type": "text/html" }).end(`<pre>Cannot POST ${req.url}</pre>`)
          return
        }
        const message = shape === "echoPath" ? `no route for ${req.url}` : `upstream refused request to ${req.headers.host}${req.url}`
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message } }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: happy(call.method, call.params) }))
    })
  })
  return { ...handle, seen, keyedUrl: `http://127.0.0.1:${handle.port}/v2/${KEY}?apikey=${QUERY}` }
}

/** A PostgREST stub: the rows both CLIs need, or `{ status, echoKey }` (a gateway that echoes the apikey header). */
async function supabaseStub({ status = 200, echoKey = false } = {}) {
  return listen((req, res) => {
    if (status !== 200) {
      const body = echoKey ? JSON.stringify({ message: `Invalid API key: ${req.headers.apikey}` }) : '{"message":"error"}'
      res.writeHead(status, { "content-type": "application/json" }).end(body)
      return
    }
    const rows = req.url.includes("/orders?order_hash=eq.")
      ? [{ id: "0b3c9e1a-0000-4000-8000-000000000000", order_type: "dca", status: "active", dca_executed: 0, dca_total: 3, chain_id: 8453, token_in_symbol: "WETH", token_out_symbol: "USDC", router: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", created_at: "2023-11-14T22:13:20.000Z" }]
      : []
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows))
  })
}

/** Run `node <cli> …args` from an empty cwd (no .env.executor), env built from scratch. */
async function runCli(cli, args, env) {
  const cwd = mkdtempSync(join(tmpdir(), "a93-r21-cli-"))
  cwds.push(cwd)
  const child = spawn(process.execPath, [join(HERE, cli), ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CHAIN_ID: "8453", ORDER_EXECUTOR_V3_ADDRESS: EXECUTOR, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ...env },
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
  return { exitCode, stdout, stderr, all: `${stdout}\n${stderr}` }
}

function assertNoSecret(run, label) {
  const lower = run.all.toLowerCase()
  for (const secret of SECRETS) {
    assert.ok(!lower.includes(secret.toLowerCase()), `${label}: a secret is in the output:\n${run.all}`)
    for (let i = 0; i + 8 <= secret.length; i++) {
      assert.ok(!lower.includes(secret.slice(i, i + 8).toLowerCase()), `${label}: a fragment of a secret is in the output:\n${run.all}`)
    }
  }
}

const CLIS = {
  "list-missing-fills --from-block": {
    script: "list-missing-fills.mjs", urlVar: "RPC_URL", args: (cwd) => ["--from-block", "1", "--out", join(cwd, "o.txt")],
    methods: ["eth_blockNumber", "eth_chainId", "eth_getCode", "eth_call", "eth_getLogs"],
  },
  "list-missing-fills --from-ts": {
    script: "list-missing-fills.mjs", urlVar: "RPC_URL", args: (cwd) => ["--from-ts", "1700000050", "--out", join(cwd, "o.txt")],
    methods: ["eth_getBlockByNumber"],
  },
  "backfill-execution": {
    script: "backfill-execution.mjs", urlVar: "BACKFILL_RPC_URL", args: () => [TX],
    methods: ["eth_getTransactionReceipt", "eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"],
  },
}
const WORDS = {
  echoPath: /no route for \/v2\/<redacted>\?apikey=<redacted>/,
  express404: /Cannot POST \/v2\/<redacted>\?apikey=<redacted>/,
  echoSchemeless: /upstream refused request to 127\.0\.0\.1:\d+\/REDACTED/,
}
// The methods chain-verify.js calls: a failure there is printed as its boot refusal, which names the RPC as
// `<provider>` and (before A93 R2-3) carried only viem's short message, not the provider's words.
const CHAIN_VERIFY = new Set(["eth_chainId", "eth_getCode", "eth_call"])

describe("[A93 R2-1] the audit's 30 CLI runs: a provider echo of the request target never prints the key", { concurrency: 6 }, () => {
  for (const [name, cli] of Object.entries(CLIS)) {
    for (const method of cli.methods) {
      for (const shape of Object.keys(WORDS)) {
        test(`${name} | ${method} | ${shape}`, { timeout: 90_000 }, async () => {
          const rpc = await rpcStub(method, shape)
          const sb = await supabaseStub()
          const tmp = mkdtempSync(join(tmpdir(), "a93-r21-out-"))
          cwds.push(tmp)
          const run = await runCli(cli.script, cli.args(tmp), { [cli.urlVar]: rpc.keyedUrl, SUPABASE_URL: `http://127.0.0.1:${sb.port}` })
          assert.ok(rpc.seen.has(method), `${method} was never called: ${[...rpc.seen].join(", ")}`)
          assert.equal(run.exitCode, 1, run.all)
          assertNoSecret(run, `${name} ${method} ${shape}`)
          if (CHAIN_VERIFY.has(method)) {
            assert.match(run.stderr, /^ {3}Refusing to scan against <provider>\.$/m, run.all)
          } else {
            assert.match(run.all, WORDS[shape], `the provider's words are gone:\n${run.all}`)
            assert.match(run.all, /127\.0\.0\.1:\d+/, "the operator still sees which provider")
          }
        })
      }
    }
  }
})

describe("[A93 R2-1] every print of each CLI is scrubbed, not only what passes redactError", { concurrency: true }, () => {
  test("list-missing-fills: the keyed RPC URL pasted as --from-block is echoed by the refusal without its key", { timeout: 90_000 }, async () => {
    const rpc = await rpcStub("none", "echoPath")
    const sb = await supabaseStub()
    const run = await runCli("list-missing-fills.mjs", ["--from-block", rpc.keyedUrl], { RPC_URL: rpc.keyedUrl, SUPABASE_URL: `http://127.0.0.1:${sb.port}` })
    assert.equal(run.exitCode, 1, run.all)
    assert.match(run.stderr, /^FATAL: --from-block must be a non-negative integer \(received http:\/\/127\.0\.0\.1:\d+\/v2\/<redacted>\?apikey=<redacted>\)$/m)
    assertNoSecret(run, "--from-block paste")
  })

  test("backfill-execution: a 401 body that echoes the service key is printed without it", { timeout: 90_000 }, async () => {
    const rpc = await rpcStub("none", "echoPath")
    const sb = await supabaseStub({ status: 401, echoKey: true })
    const run = await runCli("backfill-execution.mjs", [TX], { BACKFILL_RPC_URL: rpc.keyedUrl, SUPABASE_URL: `http://127.0.0.1:${sb.port}` })
    assert.equal(run.exitCode, 1, run.all)
    assert.match(run.stderr, /^FATAL: orders lookup failed: HTTP 401 \{"message":"Invalid API key: <redacted>"\}$/m)
    assertNoSecret(run, "401 body")
  })
})
