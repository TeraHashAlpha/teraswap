// [A92 S-5] (Low, new in round 1) Round 1 added a `0x` hex scrub to redactUrl, and rpc-auth.js classifies redactUrl's
// text: a 0x run of 130+ hex digits glued to "unauthorized" became "0x<hex 130>unauthorized", the `>` made a word
// boundary, and `\bunauthorized\b` matched where it had not on origin/main ("transient" there, "auth" on the head,
// which also moved classifyMissCause to infra "rpc-auth"). rpc-auth.js now classifies redactUrlOnly's text: the URL
// redaction alone, with no hex scrub, exactly what it classified on origin/main.
//
// The expected answers below were MEASURED with origin/main 85a6f9cb's own rpc-auth.js and retry-policy.js (a scratch
// extraction of that commit), not derived from the code under test. A 20,000-shape seeded differential against that
// extraction is in this branch's feedback (round 2, evidence 3).
//
// Run: node --test contracts/order-engine/executor/rpc-auth-a92-s5-url-only.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import { classifyRpcError } from "./rpc-auth.js"
import { classifyMissCause } from "./retry-policy.js"
import { redactUrl, redactUrlOnly } from "./redact.js"

const H130 = "ab".repeat(65)

// [shape, classifyRpcError on origin/main, classifyMissCause({ err }) on origin/main]
const PINNED = {
  "a 0x run of 130 hex glued to 'unauthorized'": [{ message: `0x${H130}unauthorized` }, { kind: "transient", signal: null }, { cause: "infra", reason: "unclassified" }],
  "200 hex glued to 'Unauthorised', on a named RPC error": [
    Object.assign(new Error(`request failed: 0x${"c".repeat(200)}Unauthorised`), { name: "RpcRequestError" }),
    { kind: "transient", signal: null },
    { cause: "infra", reason: "rpc-transport" },
  ],
  "the glued run one link down the cause chain": [
    { name: "CallExecutionError", message: "call failed", cause: { details: `0x${H130}unauthorized` } },
    { kind: "transient", signal: null },
    { cause: "infra", reason: "unclassified" },
  ],
  "the same run with a space: the provider's word, auth": [{ message: `0x${H130} unauthorized` }, { kind: "auth", signal: "unauthorized" }, { cause: "infra", reason: "rpc-auth" }],
  "'unauthorized' inside a URL path: redacted away, never matched": [
    { message: "request to https://rpc.example.com/v2/unauthorized failed" },
    { kind: "transient", signal: null },
    { cause: "infra", reason: "unclassified" },
  ],
}

describe("[A92 S-5] rpc-auth classifies the text origin/main classified", () => {
  for (const [name, [err, rpc, miss]] of Object.entries(PINNED)) {
    test(name, () => {
      assert.deepEqual(classifyRpcError(err), rpc)
      assert.deepEqual(classifyMissCause({ err }), miss)
    })
  }
})

describe("[A92 S-5] redactUrlOnly is redactUrl without the hex scrub", () => {
  test("a keyed URL is redacted by both; only redactUrl replaces the 0x run", () => {
    const text = `https://ops:pw@rpc.example.com/v2/KEYabc 0x${H130}unauthorized`
    assert.equal(redactUrlOnly(text), `https://rpc.example.com/REDACTED 0x${H130}unauthorized`)
    assert.equal(redactUrl(text), "https://rpc.example.com/REDACTED 0x<hex 130>unauthorized")
  })

  test("with no 0x run of 130+ hex digits the two agree", () => {
    for (const text of ["", "plain", `0x${"ab".repeat(64)}`, "rpc.example.com/v2/KEY", "%2F%2Fhost.example%2Fv2%2FKEY", `${H130}x`]) {
      assert.equal(redactUrlOnly(text), redactUrl(text), text)
    }
  })
})
