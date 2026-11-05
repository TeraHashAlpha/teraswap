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

// ─── [A71b S-3] ──────────────────────────────────────────────────────────────────────────────────
// The L-4 fix started a scheme only where the previous character could not be part of one
// (`(?<![a-z0-9+.-])`). A URL glued to 27+ scheme characters — e.g. a 0x address (42 chars) written
// straight in front of it — has no valid start (the scheme is capped at 31 characters, and every
// later start is preceded by a scheme character), so the whole URL passed untouched. And a
// percent-encoded slash (`%2F`) or a unicode / HTML-entity slash hid the path from every pattern.

describe("[A71b S-3] a scheme glued to 27+ scheme characters (no boundary)", () => {
  const ADDR = "0x" + "ab12".repeat(10) // 42 chars, all scheme characters
  const rows = [
    [`${ADDR}https://${HOST}/v2/${KEY}`, `${ADDR}https://${HOST}/REDACTED`],
    [`${"a".repeat(30)}https://${HOST}/v2/${KEY}`, `${"a".repeat(30)}https://${HOST}/REDACTED`],
    [`${"a".repeat(500)}wss://user:${KEY}@${HOST}/ws`, `${"a".repeat(500)}wss://${HOST}/REDACTED`],
    [`${ADDR}rpc_https://${HOST}/v2/${KEY}`, `${ADDR}rpc_https://${HOST}/REDACTED`],
    [`tx ${ADDR}https://${HOST}/v2/${KEY} failed, retry ${ADDR}https://${HOST}/v2/${KEY}`, `tx ${ADDR}https://${HOST}/REDACTED failed, retry ${ADDR}https://${HOST}/REDACTED`],
  ]
  for (const [input, want] of rows) {
    test(`${input.slice(0, 44)}… → no key`, () => {
      const out = redactUrl(input)
      assert.ok(!out.includes(KEY), out)
      assert.equal(out, want)
    })
  }

  test("redactError keeps the glued prefix and the host, drops the key", () => {
    const out = redactError(new Error(`bad endpoint ${ADDR}https://${HOST}/v2/${KEY}`))
    assert.ok(!out.includes(KEY), out)
    assert.ok(out.includes(`https://${HOST}/REDACTED`), out)
  })

  test("a file:// frame behind a short prefix is still a stack frame; a long run of scheme characters stays linear", () => {
    assert.equal(redactUrl("at run (file:///srv/keeper/executor.js:10:5)"), "at run (file:///srv/keeper/executor.js:10:5)")
    const t = process.hrtime.bigint()
    redactUrl("a".repeat(1_000_000))
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 2_000, "no backtracking blow-up on 1 MB of scheme characters")
  })
})

describe("[A71b S-3] an encoded slash is decoded first (%2F, \\u002f, \\x2f, &#x2F;, &#47;, &sol;)", () => {
  const rows = [
    [`https://${HOST}%2Fv2%2F${KEY}`, `https://${HOST}/REDACTED`],
    [`https://${HOST}%2fv2%2f${KEY}`, `https://${HOST}/REDACTED`],
    [`https%3A%2F%2F${HOST}%2Fv2%2F${KEY}`, `https://${HOST}/REDACTED`],
    [`https%3a%2f%2f${HOST}%2fv2%2f${KEY}`, `https://${HOST}/REDACTED`],
    [`https://${HOST}%252Fv2%252F${KEY}`, `https://${HOST}/REDACTED`], // double-encoded
    [`upstream ${HOST}%2Fv2%2F${KEY} refused`, `upstream ${HOST}/REDACTED refused`], // schemeless
    [`https://${HOST}\\u002fv2\\u002f${KEY}`, `https://${HOST}/REDACTED`],
    [`https:\\\\u002f\\\\u002f${HOST}\\\\u002fv2\\\\u002f${KEY}`, `https://${HOST}/REDACTED`], // double-escaped
    [`https://${HOST}\\x2fv2\\x2f${KEY}`, `https://${HOST}/REDACTED`],
    [`https:&#x2F;&#x2F;${HOST}&#x2F;v2&#x2F;${KEY}`, `https://${HOST}/REDACTED`],
    [`https://${HOST}&#47;v2&#47;${KEY}`, `https://${HOST}/REDACTED`],
    [`https:&sol;&sol;${HOST}&sol;v2&sol;${KEY}`, `https://${HOST}/REDACTED`],
  ]
  for (const [input, want] of rows) {
    test(`${input.slice(0, 52)}… → no key`, () => {
      const out = redactUrl(input)
      assert.ok(!out.includes(KEY), out)
      assert.equal(out, want)
    })
  }

  test("the glued prefix AND an encoded slash together", () => {
    const addr = "0x" + "cd34".repeat(10)
    const out = redactUrl(`${addr}https%3A%2F%2F${HOST}%2Fv2%2F${KEY}`)
    assert.ok(!out.includes(KEY), out)
    assert.equal(out, `${addr}https://${HOST}/REDACTED`)
  })

  test("an allowed explorer link survives, plain or %2F-encoded; unrelated text is not mangled", () => {
    const tx = "0x" + "ab".repeat(32)
    assert.equal(redactUrl(`https://basescan.org/tx/${tx}`, { allowHosts: ALERT_LINK_HOSTS }), `https://basescan.org/tx/${tx}`)
    assert.equal(redactUrl(`https://basescan.org%2Ftx%2F${tx}`, { allowHosts: ALERT_LINK_HOSTS }), `https://basescan.org/tx/${tx}`)
    assert.equal(redactUrl("viem@2.47.10 failed at 100% load, code 0x2f"), "viem@2.47.10 failed at 100% load, code 0x2f")
  })
})
