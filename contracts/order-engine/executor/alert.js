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
const CHAIN_ID = process.env.CHAIN_ID || "1"

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

  if (!token || !chatId) {
    console.warn("[ALERT] Telegram not configured, skipping alert")
    return
  }

  const now = new Date().toISOString()
  const text = [
    `🚨 <b>TeraSwap Executor Alert</b>`,
    `Host: ${HOST}`,
    `Time: ${now}`,
    `Chain: ${CHAIN_ID}`,
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

/**
 * Alert: the executor wallet is low on gas.
 * @param {{balanceEth:string|number, gasUsdValue:string|number}} p
 * @param {number} score — freeze-urgency score 0..20
 * @returns {Promise<string>} the HTML body that was sent
 */
export async function alertLowGas({ balanceEth, gasUsdValue }, score) {
  const body = [
    `⛽ <b>Low gas balance</b>`,
    `Balance: ${esc(balanceEth)} ETH`,
    `≈ $${esc(gasUsdValue)} for gas`,
    ``,
    ...scoreLines(score),
  ].join("\n")

  await sendTelegramAlert(body)
  return body
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
