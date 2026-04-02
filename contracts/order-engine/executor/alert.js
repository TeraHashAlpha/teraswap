/**
 * Telegram alerting for the TeraSwap executor.
 * Fail-safe: never throws — if Telegram is unreachable, logs warning and continues.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN — Bot token from @BotFather
 *   TELEGRAM_CHAT_ID  — Chat/group ID for alerts
 */

import { hostname } from "os"

const HOST = hostname()
const CHAIN_ID = process.env.CHAIN_ID || "1"

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
