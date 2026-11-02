// [A71 L-4] Two keyed-URL shapes the audited redactor let through untouched:
//   1. JSON-escaped slashes — `https:\/\/host\/v2\/<key>` (a provider or proxy that escapes `/` in
//      its JSON error body, echoed into err.message): no pattern saw a URL.
//   2. A scheme glued to a word by `_` — `rpc_https://host/v2/<key>` (an env-style label in a log or
//      error line): `\b` found no boundary before `https`, so the scheme pattern never started.
//
// Fixture key only (TESTKEY); no network.
//
// Run: node --test contracts/order-engine/executor/redact-shapes.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { redactUrl, redactError, ALERT_LINK_HOSTS } from "./redact.js"

const KEY = "TESTKEY"
const HOST = "base-mainnet.g.alchemy.com"

describe("[A71 L-4] JSON-escaped slashes", () => {
  const rows = [
    [`{"error":{"url":"https:\\/\\/${HOST}\\/v2\\/${KEY}"}}`, `{"error":{"url":"https://${HOST}/REDACTED"}}`],
    [`Details: https:\\\\/\\\\/${HOST}\\\\/v2\\\\/${KEY}`, `Details: https://${HOST}/REDACTED`], // double-escaped
    [`upstream ${HOST}\\/v2\\/${KEY} refused`, `upstream ${HOST}/REDACTED refused`], // schemeless
    [`wss:\\/\\/${HOST}\\/v2\\/${KEY}`, `wss://${HOST}/REDACTED`],
  ]
  for (const [input, want] of rows) {
    test(`${input.slice(0, 48)}… → no key`, () => {
      const out = redactUrl(input)
      assert.ok(!out.includes(KEY), out)
      assert.equal(out, want)
    })
  }
})

describe("[A71 L-4] a scheme preceded by `_` (not [a-z0-9+.-])", () => {
  const rows = [
    [`rpc_https://${HOST}/v2/${KEY}`, `rpc_https://${HOST}/REDACTED`],
    [`BASE_RPC_URL_https://user:${KEY}@${HOST}/`, `BASE_RPC_URL_https://${HOST}/REDACTED`],
    [`fallback_wss://${HOST}/v2/${KEY}?x=1`, `fallback_wss://${HOST}/REDACTED`],
  ]
  for (const [input, want] of rows) {
    test(`${input.slice(0, 40)}… → no key`, () => {
      const out = redactUrl(input)
      assert.ok(!out.includes(KEY), out)
      assert.equal(out, want)
    })
  }

  test("a scheme char before the scheme still means the scheme is longer, not a new URL", () => {
    // `xhttps` is ONE scheme (custom): still a URL, still redacted — never split into `x` + `https`
    assert.equal(redactUrl(`xhttps://${HOST}/v2/${KEY}`), `xhttps://${HOST}/REDACTED`)
  })
})

describe("[A71 L-4] both shapes through the alert path helpers", () => {
  test("redactError on an Error carrying each shape keeps the host, drops the key", () => {
    for (const msg of [`HTTP request failed. URL: https:\\/\\/${HOST}\\/v2\\/${KEY}`, `bad endpoint rpc_https://${HOST}/v2/${KEY}`]) {
      const out = redactError(new Error(msg))
      assert.ok(!out.includes(KEY), out)
      assert.ok(out.includes(`https://${HOST}/REDACTED`), out)
    }
  })

  test("an allowed explorer link still survives (escaped or not)", () => {
    const tx = "0x" + "ab".repeat(32)
    assert.equal(redactUrl(`https://basescan.org/tx/${tx}`, { allowHosts: ALERT_LINK_HOSTS }), `https://basescan.org/tx/${tx}`)
    assert.equal(redactUrl(`https:\\/\\/basescan.org\\/tx\\/${tx}`, { allowHosts: ALERT_LINK_HOSTS }), `https://basescan.org/tx/${tx}`)
  })
})
