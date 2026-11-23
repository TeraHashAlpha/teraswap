// [A99 R4-1] (High) chain-verify's errText scrubbed the provider's `details` by value AFTER redactUrls: a URL whose key
// the provider split with a line break lost its first half to redactUrls (the URL pattern stops at the break), and the
// by-value scrub could no longer match the half that remained. The refusal printed 21 characters of the RPC key on every
// restart (eth_chainId answering JSON-RPC -32000 with `see https://rpc.provider.example/v2/<half>LF<half> for the route`).
// [A99 R4-2] (High by the test rule) The HEAD's scrub, which comes first, had no test that pins its place: moving it after
// redactUrls (mutant Q03) kept every test green.
//
// The order now lives in ONE helper (chain-verify.js scrubThenRedactUrls) that the head, the details and the rendering of
// an RPC answer all use: the configured secrets by value, then redactUrls, then the flatten.
//
//   1. REAL viem errors over HTTP: a JSON-RPC -32000 whose message holds the split URL, at eth_chainId, at eth_getCode
//      (schemeless host) and at eth_call (the ORDER_TYPEHASH() read), for three kinds of break (LF, CRLF, LF + tab).
//   2. R4-2: an ORDER_TYPEHASH() revert of type Error(string): the reason holds the split URL, the details say only
//      "execution reverted" (so the HEAD is the only place the key is) — a real viem error, and an injected one.
//   3. The same refusal as list-missing-fills prints it on stderr (a real child process).
//   4. The other sites that scrub after a mask: an RPC answer rendered by describeValue, and redactError on an object
//      with no message whose own text (toString) holds the split URL.
//
// The configured RPC_URL carries the DUMMY key; it is set before redact.js is first used (the list is built once).
//
// Run: node --test contracts/order-engine/executor/redact-a99-r4-1-scrub-order.test.mjs

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY = "A99orderKeyRk7mQ2xV9pL4sT8"
const A = KEY.slice(0, 11)
const B = KEY.slice(11)
process.env.RPC_URL = `https://base-mainnet.g.alchemy.example/v2/${KEY}`

const { verifyChainBinding, createRpcProbe, EXPECTED_ORDER_TYPEHASH_V3 } = await import("./chain-verify.js")
const { redactError } = await import("./redact.js")
const { createPublicClient, http, encodeErrorResult } = await import("viem")

const ADDRESS = "0x686b4f812291F4De238E59ED00BA6dD6129e60a0"
const SPLITS = { LF: "\n", CRLF: "\r\n", "LF and tab": "\n\t" }
const SCHEMED = (split) => `see https://rpc.provider.example/v2/${A}${split}${B} for the route`
const SCHEMELESS = (split) => `see rpc.provider.example/v2/${A}${split}${B} for the route`

/** No 12-character run of the key (any case, blanks and breaks removed) and neither half of it anywhere in `text`. */
function assertNoKeyRun(text, label) {
  const flat = text.toLowerCase().replace(/[ \t]*[\r\n][\r\n \t]*/g, "")
  const key = KEY.toLowerCase()
  for (let i = 0; i + 12 <= key.length; i++) assert.ok(!flat.includes(key.slice(i, i + 12)), `${label}: a 12-character run of the key (${key.slice(i, i + 12)}) is in:\n${text}`)
  assert.ok(!flat.includes(B.toLowerCase().slice(0, 10)), `${label}: the second half of the key is in:\n${text}`)
  assert.ok(!flat.includes(A.toLowerCase()), `${label}: the first half of the key is in:\n${text}`)
}

const servers = []
const cwds = []
after(async () => {
  for (const s of servers) await s.stop()
  for (const dir of cwds) rmSync(dir, { recursive: true, force: true })
})

/** A JSON-RPC stub: `failAt` answers with the JSON-RPC error `error`; every other method answers the happy path. */
async function rpcStub(failAt, error) {
  const sockets = new Set()
  const seen = new Set()
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const call = JSON.parse(raw)
      seen.add(call.method)
      const body =
        call.method === failAt
          ? { jsonrpc: "2.0", id: call.id, error }
          : { jsonrpc: "2.0", id: call.id, result: { eth_chainId: "0x2105", eth_blockNumber: "0x10", eth_getCode: "0x6080604052", eth_call: EXPECTED_ORDER_TYPEHASH_V3, eth_getLogs: [] }[call.method] ?? null }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
    })
  })
  server.on("connection", (s) => {
    sockets.add(s)
    s.on("close", () => sockets.delete(s))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const handle = {
    seen,
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/v2/${KEY}`,
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

/** The ChainVerificationError a provider produces (one attempt). */
async function refusal(provider) {
  const out = await verifyChainBinding({
    provider,
    chainId: 8453,
    contracts: [{ label: "v3", address: ADDRESS, expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V3 }],
    attempts: 1,
    sleep: async () => {},
  }).then(
    () => null,
    (e) => e,
  )
  assert.equal(out?.name, "ChainVerificationError")
  assert.ok(!/[\r\n]/.test(out.message), `not one line: ${JSON.stringify(out.message)}`)
  return out
}
const realRefusal = (stub) => refusal(createRpcProbe(createPublicClient({ transport: http(stub.url, { retryCount: 0 }) })))

/** The line executor.js:2444 prints for the refusal. */
const printed = (err) => redactError(err)

describe("[A99 R4-1] a JSON-RPC error whose message holds a URL with the key split by a line break: the boot refusal never prints a half", () => {
  const METHODS = {
    eth_chainId: { words: SCHEMED, call: "eth_chainId" },
    "eth_getCode (a schemeless host)": { words: SCHEMELESS, call: "eth_getCode" },
    "eth_call (the ORDER_TYPEHASH() read)": { words: SCHEMED, call: "eth_call" },
  }
  for (const [label, { words, call }] of Object.entries(METHODS)) {
    for (const [name, split] of Object.entries(SPLITS)) {
      test(`${label} | the key split by ${name}`, async () => {
        const stub = await rpcStub(call, { code: -32000, message: words(split) })
        const refused = await realRefusal(stub)
        assert.ok(stub.seen.has(call), `${call} was never called: ${[...stub.seen].join(", ")}`)
        assertNoKeyRun(refused.message, `${label} ${name}`)
        assert.ok(refused.message.includes("for the route"), `the provider's words are gone:\n${refused.message}`)
        assertNoKeyRun(printed(refused), `${label} ${name} (as printed)`)
      })
    }
  }
})

describe("[A99 R4-2] an ORDER_TYPEHASH() revert of type Error(string): the key is in the HEAD only, the details say 'execution reverted'", () => {
  /** viem reads the reason of an `Error(string)` revert from the JSON-RPC error's `data`. */
  const revertData = (reason) => encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }], errorName: "Error", args: [reason] })

  for (const [name, split] of Object.entries(SPLITS)) {
    test(`a real viem revert, reason with the key split by ${name}`, async () => {
      const stub = await rpcStub("eth_call", { code: 3, message: "execution reverted", data: revertData(SCHEMED(split)) })
      const refused = await realRefusal(stub)
      assert.ok(stub.seen.has("eth_call"))
      assert.ok(refused.message.includes("for the route"), `the revert reason is gone:\n${refused.message}`)
      assertNoKeyRun(refused.message, `real revert ${name}`)
      assertNoKeyRun(printed(refused), `real revert ${name} (as printed)`)
    })

    test(`an injected revert, reason with the key split by ${name}, details only "execution reverted"`, async () => {
      const shortMessage = `The contract function "ORDER_TYPEHASH" reverted with the following reason:\n${SCHEMED(split)}`
      const err = Object.assign(new Error(`${shortMessage}\n\nContract Call:\n  address:   ${ADDRESS}\n\nVersion: viem@2.47.10`), { shortMessage, details: "execution reverted" })
      const refused = await refusal({
        getChainId: async () => 8453,
        getCode: async () => "0x60",
        readContract: async () => {
          throw err
        },
      })
      assert.ok(refused.message.includes("for the route") && refused.message.includes("— details: execution reverted —"), refused.message)
      assertNoKeyRun(refused.message, `injected revert ${name}`)
    })
  }
})

describe("[A99 R4-1] the same refusal, printed by list-missing-fills on stderr (a real child process)", () => {
  for (const [name, split] of Object.entries(SPLITS)) {
    test(`eth_chainId answers -32000 with the key split by ${name}`, { timeout: 90_000 }, async () => {
      const stub = await rpcStub("eth_chainId", { code: -32000, message: SCHEMED(split) })
      const cwd = mkdtempSync(join(tmpdir(), "a99-r41-"))
      cwds.push(cwd)
      const child = spawn(process.execPath, [join(HERE, "list-missing-fills.mjs"), "--from-block", "1", "--out", join(cwd, "o.txt")], {
        cwd,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CHAIN_ID: "8453", ORDER_EXECUTOR_V3_ADDRESS: ADDRESS, SUPABASE_SERVICE_ROLE_KEY: "A99serviceRoleKey0001", SUPABASE_URL: "http://127.0.0.1:9", RPC_URL: stub.url },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let all = ""
      child.stdout.on("data", (c) => (all += c))
      child.stderr.on("data", (c) => (all += c))
      const exitCode = await new Promise((resolve) => {
        // A guard against a CLI that never exits, not a wait: the run ends in a few seconds.
        const kill = setTimeout(() => {
          child.kill("SIGKILL")
          resolve("KILLED")
        }, 60_000)
        child.on("exit", (code) => {
          clearTimeout(kill)
          resolve(code)
        })
      })
      assert.equal(exitCode, 1, all)
      assert.ok(stub.seen.has("eth_chainId"), all)
      assert.match(all, /^ {3}Refusing to scan against <provider>\.$/m, all)
      assert.ok(all.includes("for the route"), `the provider's words are gone:\n${all}`)
      assertNoKeyRun(all, `list-missing-fills ${name}`)
    })
  }
})

describe("[A99 R4-1] the other sites where a mask came before the scrub", () => {
  test("describeValue (chain-verify): a malformed eth_chainId answer that holds the key whole or split is printed without it", async () => {
    for (const answer of [`see https://rpc.provider.example/v2/${KEY} for the route`, `see https://rpc.provider.example/v2/${A}\n${B} for the route`, `route ${A}\r\n${B}`, `route ${KEY}`]) {
      const refused = await refusal({ getChainId: async () => answer, getCode: async () => "0x60", readContract: async () => EXPECTED_ORDER_TYPEHASH_V3 })
      assert.match(refused.message, /malformed eth_chainId/, refused.message)
      assertNoKeyRun(refused.message, `describeValue ${JSON.stringify(answer)}`)
    }
  })

  for (const [name, split] of Object.entries(SPLITS)) {
    test(`redactError (redact.js) on an object with no message whose text holds the URL with the key split by ${name}`, () => {
      const text = SCHEMED(split)
      const noMessage = { toString: () => text } // composeErrorText has no head to scrub: it falls back to String(err)
      assertNoKeyRun(redactError(noMessage), `no message ${name}`)
      const fn = Object.assign(() => {}, { toString: () => text }) // a thrown function (typeof !== "object")
      assertNoKeyRun(redactError(fn), `function ${name}`)
      assert.ok(redactError(noMessage).includes("for the route"), redactError(noMessage))
    })
  }

  test("what is not a secret is untouched: no configured secret in the text, the refusal reads as it did", async () => {
    const refused = await refusal({
      getChainId: async () => {
        throw Object.assign(new Error("RPC Request failed."), { shortMessage: "RPC Request failed.", details: "see https://rpc.provider.example/v2/someOtherPathValue for the route" })
      },
      getCode: async () => "0x60",
      readContract: async () => EXPECTED_ORDER_TYPEHASH_V3,
    })
    assert.ok(refused.message.endsWith("RPC Request failed. — details: see <redacted-url> for the route — refusing to boot"), refused.message)
  })
})
