/**
 * Telegram alerting for the TeraSwap executor.
 * Fail-safe: never throws — if Telegram is unreachable, logs warning and continues.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN — Bot token from @BotFather
 *   TELEGRAM_CHAT_ID  — Chat/group ID for alerts
 */

import { hostname } from "os"
import { scoreTier } from "./freeze-score.js"

const HOST = hostname()

/**
 * Minimal HTML escaping for values interpolated into a Telegram HTML body.
 * Telegram's HTML parse_mode only requires &, <, > to be escaped.
 * @param {unknown} v
 * @returns {string}
 */
function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * Build the "Freeze-urgency: N/20 (tier)" line plus an escalation tail whose
 * tone is driven by scoreTier(score):
 *   - info     ⇒ neutral, no tail
 *   - warn     ⇒ "⚠️ consider freezing — POST /api/admin/dca-freeze"
 *   - critical ⇒ "🛑 strongly consider freezing NOW — POST /api/admin/dca-freeze"
 * Returned as an array of lines (so callers can spread it into the body).
 * @param {number} score
 * @returns {string[]}
 */
function scoreLines(score) {
  const tier = scoreTier(score)
  const lines = [`Freeze-urgency: ${score}/20 (${tier})`]
  if (tier === "critical") {
    lines.push("🛑 strongly consider freezing NOW — POST /api/admin/dca-freeze")
  } else if (tier === "warn") {
    lines.push("⚠️ consider freezing — POST /api/admin/dca-freeze")
  }
  return lines
}

/**
 * Send a Telegram alert message. Never throws.
 * @param {string} message — Alert body (HTML allowed)
 */
export async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  // [KEEPER-ENV-ORDER] Read at SEND time, like token/chatId above — a module-scope
  // capture ran before .env.executor was loaded and froze the "1" default (a Base
  // keeper alerting "Chain: 1"). Lazy reads are evaluation-order-proof.
  // [FIX-KEEPER-MULTICHAIN-INSTANCE-IDENTITY] No "1" fallback any more: an unset CHAIN_ID
  // cannot reach this line from the keeper (executor.js refuses to boot without it), and a
  // direct caller with no chain must not be stamped as mainnet — say "unset" instead.
  const chainId = process.env.CHAIN_ID || "unset"

  if (!token || !chatId) {
    console.warn("[ALERT] Telegram not configured, skipping alert")
    return
  }

  const now = new Date().toISOString()
  const text = [
    `🚨 <b>TeraSwap Executor Alert</b>`,
    `Host: ${HOST}`,
    `Time: ${now}`,
    `Chain: ${chainId}`,
    ``,
    message,
  ].join("\n")

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)
  } catch (err) {
    console.error("[ALERT] Telegram send failed:", err.message)
  }
}

/**
 * Send a heartbeat message with executor stats. Never throws.
 * @param {object} stats — The executor stats object
 */
export async function sendTelegramHeartbeat(stats) {
  const msg = [
    `✅ Executor alive`,
    `Cycles: ${stats.totalCycles}`,
    `Executed: ${stats.totalExecuted}`,
    `Errors: ${stats.totalErrors}`,
    `Last cycle: ${stats.lastCycleAt || "never"}`,
  ].join(" — ")

  await sendTelegramAlert(msg)
}

// ─── Freeze-observability alert builders ────────────────────────────────────
// Each builder RECEIVES a numeric `score` (0..20, from computeFreezeScore in
// freeze-score.js — the bot NEVER auto-freezes) and uses scoreTier() to set the
// tone. Each builds an HTML body that INCLUDES the "Freeze-urgency: N/20 (tier)"
// line + an escalation tail, calls sendTelegramAlert(body) (already fail-safe),
// and RETURNS the body string so it is unit-testable. None of them throw.

/**
 * Alert: a new DCA position was detected/created.
 * @param {{tokenInSymbol:string, tokenOutSymbol:string, amountInHuman:string|number,
 *   dcaInterval:number, dcaTotal:number, perChunkHuman:string|number}} p
 * @param {number} score — freeze-urgency score 0..20
 * @returns {Promise<string>} the HTML body that was sent
 */
export async function alertNewDcaPosition(
  { tokenInSymbol, tokenOutSymbol, amountInHuman, dcaInterval, dcaTotal, perChunkHuman },
  score,
) {
  const durationSeconds = Number(dcaInterval) * Number(dcaTotal)
  const body = [
    `🆕 <b>New DCA position</b>`,
    `Pair: ${esc(tokenInSymbol)} → ${esc(tokenOutSymbol)}`,
    `Total in: ${esc(amountInHuman)} ${esc(tokenInSymbol)}`,
    `Schedule: ${esc(dcaTotal)} parts × ${esc(dcaInterval)}s (duration ${esc(durationSeconds)}s)`,
    `Per chunk: ${esc(perChunkHuman)} ${esc(tokenInSymbol)}`,
    ``,
    ...scoreLines(score),
  ].join("\n")

  await sendTelegramAlert(body)
  return body
}

// ─── Low-gas alert: per-process cooldown + recovery ──────────────────────────
// [fix/keeper-alert-cooldown-and-dca-debug-read] Seen in production 2026-09-13 (Arbitrum keeper,
// day one): alertLowGas had NO cooldown and executor.js called it every cycle the USD gas value
// sat under LOW_GAS_USD_THRESHOLD — with an active order a cycle is 30 s, so a signer at $4.98
// sent one Telegram message every 30 s for hours (Base never showed it only because its signer
// is above $5). The alerter below is per-process state — one process = one chain
// (ecosystem.config.cjs), so there is no per-chain map — and the Host/Time/Chain envelope stays
// sendTelegramAlert's. executor.js calls alertLowGas EVERY cycle the USD value is known, breach
// or not, passing the threshold; the alerter decides:
//   first breach                     ⇒ send
//   breach inside the cooldown       ⇒ suppress + count (returns null)
//   breach once the cooldown elapsed ⇒ send, with "N suppressed since HH:MM UTC", count reset
//   first reading back ≥ threshold   ⇒ send ONE "Gas balance recovered" (+ pending count), reset
//   healthy with no prior breach     ⇒ nothing

/** Default re-send interval while a breach persists: 1 hour. */
export const LOW_GAS_ALERT_COOLDOWN_MS_DEFAULT = 3_600_000

/**
 * LOW_GAS_ALERT_COOLDOWN_MS from the env: a non-negative integer number of milliseconds
 * (0 ⇒ every breach sends, the pre-cooldown behaviour). Blank / non-numeric / negative /
 * fractional ⇒ the default. Read at ALERT time, never at module scope — env.js loads
 * .env.executor after this module is imported (see the note in sendTelegramAlert).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function readLowGasCooldownMs(env = process.env) {
  const raw = env.LOW_GAS_ALERT_COOLDOWN_MS
  if (raw === undefined || !/^\d+$/.test(String(raw).trim())) return LOW_GAS_ALERT_COOLDOWN_MS_DEFAULT
  return Number(String(raw).trim())
}

/** "HH:MM UTC" for the suppressed-since stamp — same clock as the Time: header (ISO, UTC). */
function hhmmUtc(ms) {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`
}

/** A USD number renders with 2 decimals; a pre-formatted string renders verbatim (legacy callers). */
function usd(v) {
  return typeof v === "number" ? v.toFixed(2) : String(v)
}

/**
 * Build a low-gas alerter with its own cooldown/recovery state (unit-tested in alert.test.mjs
 * with a faked Date; the module-level alertLowGas below is the keeper's single instance).
 * @param {{ cooldownMs?: number }} [opts] — cooldownMs: fixed interval; omitted ⇒
 *   LOW_GAS_ALERT_COOLDOWN_MS from the env, read at alert time (default 1 h).
 * @returns {{ alert: (p: {balanceEth:string|number, gasUsdValue:string|number, thresholdUsd?:string|number},
 *   score:number) => Promise<string|null> }}
 */
export function createLowGasAlerter({ cooldownMs } = {}) {
  let inBreach = false
  let lastSentAt = 0
  let suppressed = 0
  let suppressedSince = 0

  const suppressedLine = () =>
    suppressed > 0 ? [`${suppressed} suppressed since ${hhmmUtc(suppressedSince)}`] : []

  /**
   * @param {{balanceEth:string|number, gasUsdValue:string|number, thresholdUsd?:string|number}} p —
   *   thresholdUsd omitted ⇒ the caller already decided this is a breach (the pre-cooldown contract).
   * @param {number} score — freeze-urgency score 0..20
   * @returns {Promise<string|null>} the HTML body that was sent, or null when nothing was sent
   */
  async function alert({ balanceEth, gasUsdValue, thresholdUsd }, score) {
    const now = Date.now()
    const breached = thresholdUsd === undefined ? true : Number(gasUsdValue) < Number(thresholdUsd)
    const thresholdTail = thresholdUsd === undefined ? "" : ` (threshold $${esc(thresholdUsd)})`

    if (!breached) {
      if (!inBreach) return null
      const body = [
        `✅ <b>Gas balance recovered</b>`,
        `Balance: ${esc(balanceEth)} ETH`,
        `≈ $${esc(usd(gasUsdValue))} for gas${thresholdTail}`,
        ...suppressedLine(),
        ``,
        ...scoreLines(score),
      ].join("\n")
      inBreach = false
      lastSentAt = 0
      suppressed = 0
      suppressedSince = 0
      await sendTelegramAlert(body)
      return body
    }

    if (inBreach && now - lastSentAt < (cooldownMs ?? readLowGasCooldownMs())) {
      suppressed += 1
      if (suppressed === 1) suppressedSince = now
      return null
    }

    const body = [
      `⛽ <b>Low gas balance</b>`,
      `Balance: ${esc(balanceEth)} ETH`,
      `≈ $${esc(usd(gasUsdValue))} for gas${thresholdTail}`,
      ...suppressedLine(),
      ``,
      ...scoreLines(score),
    ].join("\n")
    inBreach = true
    lastSentAt = now
    suppressed = 0
    suppressedSince = 0
    await sendTelegramAlert(body)
    return body
  }

  return { alert }
}

const lowGasAlerter = createLowGasAlerter()

/**
 * Alert: the executor wallet is low on gas — cooled down + recovery-aware (createLowGasAlerter).
 * Call it EVERY cycle the USD value is known, breach or not; it decides whether anything is sent.
 * @param {{balanceEth:string|number, gasUsdValue:string|number, thresholdUsd?:string|number}} p
 * @param {number} score — freeze-urgency score 0..20
 * @returns {Promise<string|null>} the HTML body that was sent, or null when nothing was sent
 */
export async function alertLowGas(p, score) {
  return lowGasAlerter.alert(p, score)
}

/**
 * Alert: unexplained ETH outflow from the executor wallet (possible drain).
 * @param {{outflowEth:string|number, thresholdEth:string|number, walletAddress:string}} p
 * @param {number} score — freeze-urgency score 0..20
 * @returns {Promise<string>} the HTML body that was sent
 */
export async function alertUnexplainedOutflow({ outflowEth, thresholdEth, walletAddress }, score) {
  const body = [
    `💸 <b>Unexplained outflow</b>`,
    `Wallet: <code>${esc(walletAddress)}</code>`,
    `Outflow: ${esc(outflowEth)} ETH (threshold ${esc(thresholdEth)} ETH)`,
    ``,
    ...scoreLines(score),
  ].join("\n")

  await sendTelegramAlert(body)
  return body
}

/**
 * Alert: an operational issue (crash, RPC loss, failed exec, stale lock).
 * @param {{kind:'crash'|'rpc'|'failed-exec'|'stale-lock', detail:string}} p
 * @param {number} score — freeze-urgency score 0..20
 * @returns {Promise<string>} the HTML body that was sent
 */
export async function alertOps({ kind, detail }, score) {
  const body = [
    `🛠️ <b>Ops issue: ${esc(kind)}</b>`,
    `Detail: ${esc(detail)}`,
    ``,
    ...scoreLines(score),
  ].join("\n")

  await sendTelegramAlert(body)
  return body
}
