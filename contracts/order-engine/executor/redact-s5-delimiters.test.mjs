// [A74 S-5 (H)] The A71b S-3 fix decoded only the SLASH family (and the colon in front of `//`).
// Every other URL delimiter could still hide in the authority: `https://host%3Fapikey=KEY` has no
// `/ ? #` for the authority split to see, no tail, so the audited code returned it "as a bare host" —
// key and all. Same for `%23`, an HTML-entity `?`/`#`, a `%40` / `&#x40;` that hides the userinfo
// boundary, and every one of them stacked (`%253F`, `&amp;#x3F;`) or written without the trailing `;`
// (`&#x2F`) or as an octal escape (`\057`). A stray non-host authority (`host:KEY`) was echoed back.
//
// Fixture key only (TESTKEY); no network.
//
// Run: node --test contracts/order-engine/executor/redact-s5-delimiters.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { redactUrl, redactError } from "./redact.js"

const KEY = "TESTKEY"
const HOST = "base-mainnet.g.alchemy.com"
const CLEAN = `https://${HOST}/REDACTED`
const DROPPED = "https://[authority-redacted]/REDACTED"

function check(rows, label = (i) => i.slice(0, 56)) {
  for (const [input, want] of rows) {
    test(`${label(input)}… → no key`, () => {
      const out = redactUrl(input)
      assert.ok(!out.includes(KEY), out)
      assert.equal(out, want)
    })
  }
}

describe("[A74 S-5] %3F / %23 / %3A / %40, plain and multi-fold", () => {
  check([
    [`https://${HOST}%3Fapikey=${KEY}`, CLEAN],
    [`https://${HOST}%3fapikey=${KEY}`, CLEAN],
    [`https://${HOST}%23${KEY}`, CLEAN],
    [`https://${HOST}%253Fapikey=${KEY}`, CLEAN], // double-encoded
    [`https://${HOST}%25253Fapikey=${KEY}`, CLEAN], // triple
    [`https://${HOST}%2523${KEY}`, CLEAN],
    [`https://${HOST}%2F%3Fkey=${KEY}`, CLEAN],
    [`https%253A%252F%252F${HOST}%252Fv2%252F${KEY}`, CLEAN],
    [`https://${HOST}%3A8545%2Fv2%2F${KEY}`, `https://${HOST}:8545/REDACTED`],
    [`https://${HOST}%253A8545%252Fv2%252F${KEY}`, `https://${HOST}:8545/REDACTED`],
    [`https://user%3A${KEY}%40${HOST}/`, CLEAN], // userinfo boundary encoded
    [`https://user:${KEY}%40${HOST}/v2`, CLEAN],
    [`https://user:${KEY}%2540${HOST}/v2`, CLEAN],
    [`https://${KEY}%40${HOST}`, CLEAN],
  ])
})

describe("[A74 S-5] HTML-entity forms of ? # : @ (and stacked / unterminated)", () => {
  check([
    [`https://${HOST}&#x3F;apikey=${KEY}`, CLEAN],
    [`https://${HOST}&#63;apikey=${KEY}`, CLEAN],
    [`https://${HOST}&quest;apikey=${KEY}`, CLEAN],
    [`https://${HOST}&#x23;${KEY}`, CLEAN],
    [`https://${HOST}&#35;${KEY}`, CLEAN],
    [`https://${HOST}&num;${KEY}`, CLEAN],
    [`https://${HOST}&amp;#x3F;apikey=${KEY}`, CLEAN],
    [`https://${HOST}&amp;amp;#63;apikey=${KEY}`, CLEAN],
    [`https://user:${KEY}&#x40;${HOST}/`, CLEAN],
    [`https://user:${KEY}&#64;${HOST}/`, CLEAN],
    [`https://user:${KEY}&commat;${HOST}/`, CLEAN],
    [`https&colon;//${HOST}/v2/${KEY}`, CLEAN],
    [`https&#58;//${HOST}/v2/${KEY}`, CLEAN],
    [`https&#x3A;//${HOST}/v2/${KEY}`, CLEAN],
    // stacked slash: `&amp;#x2F;`
    [`https:&amp;#x2F;&amp;#x2F;${HOST}&amp;#x2F;v2&amp;#x2F;${KEY}`, CLEAN],
    [`https:&amp;amp;#x2F;&amp;amp;#x2F;${HOST}&amp;amp;#47;v2&amp;amp;#47;${KEY}`, CLEAN],
    // no trailing `;`
    [`https:&#x2F&#x2F${HOST}&#x2Fv2&#x2F${KEY}`, CLEAN],
    [`https:&#47&#47${HOST}&#47v2&#47${KEY}`, CLEAN],
    [`https://${HOST}&#x3Fapikey=${KEY}`, CLEAN],
    [`https://${HOST}&#x23${KEY}`, CLEAN],
    // an unterminated entity glued to hex digits still reads as the delimiter
    [`https://${HOST}&#x2F0xabc${KEY}`, CLEAN],
    // an entity that hides a percent sign: `&#37;2F` → `%2F` → `/`
    [`https://${HOST}&#37;2Fv2&#37;2F${KEY}`, CLEAN],
    [`https://${HOST}&#x25;3Fapikey=${KEY}`, CLEAN],
  ])
})

describe("[A74 S-5] octal and unicode escapes of the delimiters (\\057 \\072 \\100 \\077 \\043)", () => {
  check([
    [`https:\\057\\057${HOST}\\057v2\\057${KEY}`, CLEAN],
    [`https\\072\\057\\057${HOST}\\057v2\\057${KEY}`, CLEAN],
    [`https://user:${KEY}\\100${HOST}/`, CLEAN],
    [`https://${HOST}\\077apikey=${KEY}`, CLEAN],
    [`https://${HOST}\\043${KEY}`, CLEAN],
    [`https:\\\\057\\\\057${HOST}\\\\057v2\\\\057${KEY}`, CLEAN], // double-escaped
    [`https://${HOST}\\u003fapikey=${KEY}`, CLEAN],
    [`https://${HOST}\\u0023${KEY}`, CLEAN],
    [`https://user:${KEY}\\u0040${HOST}/`, CLEAN],
    [`https\\u003a//${HOST}/v2/${KEY}`, CLEAN],
    [`https://${HOST}\\x3fapikey=${KEY}`, CLEAN],
    [`https://${HOST}\\u{2f}v2\\u{2f}${KEY}`, CLEAN],
  ])
})

describe("[A74 S-5] an authority that is not a plain host[:port] is dropped, not echoed", () => {
  check([
    [`https://${HOST}:${KEY}`, DROPPED],
    [`https://${HOST}:${KEY}/`, DROPPED],
    [`https://${HOST};${KEY}`, DROPPED],
    [`https://${HOST}*${KEY}/v2`, DROPPED],
    [`https://${HOST}:99999999`, DROPPED],
    [`https://${KEY}!!`, DROPPED],
    [`https://${HOST}%${KEY}`, DROPPED], // an undecodable escape stays a non-host
    [`https://[${KEY}]/`, DROPPED],
    [`https:///${KEY}`, DROPPED],
  ])
})

describe("[A74 S-5] still clean → clean", () => {
  for (const s of [
    "https://basescan.org",
    "http://localhost:8545",
    "wss://[::1]:8545",
    "https://rpc.example.com/",
    "viem@2.47.10 failed at 100% load, code 0x2f",
    "time 12:30 and a%20b, 50%25 done",
    "at run (file:///srv/keeper/executor.js:10:5)",
  ]) {
    test(s, () => assert.equal(redactUrl(s), s))
  }
  test("redactError goes through the same decode", () => {
    const out = redactError(new Error(`HTTP request failed. URL: https://${HOST}%3Fapikey=${KEY}`))
    assert.ok(!out.includes(KEY), out)
    assert.ok(out.includes(`https://${HOST}/REDACTED`), out)
  })
  test("a nest of encodings deeper than the decoder will go fails closed (no key, no partial URL)", () => {
    // each round wraps the previous layer in a DIFFERENT family (`%` → `&#37;`, `#` → `%23`), so it
    // cannot be undone in one pass: 40 rounds ≫ the decoder's fold limit
    let s = `https://${HOST}%2Fv2%2F${KEY}`
    for (let i = 0; i < 40; i++) s = i % 2 === 0 ? s.replace(/%/g, "&#37;") : s.replace(/#/g, "%23")
    assert.ok(s.includes(KEY), "fixture sanity")
    const out = redactUrl(s)
    assert.ok(!out.includes(KEY), out)
    assert.ok(!/https:\/\/base-mainnet/.test(out) || out.includes("REDACTED"), out)
  })
  test("a moderate nest (6 mixed layers) is fully decoded and redacted normally", () => {
    let s = `https://${HOST}%2Fv2%2F${KEY}`
    for (let i = 0; i < 6; i++) s = i % 2 === 0 ? s.replace(/%/g, "&#37;") : s.replace(/#/g, "%23")
    assert.equal(redactUrl(s), CLEAN)
  })
})
