// [A93 R2-1] The audit's keeper measurement: the provider answers a JSON-RPC error that echoes only the request target,
// `no route for /v2/<key>?apikey=<key>`, at each of the keeper's three call sites (canExecute at eth_call; executeOrder
// at eth_estimateGas and at eth_sendRawTransaction), as REAL viem 2.47.10 errors (viem-wrapped-errors.fixture.mjs). The
// error reaches four sinks: the keeper log line (executor.js:2156), the onCycleEnd alert with stats.lastError as
// executor.js:2161 stores it (monitor.js:70), the onCycleError alert (monitor.js:126) and alertOps. On b367f054 all
// 3 x 4 carried the key (viem keeps the provider's words on its `Details:` line); now none does, and the provider's
// words around it stay.
//
// The configured RPC_URL carries the DUMMY key; it is set before redact.js is first used (the list is built once).
//
// Run: node --test contracts/order-engine/executor/redact-a93-r2-1-sinks.test.mjs

import { test, describe, before, after, mock } from "node:test"
import assert from "node:assert/strict"

const KEY = "A93sinkKeyQm4Vx8Lp2Zr6"
const QUERY = "A93sinkQueryN5t9Wc"
process.env.RPC_URL = `https://base-mainnet.g.alchemy.example/v2/${KEY}?apikey=${QUERY}`
process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { redactError } = await import("./redact.js")
const { alertOps } = await import("./alert.js")
const { ExecutorMonitor } = await import("./monitor.js")
const { startRpcStub } = await import("./viem-wrapped-errors.fixture.mjs")

const ORDER_ID = "0b3c9e1a-0000-4000-8000-000000000000"
const ECHO = { rpc: { code: -32000, message: `no route for /v2/${KEY}?apikey=${QUERY}` } }
const SITES = {
  "canExecute @ eth_call": (stub) => stub.readError(ECHO),
  "executeOrder @ eth_estimateGas": (stub) => stub.writeError(ECHO),
  "executeOrder @ eth_sendRawTransaction": (stub) => stub.writeError(ECHO, { failAt: "eth_sendRawTransaction" }),
}

/** The one Telegram text `send` produces; fetch is stubbed, nothing leaves the process. */
async function telegram(send) {
  const sent = []
  const fetchMock = mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body).text)
    return { ok: true }
  })
  try {
    await send()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    fetchMock.mock.restore()
  }
  assert.equal(sent.length, 1, "exactly one alert is sent")
  return sent[0]
}

const SINKS = {
  "keeper log line (executor.js:2156)": async (err) => `  Order ${ORDER_ID.slice(0, 8)}... error: ${redactError(err)}`,
  "onCycleEnd alert (monitor.js:70)": (err) =>
    telegram(() => {
      const stats = { startedAt: new Date().toISOString(), lastError: { orderId: ORDER_ID, message: redactError(err), at: new Date().toISOString() } }
      new ExecutorMonitor(stats).onCycleEnd(0, 3)
    }),
  "onCycleError alert (monitor.js:126)": (err) =>
    telegram(() => {
      const monitor = new ExecutorMonitor({ startedAt: new Date().toISOString(), lastError: null })
      for (let i = 0; i < 3; i++) monitor.onCycleError(err)
    }),
  alertOps: (err) => telegram(() => alertOps({ kind: "rpc", detail: `balance read failed: ${redactError(err)}` }, 5)),
}

const errors = {}
let stub
before(async () => {
  stub = await startRpcStub()
  for (const [site, make] of Object.entries(SITES)) errors[site] = await make(stub)
})
after(async () => {
  await stub.stop()
})

describe("[A93 R2-1] fixtures: the provider's echo is on viem's Details: line", () => {
  test("three real viem errors", () => {
    for (const [site, err] of Object.entries(errors)) {
      assert.equal(err.name, "ContractFunctionExecutionError", site)
      assert.ok(err.message.includes(`Details: no route for /v2/${KEY}?apikey=${QUERY}`), `${site}: fixture sanity`)
    }
  })
})

describe("[A93 R2-1] 3 call sites x 4 keeper sinks: the key never leaves, the provider's words do", () => {
  for (const site of Object.keys(SITES)) {
    for (const [sink, render] of Object.entries(SINKS)) {
      test(`${site} -> ${sink}`, async () => {
        const out = await render(errors[site])
        for (const secret of [KEY, QUERY]) {
          assert.ok(!out.toLowerCase().includes(secret.toLowerCase()), `the key is in:\n${out}`)
          for (let i = 0; i + 8 <= secret.length; i++) assert.ok(!out.includes(secret.slice(i, i + 8)), `a fragment of the key is in:\n${out}`)
        }
        assert.match(out, /no route for \/v2\/(?:<|&lt;)redacted(?:>|&gt;)\?apikey=(?:<|&lt;)redacted(?:>|&gt;)/, out)
      })
    }
  }
})
