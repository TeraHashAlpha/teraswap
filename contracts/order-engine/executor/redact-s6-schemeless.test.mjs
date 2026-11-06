// [A74 S-6 (H)] The two SCHEMELESS patterns (`host:port/…`, `dotted.host/…`) still carried the lookbehind
// boundary `(?<![\w/:.@-])` that A71b S-3 removed from the scheme pattern, so a keyed URL was passed
// untouched whenever the host was written right after a `/`, `:`, `@`, `.` or `-`, or glued to a word
// character: the `%2F` → `/` decode S-3 added made `GET /rpc/host%2Fv2%2FKEY` a regression (the decoded
// `/` is now in front of the host), and `0x<64 hex>host.example/v2/KEY` had no valid start at all.
//
// Fixture key only (TESTKEY); no network.
//
// Run: node --test contracts/order-engine/executor/redact-s6-schemeless.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { redactUrl, redactError, ALERT_LINK_HOSTS } from "./redact.js"

const KEY = "TESTKEY"
const HOST = "base-mainnet.g.alchemy.com"
const HASH = "0x" + "ab".repeat(32) // 66 characters, all host-label characters

function check(rows) {
  for (const [input, want] of rows) {
    test(`${input.slice(0, 60)}… → no key`, () => {
      const out = redactUrl(input)
      assert.ok(!out.includes(KEY), out)
      assert.equal(out, want)
    })
  }
}

describe("[A74 S-6] a schemeless host right after / : @ . - or a word character", () => {
  check([
    [`GET /rpc/${HOST}/v2/${KEY}`, `GET /rpc/${HOST}/REDACTED`],
    [`GET /rpc/${HOST}%2Fv2%2F${KEY}`, `GET /rpc/${HOST}/REDACTED`], // the S-3 decode regression
    [`proxy//${HOST}/v2/${KEY}`, `proxy//${HOST}/REDACTED`],
    [`url:${HOST}/v2/${KEY}`, `url:${HOST}/REDACTED`],
    [`endpoint=${HOST}/v2/${KEY}`, `endpoint=${HOST}/REDACTED`],
    [`via-${HOST}/v2/${KEY}`, `via-${HOST}/REDACTED`],
    [`${HASH}${HOST}/v2/${KEY}`, `${HASH}${HOST}/REDACTED`], // 0x<64 hex> glued
    [`tx ${HASH}${HOST}?apikey=${KEY}`, `tx ${HASH}${HOST}/REDACTED`],
    [`${"a".repeat(300)}.${HOST}/v2/${KEY}`, `${"a".repeat(300)}.${HOST}/REDACTED`],
  ])
})

describe("[A74 S-6] host:port, after / : @ . - or glued", () => {
  check([
    [`GET /rpc/127.0.0.1:8545/v2/${KEY}`, `GET /rpc/127.0.0.1:8545/REDACTED`],
    [`GET /rpc/localhost%3A8545%2Fv2%2F${KEY}`, `GET /rpc/localhost:8545/REDACTED`],
    [`url:[::1]:8545/v2/${KEY}`, `url:[::1]:8545/REDACTED`],
    [`x/[::1]:8545/v2/${KEY}`, `x/[::1]:8545/REDACTED`],
    [`${HASH}127.0.0.1:8545/v2/${KEY}`, `${HASH}127.0.0.1:8545/REDACTED`],
    [`node-a:8545/v2/${KEY}`, `node-a:8545/REDACTED`],
  ])
})

describe("[A74 S-6] schemeless user:password@host/path (the `@` used to block the match)", () => {
  check([
    [`conn user:${KEY}@${HOST}/v2/x`, `conn ${HOST}/REDACTED`],
    [`user:${KEY}@127.0.0.1:8545/v2/x`, `127.0.0.1:8545/REDACTED`],
    [`rpc=${KEY}@${HOST}?x=1`, `${HOST}/REDACTED`],
    [`https://user:${KEY}@${HOST}/v2/x and ${KEY}2@${HOST}/v2/y`, `https://${HOST}/REDACTED and ${HOST}/REDACTED`],
  ])
  test("an e-mail address with no path is not touched", () => {
    assert.equal(redactUrl("mail ops@teraswap.example now"), "mail ops@teraswap.example now")
  })
})

describe("[A74 S-6] nothing that was already handled is re-entered, and idempotence holds", () => {
  test("a redacted scheme URL and an allowed explorer link are left exactly as they are", () => {
    const tx = "0x" + "cd".repeat(32)
    const link = `<a href="https://basescan.org/tx/${tx}">tx</a>`
    assert.equal(redactUrl(link, { allowHosts: ALERT_LINK_HOSTS }), link)
    const once = redactUrl(`a https://${HOST}/v2/${KEY} b ${HOST}/v2/${KEY} c 127.0.0.1:8545/v2/${KEY}`)
    assert.equal(once, `a https://${HOST}/REDACTED b ${HOST}/REDACTED c 127.0.0.1:8545/REDACTED`)
    assert.equal(redactUrl(once), once)
  })

  test("bare hosts, versions, file frames and prose stay as they are", () => {
    for (const s of [
      "https://basescan.org",
      "viem@2.47.10 timed out after 30ms",
      "see docs/Runbooks/EXECUTOR-OPERATIONS.md",
      "at main (file:///srv/keeper/contracts/order-engine/executor/executor.js:2210:5)",
      "block 12345 mined at 12:30:45, load 50%",
      "POST /api/admin/dca-freeze",
    ]) {
      assert.equal(redactUrl(s), s)
    }
  })

  test("redactError applies it too", () => {
    const out = redactError(new Error(`bad upstream /rpc/${HOST}%2Fv2%2F${KEY} (${HASH}${HOST}/v2/${KEY})`))
    assert.ok(!out.includes(KEY), out)
  })
})

describe("[A74 S-6] no boundary must not cost a quadratic scan", () => {
  const cases = {
    "1 MB of host characters": "a".repeat(1_000_000),
    "1 MB of slashes": "/".repeat(1_000_000),
    "500k `a/`": "a/".repeat(500_000),
    "500k `a.`": "a.".repeat(500_000),
    "300k `x.com/`": "x.com/".repeat(300_000),
    "300k `a:1/`": "a:1/".repeat(300_000),
    "300k `@a.bc/`": "@a.bc/".repeat(300_000),
    "1 MB of `@`": "@".repeat(1_000_000),
    "label chain": ("a".repeat(63) + ".").repeat(20_000),
  }
  for (const [name, input] of Object.entries(cases)) {
    test(`${name} stays linear (< 3 s)`, () => {
      const t = process.hrtime.bigint()
      redactUrl(input)
      const ms = Number(process.hrtime.bigint() - t) / 1e6
      assert.ok(ms < 3_000, `${name}: ${ms.toFixed(0)} ms`)
    })
  }
})
