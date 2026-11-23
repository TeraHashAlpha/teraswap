// [A92 S-3] (Medium, new in round 1) The "Last error" alert no longer said which contract or function failed: round 1's
// redactError dropped viem's whole Contract Call block, not only its `args:` line (the order and its signature). It now
// keeps the block's `address:` line and its `function:` line cut at the parenthesis (the name, not the parameter list);
// `args:` and `sender:` stay out. Owner answer 4: the alert also names the order (first 8 characters of its id).
//
// The nine cases of the audit: the keeper's three call sites (canExecute read; executeOrder write failing at
// eth_estimateGas and at eth_sendRawTransaction) x revert / RPC error / timeout, as REAL viem 2.47.10 errors
// (viem-wrapped-errors.fixture.mjs) around a DUMMY 65-byte signature and 1 KB of router calldata. For each: the log
// line (executor.js:2156), the onCycleError alert (monitor.js:126) and the onCycleEnd alert (monitor.js:70) name the
// function and the contract, and carry no fragment of the signature.
//
// Run: node --test contracts/order-engine/executor/redact-a92-s3-contract-call.test.mjs

import { test, describe, before, after, mock } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { redactError } = await import("./redact.js")
const { ExecutorMonitor } = await import("./monitor.js")
const { startRpcStub, revertStringData } = await import("./viem-wrapped-errors.fixture.mjs")

// A DUMMY 65-byte signature (never a real one), the same pattern as redact-s2-signature.test.mjs.
const SIG_HEX = `${"dead5ea1".repeat(16)}1b`
const SIGNATURE = `0x${SIG_HEX}`
const ROUTER_DATA = `0x${"ab".repeat(1024)}`
const CONTRACT = "0x000000000000000000000000000000000000beef" // the fixture's executor address
const ORDER_ID = "0b3c9e1a-0000-4000-8000-000000000000"
const TELEGRAM_MAX = 4096

// Every 16-character window of the signature, as hex and as base64 (the audit's probe): none may appear anywhere.
const SIG_B64 = Buffer.from(SIG_HEX, "hex").toString("base64")
const WINDOWS = new Set()
for (let i = 0; i + 16 <= SIG_HEX.length; i++) WINDOWS.add(SIG_HEX.slice(i, i + 16))
const B64_WINDOWS = new Set()
for (let i = 0; i + 16 <= SIG_B64.length; i++) B64_WINDOWS.add(SIG_B64.slice(i, i + 16))
function fragments(text) {
  const lower = text.toLowerCase()
  return [...WINDOWS].filter((w) => lower.includes(w)).concat([...B64_WINDOWS].filter((w) => text.includes(w)))
}

const MODES = {
  revert: { rpc: { code: 3, message: "execution reverted: not ready", data: revertStringData("not ready") } },
  "rpc error": { rpc: { code: -32603, message: "internal error" } },
  timeout: { hang: true },
}
const SITES = {
  "read canExecute": { fn: "canExecute", build: (stub, spec) => stub.readError(spec, { signature: SIGNATURE }) },
  "write executeOrder @ eth_estimateGas": {
    fn: "executeOrder",
    build: (stub, spec) => stub.writeError(spec, { signature: SIGNATURE, routerData: ROUTER_DATA }),
  },
  "write executeOrder @ eth_sendRawTransaction": {
    fn: "executeOrder",
    build: (stub, spec) => stub.writeError(spec, { failAt: "eth_sendRawTransaction", signature: SIGNATURE, routerData: ROUTER_DATA }),
  },
}

const cases = []
let stub
before(async () => {
  stub = await startRpcStub()
  for (const [site, { fn, build }] of Object.entries(SITES)) {
    for (const [mode, spec] of Object.entries(MODES)) cases.push({ site, mode, fn, err: await build(stub, spec) })
  }
})
after(async () => {
  await stub.stop()
})

/** The one Telegram text a monitor sends for `trigger(monitor, stats)`; fetch is stubbed, nothing leaves the process. */
async function alertText(trigger) {
  const sent = []
  const fetchMock = mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body).text)
    return { ok: true }
  })
  try {
    const stats = { startedAt: new Date().toISOString(), lastError: null }
    trigger(new ExecutorMonitor(stats), stats)
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    fetchMock.mock.restore()
  }
  assert.equal(sent.length, 1, "exactly one alert is sent")
  return sent[0]
}

/** The text names the contract and the function (the name alone), and nothing of the call's arguments. */
function assertNamesCall(text, fn, label) {
  assert.ok(text.includes(`address:   ${CONTRACT}`), `${label}: no contract address in:\n${text}`)
  assert.match(text, new RegExp(`(?:^|\\n)function: {2}${fn}(?:\\n|$)`), `${label}: no function name in:\n${text}`)
  assert.ok(!text.includes("(address owner"), `${label}: the function's parameter list leaked:\n${text}`)
  assert.ok(!/(?:^|\n)\s*(?:args|sender)\s*:/.test(text), `${label}: an args:/sender: line in:\n${text}`)
  assert.deepEqual(fragments(text), [], `${label}: signature fragments in:\n${text.slice(0, 400)}`)
}

describe("[A92 S-3] fixtures: nine real viem errors, each with a Contract Call block around the dummy signature", () => {
  test("nine cases", () => {
    assert.equal(cases.length, 9)
    for (const { site, mode, err } of cases) {
      assert.equal(err.name, "ContractFunctionExecutionError", `${site} / ${mode}`)
      assert.match(err.message, /\nContract Call:\n {2}address: {3}0x0{36}beef\n {2}function: {2}\w+\(/, `${site} / ${mode}`)
      assert.ok(err.message.toLowerCase().includes(SIG_HEX), `${site} / ${mode}: fixture sanity`)
    }
  })
})

describe("[A92 S-3] the log line and both alerts name the function and the contract, never the signature", () => {
  for (const site of Object.keys(SITES)) {
    for (const mode of Object.keys(MODES)) {
      test(`${site} / ${mode}`, async () => {
        const { err, fn } = cases.find((c) => c.site === site && c.mode === mode)
        assertNamesCall(redactError(err), fn, "log line")

        const onError = await alertText((m) => {
          for (let i = 0; i < 3; i++) m.onCycleError(err)
        })
        assertNamesCall(onError, fn, "onCycleError alert")
        assert.ok(onError.length <= TELEGRAM_MAX, `${onError.length}`)

        const onEnd = await alertText((m, stats) => {
          stats.lastError = { orderId: ORDER_ID, message: redactError(err), at: new Date().toISOString() }
          m.onCycleEnd(0, 3)
        })
        assertNamesCall(onEnd, fn, "onCycleEnd alert")
        assert.ok(onEnd.includes(`Last error (order ${ORDER_ID.slice(0, 8)}…): `), onEnd)
        assert.ok(onEnd.length <= TELEGRAM_MAX, `${onEnd.length}`)
      })
    }
  }
})

describe("[A92 S-3, owner answer 4] the onCycleEnd alert names the order", () => {
  const send = (lastError) =>
    alertText((m, stats) => {
      stats.lastError = lastError
      m.onCycleEnd(0, 3)
    })

  test("the first 8 characters of the id, never the whole id", async () => {
    const text = await send({ orderId: ORDER_ID, message: "boom", at: "t" })
    assert.ok(text.includes("Last error (order 0b3c9e1a…): boom"), text)
    assert.ok(!text.includes(ORDER_ID), text)
  })

  test("no id (or not a string): the line is as before", async () => {
    for (const lastError of [{ message: "boom" }, { orderId: "", message: "boom" }, { orderId: 42, message: "boom" }, null]) {
      const text = await send(lastError)
      assert.match(text, /\nLast error: (?:boom|unknown)/, text)
      assert.ok(!text.includes("(order"), text)
    }
  })

  test("an id is escaped like every other value in the alert's HTML", async () => {
    // "<b>&x</b>" is cut to its first 8 characters, "<b>&x</b", then escaped.
    const text = await send({ orderId: "<b>&x</b>", message: "boom" })
    assert.ok(text.includes("(order &lt;b&gt;&amp;x&lt;/b…)"), text)
    // (the alert's own envelope has a <b> title: only the Last error line is the id's business)
    const line = text.split("\n").find((l) => l.startsWith("Last error"))
    assert.ok(line && !/[<>]/.test(line), `raw markup on the Last error line: ${line}`)
  })
})
