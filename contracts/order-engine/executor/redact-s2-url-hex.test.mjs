// [fix/keeper-errors-no-signature] A87 S-2, owner answer 3 (2026-11-18): redactUrl also replaces a `0x` hex run of 130+
// digits with `0x<hex N>`. Two paths never pass through redactError:
//   - executor.js:2665  console.error("Fatal error:", redactUrl(err?.stack || redactError(err)))  — a viem stack
//     repeats the whole message, the order signature included;
//   - alert.js sendTelegramAlert's final pass over EVERY keeper alert (alertOps details, event-watcher, monitor).
// Only the `0x` form: a bare run of the letters a-f is ordinary text to redactUrl (redact-s6-schemeless.test.mjs:39
// and redact-shapes.test.mjs:82 pin runs of 300 and 500 `a`).
//
// Run: node --test contracts/order-engine/executor/redact-s2-url-hex.test.mjs

import { test, describe, before, after, mock } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { redactUrl, redactError } = await import("./redact.js")
const { alertOps } = await import("./alert.js")
const { startRpcStub } = await import("./viem-wrapped-errors.fixture.mjs")

const SIG_HEX = `${"dead5ea1".repeat(16)}1b`
const SIGNATURE = `0x${SIG_HEX}`
const HEX_RUN_130 = /[0-9a-f]{130,}/i

let stub
before(async () => {
  stub = await startRpcStub()
})
after(async () => {
  await stub.stop()
})

describe("redactUrl: a 0x hex run of 130+ digits", () => {
  test("130 digits become 0x<hex 130>; 129 stay; a bare run of letters stays", () => {
    assert.equal(redactUrl(`sig ${SIGNATURE} end`), "sig 0x<hex 130> end")
    const short = `0x${"ab".repeat(64)}f`
    assert.equal(redactUrl(short), short)
    assert.equal(redactUrl("a".repeat(300)), "a".repeat(300))
    assert.equal(redactUrl(`raw bytes: 0x${"0".repeat(200)}`), "raw bytes: 0x<hex 200>")
  })

  test("idempotent, and URLs are still redacted around it", () => {
    const once = redactUrl(`https://rpc.example.com/v2/K3Y data=${SIGNATURE}`)
    assert.equal(once, "https://rpc.example.com/REDACTED data=0x<hex 130>")
    assert.equal(redactUrl(once), once)
  })

  test("linear on long and adversarial runs", () => {
    for (const s of [`0x${"a".repeat(2_000_000)}`, "0x".repeat(1_000_000), `0x${"f".repeat(129)}g`.repeat(10_000)]) {
      const t = process.hrtime.bigint()
      const out = redactUrl(s)
      const ms = Number(process.hrtime.bigint() - t) / 1e6
      assert.ok(ms < 3_000, `${ms.toFixed(0)} ms`)
      assert.ok(!/0x[0-9a-f]{130,}/i.test(out))
    }
  })
})

describe("the paths that do not go through redactError", () => {
  test("executor.js:2665 — a fatal viem error's stack, as the fatal handler prints it", async () => {
    const err = await stub.writeError({ hang: true }, { signature: SIGNATURE })
    assert.ok(err.stack.toLowerCase().includes(SIG_HEX), "fixture sanity: the stack repeats the message")
    const line = redactUrl(err?.stack || redactError(err))
    assert.ok(!line.toLowerCase().includes(SIG_HEX) && !/0x[0-9a-f]{130,}/i.test(line))
    assert.ok(line.includes("at "), "the stack frames are kept")
  })

  test("sendTelegramAlert's final pass: an alertOps detail carrying a signature leaves without it", async () => {
    const sent = []
    const fetchMock = mock.method(globalThis, "fetch", async (_url, init) => {
      sent.push(JSON.parse(init.body).text)
      return { ok: true }
    })
    try {
      await alertOps({ kind: "pinned-route-revert", detail: `Order 0b3c… reverted: raw bytes: ${SIGNATURE}` }, 0)
    } finally {
      fetchMock.mock.restore()
    }
    assert.equal(sent.length, 1)
    assert.ok(!HEX_RUN_130.test(sent[0]) && sent[0].includes("raw bytes: 0x&lt;hex 130&gt;"), sent[0])
  })
})
