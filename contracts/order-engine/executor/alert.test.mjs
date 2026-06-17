/**
 * Tests for the freeze-observability alert builders in alert.js.
 *
 * Network is stubbed by ENSURING TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are
 * absent — sendTelegramAlert then logs-only and returns without any fetch, so
 * no real Telegram API call is ever made. Each builder also RETURNS the HTML
 * body it built, which is what we assert against.
 *
 * Run: node --test contracts/order-engine/executor/alert.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

// Belt-and-braces: guarantee the network stub regardless of the caller's env.
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID

const {
  alertNewDcaPosition,
  alertLowGas,
  alertUnexplainedOutflow,
  alertOps,
} = await import("./alert.js")

// Score fixtures aligned with scoreTier: info <8, warn 8..14, critical >=15.
const INFO_SCORE = 3
const WARN_SCORE = 10
const CRITICAL_SCORE = 17

const WARN_TAIL = "⚠️ consider freezing — POST /api/admin/dca-freeze"
const CRITICAL_TAIL = "🛑 strongly consider freezing NOW — POST /api/admin/dca-freeze"

test("alertNewDcaPosition: score line, emoji, key fields, duration = interval × total", async () => {
  const body = await alertNewDcaPosition(
    {
      tokenInSymbol: "USDC",
      tokenOutSymbol: "WETH",
      amountInHuman: "1000",
      dcaInterval: 3600,
      dcaTotal: 24,
      perChunkHuman: "41.666",
    },
    INFO_SCORE,
  )

  assert.match(body, /🆕/, "has the new-position emoji")
  assert.ok(body.includes(`${INFO_SCORE}/20`), "includes score /20")
  assert.ok(body.includes("(info)"), "info tier label")
  // token in → out
  assert.ok(body.includes("USDC → WETH"), "shows token in → out")
  // parts
  assert.ok(body.includes("24 parts"), "shows number of parts")
  assert.ok(body.includes("3600s"), "shows the interval")
  // duration = interval × total = 3600 × 24 = 86400
  assert.ok(body.includes("86400s"), "duration = interval × total")
  assert.ok(body.includes("41.666"), "shows per-chunk amount")
  // info tier ⇒ no escalation tail
  assert.ok(!body.includes(WARN_TAIL), "no warn tail for info")
  assert.ok(!body.includes(CRITICAL_TAIL), "no critical tail for info")
})

test("alertLowGas: warn tier appends the warn escalation tail", async () => {
  const body = await alertLowGas({ balanceEth: "0.004", gasUsdValue: "0.80" }, WARN_SCORE)

  assert.match(body, /⛽/, "has the low-gas emoji")
  assert.ok(body.includes(`${WARN_SCORE}/20`), "includes score /20")
  assert.ok(body.includes("(warn)"), "warn tier label")
  assert.ok(body.includes("0.004 ETH"), "shows ETH balance")
  assert.ok(body.includes("$0.80"), "shows USD gas value")
  assert.ok(body.includes(WARN_TAIL), "appends warn escalation tail")
  assert.ok(!body.includes(CRITICAL_TAIL), "no critical tail at warn tier")
})

test("alertUnexplainedOutflow: critical tier appends the critical escalation tail", async () => {
  const wallet = "0x9A38b9aDc1e6F0c2E7B7E1d2C3a4B5c6D7e8F9a0"
  const body = await alertUnexplainedOutflow(
    { outflowEth: "2.5", thresholdEth: "1.0", walletAddress: wallet },
    CRITICAL_SCORE,
  )

  assert.match(body, /💸/, "has the outflow emoji")
  assert.ok(body.includes(`${CRITICAL_SCORE}/20`), "includes score /20")
  assert.ok(body.includes("(critical)"), "critical tier label")
  assert.ok(body.includes(wallet), "shows the wallet address")
  assert.ok(body.includes("2.5 ETH"), "shows outflow amount")
  assert.ok(body.includes("threshold 1.0 ETH"), "shows threshold")
  assert.ok(body.includes(CRITICAL_TAIL), "appends critical escalation tail")
  assert.ok(!body.includes(WARN_TAIL), "no warn tail at critical tier")
})

test("alertOps: kind + detail rendered, score line present", async () => {
  const body = await alertOps({ kind: "stale-lock", detail: "lock age 9m > 5m" }, INFO_SCORE)

  assert.match(body, /🛠️/, "has the ops emoji")
  assert.ok(body.includes("stale-lock"), "shows the ops kind")
  assert.ok(body.includes("lock age 9m"), "shows the detail")
  assert.ok(body.includes(`${INFO_SCORE}/20`), "includes score /20")
  assert.ok(body.includes("(info)"), "info tier label")
})

test("escalation tails switch exactly at the tier thresholds (8 / 15)", async () => {
  const base = { balanceEth: "0", gasUsdValue: "0" }

  const at7 = await alertLowGas(base, 7)
  assert.ok(!at7.includes(WARN_TAIL) && !at7.includes(CRITICAL_TAIL), "score 7 ⇒ info, no tail")

  const at8 = await alertLowGas(base, 8)
  assert.ok(at8.includes(WARN_TAIL), "score 8 ⇒ warn tail")
  assert.ok(!at8.includes(CRITICAL_TAIL), "score 8 ⇒ not critical")

  const at14 = await alertLowGas(base, 14)
  assert.ok(at14.includes(WARN_TAIL) && !at14.includes(CRITICAL_TAIL), "score 14 ⇒ warn")

  const at15 = await alertLowGas(base, 15)
  assert.ok(at15.includes(CRITICAL_TAIL), "score 15 ⇒ critical tail")
  assert.ok(!at15.includes(WARN_TAIL), "score 15 ⇒ not warn")
})

test("builders never throw and never hit the network (TELEGRAM_* unset)", async () => {
  // If a real network call happened with bad env, sendTelegramAlert would still
  // swallow it; here we just assert the happy-path returns a non-empty string.
  const body = await alertOps({ kind: "rpc", detail: "primary RPC unreachable" }, CRITICAL_SCORE)
  assert.equal(typeof body, "string")
  assert.ok(body.length > 0)
  assert.ok(body.includes(CRITICAL_TAIL))
})
