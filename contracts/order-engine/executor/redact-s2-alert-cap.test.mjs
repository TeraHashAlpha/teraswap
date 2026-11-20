// [fix/keeper-errors-no-signature] A87 S-2 — no keeper alert is lost for its length.
//
// Telegram refuses a sendMessage text over 4,096 characters (after entity parsing) and refuses unbalanced HTML; the
// keeper's alert.js does not read the reply, so either way the alert is silently lost. On origin/main a monitor alert
// carrying a viem timeout ran to 14,907 characters. Now:
//   - monitor.js cuts its formatted text to MONITOR_ALERT_MAX (3,500) before sending;
//   - alert.js sendTelegramAlert cuts the whole text, envelope included, to ALERT_TEXT_MAX (4,000) after its final
//     redaction pass (owner answer 3) — every keeper alert, not only the monitor's;
//   - the cut (capAlertText) never lands in a tag or an entity, closes every open tag, and ends with the marker.
//
// Run: node --test contracts/order-engine/executor/redact-s2-alert-cap.test.mjs

import { test, describe, mock } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { capAlertText, ALERT_TEXT_MAX, TRUNCATED } = await import("./redact.js")
const { sendTelegramAlert, alertOps, esc } = await import("./alert.js")
const { ExecutorMonitor, MONITOR_ALERT_MAX } = await import("./monitor.js")

const TELEGRAM_MAX = 4096

/** True when every `&` opens a whole entity and the tags close in order (what Telegram's HTML parser accepts). */
function wellFormed(html) {
  if (/&(?!(?:amp|lt|gt|quot|#\d{1,7}|#x[0-9a-f]{1,6});)/i.test(html)) return false
  const stack = []
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9-]{0,15})(?:\s[^<>]*)?>/gi)) {
    if (m[1] === "") stack.push(m[2].toLowerCase())
    else if (stack.pop() !== m[2].toLowerCase()) return false
  }
  return stack.length === 0 && !/<[^>]*$/.test(html)
}

async function captureSends(fn) {
  const sent = []
  const fetchMock = mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body).text)
    return { ok: true }
  })
  try {
    await fn()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    fetchMock.mock.restore()
  }
  return sent
}

describe("capAlertText", () => {
  test("a text that fits is returned as it is", () => {
    const s = "<b>ok</b> &amp; fine"
    assert.equal(capAlertText(s, 100), s)
  })

  test("over the limit: at most max, ends with the marker", () => {
    const out = capAlertText("word ".repeat(2_000), 500)
    assert.ok(out.length <= 500, `${out.length}`)
    assert.ok(out.endsWith("chars]") && out.includes(TRUNCATED))
  })

  test("never cuts inside an entity or a tag, and closes what is open", () => {
    const s = `<b>Title</b>\n<code>${"&amp;&lt;".repeat(400)}</code>\n<a href="https://basescan.org/tx/0xabc">${"x".repeat(5_000)}</a>`
    for (const max of [100, 211, 1_000, 3_333, 4_000]) {
      const out = capAlertText(s, max)
      assert.ok(out.length <= max, `${max}: ${out.length}`)
      assert.ok(wellFormed(out), `${max}: ${out.slice(-80)}`)
    }
  })

  test("never splits a surrogate pair", () => {
    const out = capAlertText("🚨".repeat(3_000), 1_001)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "a lone high surrogate")
  })
})

describe("monitor.js: the formatted alert is capped below Telegram's limit, never dropped", () => {
  test(`a formatted text over the limit is sent, cut to ${MONITOR_ALERT_MAX} before the envelope`, async () => {
    const m = new ExecutorMonitor({ startedAt: new Date().toISOString() })
    const sent = await captureSends(() => m._sendCooldownAlert("consecutive_errors", `⚠️ 3 consecutive errors!\nLast error: ${esc("<&>".repeat(5_000))}`))
    assert.equal(sent.length, 1)
    assert.ok(sent[0].length <= ALERT_TEXT_MAX && sent[0].includes(TRUNCATED), `${sent[0].length}`)
    assert.ok(wellFormed(sent[0]))
  })

  test("the worst redactError output (600 characters that each escape to 5) stays far below the limit", async () => {
    const m = new ExecutorMonitor({ startedAt: new Date().toISOString(), lastError: { message: "&".repeat(100_000) } })
    const sent = await captureSends(() => m.onCycleEnd(0, 3))
    assert.equal(sent.length, 1)
    assert.ok(sent[0].length < TELEGRAM_MAX && wellFormed(sent[0]), `${sent[0].length}`)
  })
})

describe("alert.js: every keeper alert is capped after the final pass, never dropped", () => {
  test("sendTelegramAlert with a 20,000-character HTML body", async () => {
    const body = `<b>Big</b>\n${"<code>0xabc</code> &amp; ".repeat(800)}`
    assert.ok(body.length > 20_000)
    const sent = await captureSends(() => sendTelegramAlert(body))
    assert.equal(sent.length, 1)
    assert.ok(sent[0].length <= ALERT_TEXT_MAX, `${sent[0].length}`)
    assert.ok(sent[0].startsWith("🚨 <b>TeraSwap Executor Alert</b>\nHost: ") && sent[0].includes(TRUNCATED))
    assert.ok(wellFormed(sent[0]))
  })

  test("an alertOps detail of 6,000 characters", async () => {
    const sent = await captureSends(() => alertOps({ kind: "rpc", detail: `balance read failed: ${"x ".repeat(3_000)}` }, 0))
    assert.equal(sent.length, 1)
    assert.ok(sent[0].length <= ALERT_TEXT_MAX && wellFormed(sent[0]), `${sent[0].length}`)
  })

  test("a short alert is unchanged by the cap", async () => {
    const sent = await captureSends(() => sendTelegramAlert("✅ Executor alive"))
    assert.ok(sent[0].endsWith("\n\n✅ Executor alive") && !sent[0].includes(TRUNCATED))
  })
})
