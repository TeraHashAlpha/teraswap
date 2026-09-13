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
import { readFileSync } from "node:fs"

// Belt-and-braces: guarantee the network stub regardless of the caller's env.
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID

const {
  alertNewDcaPosition,
  alertLowGas,
  createLowGasAlerter,
  readLowGasCooldownMs,
  LOW_GAS_ALERT_COOLDOWN_MS_DEFAULT,
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
  // One fresh alerter per call: the module-level alertLowGas cools down between breaches (below).
  const alertLowGas = (p, score) => createLowGasAlerter().alert(p, score)

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

// ─── [fix/keeper-alert-cooldown-and-dca-debug-read] low-gas cooldown + recovery ──────────────
// Seen in production 2026-09-13 (Arbitrum keeper, day one): alertLowGas had NO cooldown and
// executor.js called it every cycle the USD gas value sat under LOW_GAS_USD_THRESHOLD — with an
// active order a cycle is 30 s, so a signer at $4.98 sent one Telegram message every 30 s for
// hours. The alerter is per-process state (one process = one chain, no per-chain map): the first
// breach sends; while the breach persists it re-sends at most once per LOW_GAS_ALERT_COOLDOWN_MS
// and the next sent message carries "N suppressed since HH:MM"; the first reading back above the
// threshold sends ONE "gas balance recovered" message and resets. Date.now is faked (t.mock.timers).

const T0 = Date.UTC(2026, 8, 13, 21, 5, 0) // 2026-09-13T21:05:00Z
const HOUR = 3_600_000
const BREACH = { balanceEth: "0.001200", gasUsdValue: 4.98, thresholdUsd: 5 }
const HEALTHY = { balanceEth: "0.003000", gasUsdValue: 12.4, thresholdUsd: 5 }

test("low-gas cooldown: the first breach sends immediately, naming the threshold, with no suppressed line", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 })
  const alerter = createLowGasAlerter()

  const body = await alerter.alert(BREACH, INFO_SCORE)

  assert.equal(typeof body, "string", "first breach ⇒ sent (returns the body)")
  assert.match(body, /⛽/, "it is the low-gas alert")
  assert.ok(body.includes("0.001200 ETH"), "shows the ETH balance")
  assert.ok(body.includes("$4.98"), "shows the USD gas value (number ⇒ 2 decimals)")
  assert.ok(body.includes("threshold $5"), "names the USD threshold it breached")
  assert.ok(!/suppressed since/.test(body), "nothing was suppressed yet")
  assert.ok(body.includes(`${INFO_SCORE}/20`), "still carries the freeze-urgency line")
})

test("low-gas cooldown: breaches inside LOW_GAS_ALERT_COOLDOWN_MS are suppressed (null) — no 30 s spam", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 })
  const alerter = createLowGasAlerter({ cooldownMs: HOUR })

  assert.equal(typeof (await alerter.alert(BREACH, INFO_SCORE)), "string", "21:05:00 ⇒ sent")
  t.mock.timers.tick(30_000)
  assert.equal(await alerter.alert(BREACH, INFO_SCORE), null, "21:05:30 ⇒ suppressed")
  t.mock.timers.tick(30_000)
  assert.equal(await alerter.alert(BREACH, INFO_SCORE), null, "21:06:00 ⇒ suppressed")
  t.mock.timers.tick(HOUR - 60_000 - 1)
  assert.equal(await alerter.alert(BREACH, INFO_SCORE), null, "1 ms short of the cooldown ⇒ still suppressed")
})

test("low-gas cooldown: after the cooldown the breach re-sends with 'N suppressed since HH:MM', then the count resets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 })
  const alerter = createLowGasAlerter({ cooldownMs: HOUR })

  await alerter.alert(BREACH, INFO_SCORE) // 21:05:00 sent
  t.mock.timers.tick(30_000)
  await alerter.alert(BREACH, INFO_SCORE) // 21:05:30 suppressed #1
  t.mock.timers.tick(30_000)
  await alerter.alert(BREACH, INFO_SCORE) // 21:06:00 suppressed #2
  t.mock.timers.tick(HOUR - 60_000 - 1)
  await alerter.alert(BREACH, INFO_SCORE) // 22:04:59.999 suppressed #3
  t.mock.timers.tick(1)                   // exactly LOW_GAS_ALERT_COOLDOWN_MS after the last send

  const body = await alerter.alert(BREACH, INFO_SCORE)
  assert.equal(typeof body, "string", "cooldown elapsed ⇒ sent")
  assert.match(body, /⛽/)
  assert.ok(body.includes("3 suppressed since 21:05 UTC"), `suppressed count + first-suppressed time:\n${body}`)

  // The counter is reset by that send: an hour later, with nothing suppressed in between, no line.
  t.mock.timers.tick(HOUR)
  const again = await alerter.alert(BREACH, INFO_SCORE)
  assert.equal(typeof again, "string")
  assert.ok(!/suppressed since/.test(again), "count reset after the send")
})

test("low-gas cooldown: the first reading back above the threshold sends ONE 'gas balance recovered' and resets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 })
  const alerter = createLowGasAlerter({ cooldownMs: HOUR })

  await alerter.alert(BREACH, INFO_SCORE) // 21:05:00 sent
  t.mock.timers.tick(30_000)
  await alerter.alert(BREACH, INFO_SCORE) // 21:05:30 suppressed #1
  t.mock.timers.tick(30_000)

  const recovered = await alerter.alert(HEALTHY, INFO_SCORE)
  assert.equal(typeof recovered, "string", "breach → healthy ⇒ recovery sent")
  assert.match(recovered, /Gas balance recovered/)
  assert.ok(!/⛽/.test(recovered), "it is not another low-gas alert")
  assert.ok(recovered.includes("0.003000 ETH"), "shows the recovered ETH balance")
  assert.ok(recovered.includes("$12.40"), "shows the recovered USD value")
  assert.ok(recovered.includes("threshold $5"), "names the threshold")
  assert.ok(recovered.includes("1 suppressed since 21:05 UTC"), "the pending suppressed count rides on the recovery message")

  // Reset: a NEW breach right after sends immediately again — no cooldown or count carried over.
  t.mock.timers.tick(30_000)
  const fresh = await alerter.alert(BREACH, INFO_SCORE)
  assert.equal(typeof fresh, "string", "new breach after recovery ⇒ sent at once")
  assert.match(fresh, /⛽/)
  assert.ok(!/suppressed since/.test(fresh), "no stale count")
})

test("low-gas cooldown: a second healthy reading without a new breach sends nothing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 })
  const alerter = createLowGasAlerter({ cooldownMs: HOUR })

  await alerter.alert(BREACH, INFO_SCORE)
  t.mock.timers.tick(30_000)
  assert.equal(typeof (await alerter.alert(HEALTHY, INFO_SCORE)), "string", "first healthy ⇒ recovery")
  t.mock.timers.tick(30_000)
  assert.equal(await alerter.alert(HEALTHY, INFO_SCORE), null, "second healthy ⇒ silent")
  t.mock.timers.tick(HOUR)
  assert.equal(await alerter.alert(HEALTHY, INFO_SCORE), null, "still silent an hour on — recovery is one-shot")
})

test("low-gas cooldown: a healthy balance with no prior breach sends nothing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 })
  const alerter = createLowGasAlerter()
  assert.equal(await alerter.alert(HEALTHY, INFO_SCORE), null)
  t.mock.timers.tick(HOUR)
  assert.equal(await alerter.alert(HEALTHY, INFO_SCORE), null)
})

test("low-gas cooldown: exactly-at-threshold is NOT a breach (the rule is strictly below)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 })
  const alerter = createLowGasAlerter()
  assert.equal(await alerter.alert({ balanceEth: "0.002", gasUsdValue: 5, thresholdUsd: 5 }, INFO_SCORE), null)
  assert.equal(typeof (await alerter.alert({ balanceEth: "0.002", gasUsdValue: 4.999, thresholdUsd: 5 }, INFO_SCORE)), "string")
})

test("LOW_GAS_ALERT_COOLDOWN_MS: default 3600000; a non-negative integer overrides; blank / non-numeric / negative fall back", () => {
  assert.equal(LOW_GAS_ALERT_COOLDOWN_MS_DEFAULT, 3_600_000)
  assert.equal(readLowGasCooldownMs({}), 3_600_000)
  assert.equal(readLowGasCooldownMs({ LOW_GAS_ALERT_COOLDOWN_MS: "600000" }), 600_000)
  assert.equal(readLowGasCooldownMs({ LOW_GAS_ALERT_COOLDOWN_MS: "0" }), 0, "0 ⇒ no cooldown (every breach sends)")
  assert.equal(readLowGasCooldownMs({ LOW_GAS_ALERT_COOLDOWN_MS: "" }), 3_600_000)
  assert.equal(readLowGasCooldownMs({ LOW_GAS_ALERT_COOLDOWN_MS: "soon" }), 3_600_000)
  assert.equal(readLowGasCooldownMs({ LOW_GAS_ALERT_COOLDOWN_MS: "-5" }), 3_600_000)
  assert.equal(readLowGasCooldownMs({ LOW_GAS_ALERT_COOLDOWN_MS: "1.5e3" }), 3_600_000, "integers only")
})

test("createLowGasAlerter() reads LOW_GAS_ALERT_COOLDOWN_MS at ALERT time (env.js loads the file after import)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 })
  const alerter = createLowGasAlerter() // no cooldownMs ⇒ env, read lazily
  const prev = process.env.LOW_GAS_ALERT_COOLDOWN_MS
  process.env.LOW_GAS_ALERT_COOLDOWN_MS = "120000"
  try {
    assert.equal(typeof (await alerter.alert(BREACH, INFO_SCORE)), "string")
    t.mock.timers.tick(119_999)
    assert.equal(await alerter.alert(BREACH, INFO_SCORE), null, "inside the 2-minute env cooldown")
    t.mock.timers.tick(1)
    assert.equal(typeof (await alerter.alert(BREACH, INFO_SCORE)), "string", "env cooldown elapsed")
  } finally {
    if (prev === undefined) delete process.env.LOW_GAS_ALERT_COOLDOWN_MS
    else process.env.LOW_GAS_ALERT_COOLDOWN_MS = prev
  }
})

test("alertLowGas (module export) IS the per-process alerter: thresholdUsd omitted ⇒ breach (caller pre-decided), and it cools down", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 })
  // Drive the shared instance to a known not-in-breach state whatever earlier tests did to it.
  await alertLowGas(HEALTHY, INFO_SCORE)

  const first = await alertLowGas({ balanceEth: "0.004", gasUsdValue: "0.80" }, WARN_SCORE)
  assert.equal(typeof first, "string", "legacy shape (no thresholdUsd) still sends on first call")
  assert.ok(first.includes("$0.80"), "string USD values are rendered verbatim")
  assert.ok(!first.includes("threshold"), "no threshold line when none was given")
  t.mock.timers.tick(30_000)
  assert.equal(await alertLowGas({ balanceEth: "0.004", gasUsdValue: "0.80" }, WARN_SCORE), null, "30 s later ⇒ suppressed")
  t.mock.timers.tick(HOUR)
  const later = await alertLowGas({ balanceEth: "0.004", gasUsdValue: "0.80" }, WARN_SCORE)
  assert.equal(typeof later, "string")
  assert.ok(later.includes("1 suppressed since 21:05 UTC"))
  // Leave the shared instance recovered for any test that follows.
  await alertLowGas(HEALTHY, INFO_SCORE)
})

test("low-gas alerts keep the sendTelegramAlert envelope (Host / Time / Chain stamp); suppressed cycles never reach Telegram", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 })
  const posted = []
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    posted.push(JSON.parse(init.body))
    return { ok: true }
  })
  const prevChain = process.env.CHAIN_ID
  process.env.TELEGRAM_BOT_TOKEN = "test-token"
  process.env.TELEGRAM_CHAT_ID = "test-chat"
  process.env.CHAIN_ID = "42161"
  try {
    const alerter = createLowGasAlerter({ cooldownMs: HOUR })
    await alerter.alert(BREACH, INFO_SCORE)   // sent
    t.mock.timers.tick(30_000)
    await alerter.alert(BREACH, INFO_SCORE)   // suppressed ⇒ no POST
    t.mock.timers.tick(30_000)
    await alerter.alert(HEALTHY, INFO_SCORE)  // recovery ⇒ sent
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
    if (prevChain === undefined) delete process.env.CHAIN_ID
    else process.env.CHAIN_ID = prevChain
  }

  assert.equal(posted.length, 2, "1 breach + 1 recovery; the suppressed cycle never reached Telegram")
  assert.match(posted[0].text, /Low gas balance/)
  assert.match(posted[1].text, /Gas balance recovered/)
  for (const p of posted) {
    assert.match(p.text, /TeraSwap Executor Alert/)
    assert.match(p.text, /\nChain: 42161\n/, "the existing Chain: stamp is kept")
    assert.match(p.text, /\nTime: 2026-09-13T21:0/, "the existing Time: stamp is kept")
  }
})

test("executor.js wiring: alertLowGas runs EVERY cycle with thresholdUsd — no caller-side guard, so recovery is observable", () => {
  const src = readFileSync(new URL("./executor.js", import.meta.url), "utf-8")
  const from = "// ETH/USD for the low-gas signal"
  const a = src.indexOf(from)
  assert.ok(a >= 0, `anchor not found in executor.js: ${JSON.stringify(from)}`)
  const b = src.indexOf("return ctx", a)
  assert.ok(b >= 0, "end anchor 'return ctx' not found after the low-gas block")
  const block = src.slice(a, b)

  assert.ok(
    !block.includes("if (gasUsdValue < LOW_GAS_USD_THRESHOLD)"),
    "the caller must not pre-filter: alertLowGas needs to see the healthy cycles to send the recovery",
  )
  const calls = block.match(/await alertLowGas\(/g) || []
  assert.equal(calls.length, 1, "exactly one alertLowGas call in the block")
  assert.match(block, /thresholdUsd: LOW_GAS_USD_THRESHOLD/, "the threshold is passed in, not applied by the caller")
  assert.match(block, /gasUsdValue,|gasUsdValue: gasUsdValue\b/, "the raw USD number is passed (the alerter compares and formats)")
})
