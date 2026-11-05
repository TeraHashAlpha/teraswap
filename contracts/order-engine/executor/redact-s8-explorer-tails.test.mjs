// [A74 S-8 (H)] `allowHosts` kept ANY URL on an allow-listed explorer host that had a path — the host
// was the whole test. A keyed URL on such a host (`https://basescan.org/api?apikey=KEY`, `…/v2/KEY`, a
// query or fragment appended to a real tx link) therefore went to Telegram untouched. A link survives
// only when its tail is exactly `/tx|address|block/0x<hex>` — the shapes event-watcher.js builds — and
// its authority is exactly an allowed host (no port, no userinfo).
//
// Fixture key only (TESTKEY); no network.
//
// Run: node --test contracts/order-engine/executor/redact-s8-explorer-tails.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { redactUrl, ALERT_LINK_HOSTS } from "./redact.js"

const KEY = "TESTKEY"
const TX = "0x" + "ab".repeat(32)
const ADDR = "0x" + "cd".repeat(20)
const allow = { allowHosts: ALERT_LINK_HOSTS }

describe("[A74 S-8] the three link shapes the keeper builds survive", () => {
  for (const url of [
    `https://basescan.org/tx/${TX}`,
    `https://etherscan.io/tx/${TX}`,
    `https://sepolia.etherscan.io/tx/${TX}`,
    `https://arbiscan.io/tx/${TX}`,
    `https://basescan.org/address/${ADDR}`,
    `https://basescan.org/block/0x1a2b3c`,
    `https://BaseScan.org/tx/0x${"AB".repeat(32)}`,
    `HTTPS://basescan.org/tx/${TX}`,
    `https://basescan.org/tx/0xabc`,
  ]) {
    test(`kept: ${url.slice(0, 64)}`, () => assert.equal(redactUrl(url, allow), url))
  }

  test("inside the exact markup sendTelegramAlert sees", () => {
    const msg = `Tx: <a href="https://basescan.org/tx/${TX}">${TX.slice(0, 18)}...</a>\nTx (${`https://arbiscan.io/tx/${TX}`}), done`
    assert.equal(redactUrl(msg, allow), msg)
  })
})

describe("[A74 S-8] anything else on an allowed host is redacted, key and all", () => {
  const rows = [
    [`https://basescan.org/api?module=account&action=txlist&apikey=${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/v2/${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/${TX}?apikey=${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/${TX}#${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/${TX}/${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/${TX}%2F${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/${TX}%3Fapikey=${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/${TX}&#x3F;apikey=${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/${TX}.${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/0x${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/tx/0x`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/address/${ADDR}/${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/token/${ADDR}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/txs?a=${ADDR}&apikey=${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org/../v2/${KEY}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org//tx/${TX}`, "https://basescan.org/REDACTED"],
    [`https://basescan.org:443/tx/${TX}`, "https://basescan.org:443/REDACTED"],
    [`https://user:${KEY}@basescan.org/tx/${TX}`, "https://basescan.org/REDACTED"],
    [`https://etherscan.io/api?apikey=${KEY}`, "https://etherscan.io/REDACTED"],
    [`https://arbiscan.io/v2/api?apikey=${KEY}`, "https://arbiscan.io/REDACTED"],
    [`https://sepolia.etherscan.io/api?apikey=${KEY}`, "https://sepolia.etherscan.io/REDACTED"],
    [`basescan.org/tx/${TX}`, "basescan.org/REDACTED"], // schemeless: never a link the keeper builds
  ]
  for (const [input, want] of rows) {
    test(`${input.slice(0, 70)}… → no key`, () => {
      const out = redactUrl(input, allow)
      assert.ok(!out.includes(KEY), out)
      assert.equal(out, want)
    })
  }

  test("a good link and a keyed URL on the same host in one message: only the good one survives", () => {
    const good = `https://basescan.org/tx/${TX}`
    const out = redactUrl(`${good} then https://basescan.org/v2/${KEY} and ${good}`, allow)
    assert.equal(out, `${good} then https://basescan.org/REDACTED and ${good}`)
  })

  test("without allowHosts nothing survives (unchanged)", () => {
    assert.equal(redactUrl(`https://basescan.org/tx/${TX}`), "https://basescan.org/REDACTED")
  })

  test("a host that is not on the list is redacted even with a perfect tail", () => {
    assert.equal(redactUrl(`https://evil.example/tx/${TX}`, allow), "https://evil.example/REDACTED")
    assert.equal(redactUrl(`https://basescan.org.evil.example/tx/${TX}`, allow), "https://basescan.org.evil.example/REDACTED")
  })
})
