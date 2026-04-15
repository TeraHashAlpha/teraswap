/**
 * Telegram alert channel.
 *
 * Sends monitoring alerts via Telegram Bot API.
 * Gracefully degrades if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 *
 * ADR-001 § H6: degraded/disabled alerts include inline keyboard buttons
 * ([Reactivate] [Keep Disabled] [Escalate]). Recovery (→ active) alerts
 * include a single [Acknowledged] button.
 */

import type { AlertPayload } from '../alert-wrapper'
import { escapeHtml, CHANNEL_FETCH_TIMEOUT_MS } from './utils'

// ── Inline keyboard builders ──────────────────────────

type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }

/**
 * Build the appropriate inline keyboard for a transition alert.
 * - degraded/disabled → [Reactivate] [Keep Disabled] [Escalate]
 * - active (recovery) → [Acknowledged]
 * - other (edge case) → no keyboard
 */
export function buildAlertKeyboard(sourceId: string, to: string): InlineKeyboard | undefined {
  if (to === 'degraded' || to === 'disabled') {
    return {
      inline_keyboard: [[
        { text: '\u2705 Reactivate', callback_data: `activate:${sourceId}` },
        { text: '\u{1F512} Keep Disabled', callback_data: `keep:${sourceId}` },
        { text: '\u{1F6A8} Escalate', callback_data: `escalate:${sourceId}` },
      ]],
    }
  }

  if (to === 'active') {
    return {
      inline_keyboard: [[
        { text: '\u{1F44D} Acknowledged', callback_data: `ack:${sourceId}` },
      ]],
    }
  }

  return undefined
}

// ── Main send function ────────────────────────────────

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

  const keyboard = buildAlertKeyboard(payload.sourceId, payload.to)

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }
  if (keyboard) {
    body.reply_markup = keyboard
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    signal: AbortSignal.timeout(CHANNEL_FETCH_TIMEOUT_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const respBody = await res.text().catch(() => '?')
    throw new Error(`Telegram API ${res.status}: ${respBody}`)
  }
}
