/**
 * Telegram alert channel.
 *
 * Sends monitoring alerts via Telegram Bot API.
 * Gracefully degrades if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 */

import type { AlertPayload } from '../alert-wrapper'
import { escapeHtml, CHANNEL_FETCH_TIMEOUT_MS } from './utils'

export async function sendTelegramAlert(payload: AlertPayload): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!botToken || !chatId) {
    console.warn('[ALERT:telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping')
    return
  }

  const safeSourceId = escapeHtml(payload.sourceId)
  const safeReason = escapeHtml(payload.reason || 'unknown')

  const emoji = payload.to === 'disabled' ? '\u{1F534}' // 🔴
    : payload.to === 'degraded' ? '\u{1F7E0}' // 🟠
    : '\u{1F7E2}' // 🟢

  const text = [
    `${emoji} <b>Source ${payload.to.toUpperCase()}: ${safeSourceId}</b>`,
    '',
    `<b>Transition:</b> ${payload.from} \u2192 ${payload.to}`,
    `<b>Reason:</b> ${safeReason}`,
    `<b>Time:</b> ${payload.timestamp}`,
    '',
    `<a href="https://teraswap.app/admin/monitor">Dashboard</a>`,
  ].join('\n')

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    signal: AbortSignal.timeout(CHANNEL_FETCH_TIMEOUT_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '?')
    throw new Error(`Telegram API ${res.status}: ${body}`)
  }
}
