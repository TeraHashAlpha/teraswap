// [A74 S-7 (H)] The scheme pattern captured the authority through TAIL, which stops at `( ) , ' " < >`.
// A password containing one of them ended the match INSIDE the userinfo: `https://user:pa)ss@host/v2/KEY`
// matched as `https://user:pa`, found no `@`, and was returned as a bare host — the rest, `ss@host/v2/KEY`,
// stayed in the text. The userinfo is now matched on its own, as everything up to the last `@` before the
// first `/ ? #` or whitespace, so no character in a password can end it early.
//
// Fixture key only (TESTKEY); no network.
//
// Run: node --test contracts/order-engine/executor/redact-s7-userinfo.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { redactUrl, redactError } from "./redact.js"

const KEY = "TESTKEY"
const HOST = "base-mainnet.g.alchemy.com"
const CLEAN = `https://${HOST}/REDACTED`

function check(rows) {
  for (const [input, want] of rows) {
    test(`${input.slice(0, 60)}… → no key`, () => {
      const out = redactUrl(input)
      assert.ok(!out.includes(KEY), out)
      assert.equal(out, want)
    })
  }
}

describe("[A74 S-7] a password containing ( ) , ' \" < > never ends the userinfo early", () => {
  check([
    [`https://user:pa)${KEY}@${HOST}/v2/x`, CLEAN],
    [`https://user:pa(${KEY}@${HOST}/v2/x`, CLEAN],
    [`https://user:pa,${KEY}@${HOST}/v2/x`, CLEAN],
    [`https://user:pa'${KEY}@${HOST}/v2/x`, CLEAN],
    [`https://user:pa"${KEY}@${HOST}/v2/x`, CLEAN],
    [`https://user:pa<${KEY}>@${HOST}/v2/x`, CLEAN],
    [`https://user:p)(,'"<>${KEY}@${HOST}/`, CLEAN],
    [`https://${KEY})@${HOST}`, CLEAN], // bare host with userinfo: still shown as redacted
    [`wss://u:${KEY},x@${HOST}:8546/ws`, `wss://${HOST}:8546/REDACTED`],
    [`https://user:p@ss${KEY}@${HOST}/v2/x`, CLEAN], // an `@` inside the password: the LAST one splits
    [`https://a@b@c:${KEY})@${HOST}/`, CLEAN],
    [`https://user:pa)${KEY}%40${HOST}/v2/x`, CLEAN], // encoded boundary AND a paren
    [`https://user:pa)${KEY}&#x40;${HOST}/v2/x`, CLEAN],
  ])

  test("inside prose and brackets the URL ends where it ends, the rest of the sentence survives", () => {
    assert.equal(redactUrl(`(see https://user:${KEY}@${HOST}/v2/x), then retry`), `(see ${CLEAN}), then retry`)
    assert.equal(redactUrl(`"https://user:pa)${KEY}@${HOST}/v2/x" failed`), `"${CLEAN}" failed`)
    assert.equal(
      redactUrl(`a https://u:p)${KEY}@${HOST}/x b https://u:q(${KEY}@${HOST}/y c`),
      `a ${CLEAN} b ${CLEAN} c`,
    )
  })

  test("redactError on a viem-shaped message with such a password", () => {
    const out = redactError(new Error(`HTTP request failed.\n\nURL: https://svc:pa)ss${KEY}@${HOST}/v2/abc\nStatus: 403`))
    assert.ok(!out.includes(KEY) && !out.includes("ss"), out)
    assert.match(out, /URL: https:\/\/base-mainnet\.g\.alchemy\.com\/REDACTED\nStatus: 403/)
  })
})

describe("[A74 S-7] unchanged behaviour", () => {
  check([
    [`https://user:${KEY}@${HOST}/`, CLEAN],
    [`https://${KEY}@${HOST}`, CLEAN],
    [`https://${HOST}/v2/${KEY}`, CLEAN],
  ])
  test("no userinfo: bare host and a mail address after the URL are left alone", () => {
    assert.equal(redactUrl("see https://basescan.org, mail ops@teraswap.example"), "see https://basescan.org, mail ops@teraswap.example")
    assert.equal(redactUrl('<a href="https://basescan.org">x</a> a@b'), '<a href="https://basescan.org">x</a> a@b')
  })
})

describe("[A74 S-7] the userinfo scan stays linear", () => {
  const cases = {
    "scheme + 1 MB with no @": "https://" + "a".repeat(1_000_000),
    "scheme + 1 MB of @": "https://" + "@".repeat(1_000_000),
    "300k `a://`": "a://".repeat(300_000),
    "20k `a://bbb… ` segments": ("a://" + "b".repeat(30) + " ").repeat(20_000),
    "scheme + 500k parens": "https://" + "()".repeat(500_000),
    "many userinfo-ish segments": ("https://" + "u".repeat(100) + ")" + " ").repeat(10_000),
  }
  for (const [name, input] of Object.entries(cases)) {
    test(`${name} (< 3 s)`, () => {
      const t = process.hrtime.bigint()
      redactUrl(input)
      const ms = Number(process.hrtime.bigint() - t) / 1e6
      assert.ok(ms < 3_000, `${name}: ${ms.toFixed(0)} ms`)
    })
  }
})
