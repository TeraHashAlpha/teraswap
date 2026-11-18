// [fix/keeper-errors-no-signature] A87 S-2 — what redactError keeps and what it drops (redact.js).
//
// Kept (owner answer 1, 2026-11-18): `Name: shortMessage` (else the first line of `message`), the decoded revert
// reason, viem's own `URL:` / `Status:` / `Details:` lines; [A92 S-3, round 2] and the Contract Call block's `address:`
// line and `function:` name. Dropped: everything else in the message (the Contract Call's `args:` and `sender:`,
// Raw Call / Request Arguments with `data:`, Request body, Docs, Version). Then URL redaction, the
// args/data/Arguments-block and 130+ hex scrub, and the 600-character cap with a visible marker. Never throws.
//
// The viem errors are REAL (viem-wrapped-errors.fixture.mjs: viem's own clients against a local JSON-RPC stub, or
// viem's own constructors), with a DUMMY signature.
//
// Run: node --test contracts/order-engine/executor/redact-s2-error-text.test.mjs

import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { encodeErrorResult, HttpRequestError, WaitForTransactionReceiptTimeoutError } from "viem"

import { redactError, ERROR_TEXT_MAX, TRUNCATED } from "./redact.js"
import { startRpcStub, revertStringData, INSUFFICIENT_OUTPUT_DATA } from "./viem-wrapped-errors.fixture.mjs"

const SIG_HEX = `${"dead5ea1".repeat(16)}1b`
const SIGNATURE = `0x${SIG_HEX}`
const KEY = "TESTKEYqwrtz"
const HEX_RUN_130 = /[0-9a-f]{130,}/i
const SWAP_FAILED_ABI = [{ type: "error", name: "SwapFailed", inputs: [{ type: "bytes", name: "reason" }] }]

let stub
before(async () => {
  stub = await startRpcStub()
})
after(async () => {
  await stub.stop()
})

const read = (spec) => stub.readError(spec, { signature: SIGNATURE })
const write = (spec, failAt) => stub.writeError(spec, { signature: SIGNATURE, ...(failAt ? { failAt } : {}) })
const clean = (out) => !out.toLowerCase().includes(SIG_HEX) && !HEX_RUN_130.test(out) && !/^\s*(?:args|data)\s*:/im.test(out)

describe("what an operator needs stays: error class, short reason, revert reason, URL host, status, details", () => {
  test("a revert with a reason string: class + the reason, nothing of the call", async () => {
    const out = redactError(await read({ rpc: { code: 3, message: "execution reverted: not ready", data: revertStringData("not ready") } }))
    assert.equal(out, 'ContractFunctionExecutionError: The contract function "canExecute" reverted with the following reason: not ready\naddress:   0x000000000000000000000000000000000000beef\nfunction:  canExecute\nDetails: execution reverted: not ready')
  })

  test("a custom-error revert: the decoded error name is appended", async () => {
    const out = redactError(await write({ rpc: { code: 3, message: "execution reverted", data: INSUFFICIENT_OUTPUT_DATA } }))
    assert.match(out, /^ContractFunctionExecutionError: .*executeOrder.* — reason: InsufficientOutput\naddress: {3}0x0{36}beef\nfunction: {2}executeOrder\nDetails: execution reverted$/)
    assert.ok(clean(out), out)
  })

  test("SwapFailed(bytes): the executor's inner reason (revert-decode.js) is appended", async () => {
    const data = encodeErrorResult({ abi: SWAP_FAILED_ABI, errorName: "SwapFailed", args: [revertStringData("transfer amount exceeds allowance")] })
    const out = redactError(await write({ rpc: { code: 3, message: "execution reverted", data } }))
    assert.match(out, /reason: SwapFailed: Error\(string\): transfer amount exceeds allowance/)
    assert.ok(clean(out), out)
  })

  test("a provider 503: Status, URL host and Details lines survive, the request body does not", async () => {
    const err = await write({ http: 503, body: "Service Unavailable" })
    assert.ok(err.message.includes("Request body:"), "fixture sanity")
    const out = redactError(err)
    assert.match(out, /^ContractFunctionExecutionError: HTTP request failed\.\nStatus: 503\nURL: http:\/\/127\.0\.0\.1:\d+\/\naddress: {3}0x0{36}beef\nfunction: {2}executeOrder\nDetails: "Service Unavailable"$/)
    assert.ok(clean(out), out)
  })

  test("a timeout: the short message, the URL and viem's Details", async () => {
    const out = redactError(await read({ hang: true }))
    assert.match(out, /^ContractFunctionExecutionError: The request took too long to respond\.\nURL: http:\/\/127\.0\.0\.1:\d+\/\naddress: {3}0x0{36}beef\nfunction: {2}canExecute\nDetails: The request timed out\.$/)
  })

  test("a keyed URL keeps its host; the key is gone", () => {
    const err = new HttpRequestError({ url: `https://rpc.example.com/v2/${KEY}`, status: 403, body: { method: "eth_call", params: [{ data: SIGNATURE }] }, details: "not on whitelist" })
    const out = redactError(err)
    assert.equal(out, "HttpRequestError: HTTP request failed.\nStatus: 403\nURL: https://rpc.example.com/REDACTED\nDetails: not on whitelist")
  })

  test("a tx hash in the short message is kept (66 characters is no secret)", () => {
    const hash = `0x${"ab".repeat(32)}`
    const out = redactError(new WaitForTransactionReceiptTimeoutError({ hash }))
    assert.equal(out, `WaitForTransactionReceiptTimeoutError: Timed out while waiting for transaction with hash "${hash}" to be confirmed.`)
  })

  test("shortMessage wins over message; a plain Error keeps its first line with no prefix", () => {
    assert.equal(redactError({ name: "HttpRequestError", shortMessage: "HTTP request failed.", message: "something else\nURL: https://h.example" }), "HttpRequestError: HTTP request failed.\nURL: https://h.example")
    assert.equal(redactError(new Error("first line\nsecond line")), "first line")
    assert.equal(redactError(new TypeError("fetch failed")), "TypeError: fetch failed")
  })
})

describe("the scrub", () => {
  test("args: / data: lines and Request / Raw Call Arguments blocks are removed from a string", () => {
    const s = [
      "boom",
      "Request Arguments:",
      "  from:  0x00000000000000000000000000000000000000a1",
      `  data:  ${SIGNATURE}`,
      "Raw Call Arguments:",
      "  to:    0x000000000000000000000000000000000000beef",
      "Contract Call:",
      "  function:  canExecute(bytes)",
      `  args:               (${SIGNATURE})`,
      "Details: ok",
    ].join("\n")
    assert.equal(redactError(s), "boom\nContract Call:\n  function:  canExecute(bytes)\nDetails: ok")
  })

  test("a run of 130+ hex digits becomes <hex N>; 129 stays", () => {
    assert.equal(redactError(`a ${"f".repeat(129)} b`), `a ${"f".repeat(129)} b`)
    assert.equal(redactError(`sig ${SIGNATURE} end`), "sig 0x<hex 130> end")
    assert.equal(redactError(`blob ${"A1".repeat(200)}`), "blob <hex 400>")
  })
})

describe("the cap", () => {
  test(`at most ${ERROR_TEXT_MAX} characters, with a visible marker`, () => {
    const out = redactError(new Error(`reverted: ${"word ".repeat(10_000)}`))
    assert.ok(out.length <= ERROR_TEXT_MAX, `${out.length}`)
    assert.ok(out.includes(TRUNCATED), out.slice(-40))
  })

  test("a caller's lower `max` is honoured, marker included", () => {
    const out = redactError(new Error(`x ${"y ".repeat(500)}`), { max: 80 })
    assert.ok(out.length <= 80 && out.includes(TRUNCATED), out)
  })

  test("a multi-megabyte message: bounded, linear, no secret", () => {
    const err = new Error(`big ${`https://rpc.example.com/v2/${KEY} ${SIGNATURE} `.repeat(30_000)}`)
    assert.ok(err.message.length > 4_000_000)
    const t = process.hrtime.bigint()
    const out = redactError(err)
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    assert.ok(out.length <= ERROR_TEXT_MAX && !out.includes(KEY) && clean(out), out.slice(0, 200))
    assert.ok(ms < 2_000, `${ms.toFixed(0)} ms`)
  })
})

describe("never throws", () => {
  const circular = new Error("loop")
  circular.cause = circular
  const hostile = {
    get name() {
      throw new Error("no")
    },
    get message() {
      throw new Error("no")
    },
    get shortMessage() {
      throw new Error("no")
    },
    get cause() {
      throw new Error("no")
    },
  }
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const noString = Object.create(null)
  const badToString = { toString() { throw new Error("no") } }
  for (const [name, v] of Object.entries({
    circular,
    hostile,
    "revoked proxy": revoked.proxy,
    "null prototype": noString,
    "throwing toString": badToString,
    symbol: Symbol("s"),
    bigint: 10n,
    undefined,
    null: null,
    number: 42,
    function: function f() {},
    "cause that throws": Object.defineProperty(new Error("outer"), "cause", { get() { throw new Error("no") } }),
  })) {
    test(name, () => {
      const out = redactError(v)
      assert.equal(typeof out, "string")
      assert.ok(out.length <= ERROR_TEXT_MAX)
    })
  }
})
