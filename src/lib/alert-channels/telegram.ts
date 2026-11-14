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
import { forLog } from '../log-sanitize'
import { escapeHtml, CHANNEL_FETCH_TIMEOUT_MS } from './utils'

// ── Delivery retry (ONE retry, Telegram only) ─────────
//
// Production 2026-11-13 13:26, 14:01, 14:28 UTC: a single attempt timed out after CHANNEL_FETCH_TIMEOUT_MS and the
// alert was lost. One retry on a transport failure, HTTP 5xx or 429; never on any other 4xx (a 400/401/403/404 will
// not heal in a second, and retrying them would hide a bad token or chat id behind a delay).
//
// Worst case, every attempt hung: attempt 1 (5 000 ms) + wait (<= 2 000 ms) + attempt 2 (5 000 ms) = 12 000 ms, which
// TELEGRAM_TOTAL_BUDGET_MS enforces by shrinking attempt 2's timeout to what is left. The tick route's
// `maxDuration` is 30 000 ms; channels run in parallel (alert-wrapper), so the fan-out costs max(channel), not the sum.
//
// Duplicates: NOT excludable. If attempt 1 reaches Telegram and the message is posted but the response is lost or late,
// attempt 2 posts it again; sendMessage has no idempotency key. A rare duplicate is accepted over a lost alert.

/** Pause before the retry when Telegram gave no `retry_after`. */
export const TELEGRAM_RETRY_DELAY_MS = 500
/** Ceiling on a `retry_after` we honour; a longer ask is clamped to this, never waited out. */
export const TELEGRAM_RETRY_AFTER_CAP_MS = 2_000
/** Hard ceiling on one send, retry included: two attempts plus the longest wait. */
export const TELEGRAM_TOTAL_BUDGET_MS = 2 * CHANNEL_FETCH_TIMEOUT_MS + TELEGRAM_RETRY_AFTER_CAP_MS

/** One failed attempt, classified. `message` is already free of the bot token. */
class TelegramAttemptError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly reason: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

/** Strip the bot token (and its `bot<token>` URL form) from anything that could reach a log or an error. */
function scrubToken(text: string, botToken: string): string {
  return text.split(botToken).join('[redacted]')
}

/** Telegram's `parameters.retry_after` (seconds) from a 429 body, as ms; undefined when absent or malformed. */
function parseRetryAfterMs(respBody: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(respBody)
    const seconds = (parsed as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
  } catch {
    return undefined
  }
}

async function postOnce(botToken: string, body: Record<string, unknown>, timeoutMs: number): Promise<void> {
  let res: Response
  try {
    res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      signal: AbortSignal.timeout(timeoutMs),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network error'
    throw new TelegramAttemptError(scrubToken(err instanceof Error ? err.message : String(err), botToken), true, reason)
  }
  if (res.ok) return
  const respBody = await res.text().catch(() => '?')
  const retryable = res.status === 429 || res.status >= 500
  throw new TelegramAttemptError(
    scrubToken(`Telegram API ${res.status}: ${respBody}`, botToken),
    retryable,
    `HTTP ${res.status}`,
    res.status === 429 ? parseRetryAfterMs(respBody) : undefined,
  )
}

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

// ── Options ──────────────────────────────────────────

export interface TelegramAlertOptions {
  /** When true, alert is tagged as grace-period and keyboard is omitted. */
  grace?: boolean
}

// ── Main send function ────────────────────────────────

export async function sendTelegramAlert(payload: AlertPayload, options?: TelegramAlertOptions): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!botToken || !chatId) {
    console.warn('[ALERT:telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping')
    return
  }

  const isGrace = options?.grace === true
  const safeSourceId = escapeHtml(payload.sourceId)
  const safeReason = escapeHtml(payload.reason || 'unknown')

  // [API-H-03] Grace alerts use ⏸️ prefix instead of state emoji
  const emoji = isGrace ? '\u23F8\uFE0F' // ⏸️
    : payload.to === 'disabled' ? '\u{1F534}' // 🔴
    : payload.to === 'degraded' ? '\u{1F7E0}' // 🟠
    : '\u{1F7E2}' // 🟢

  const gracePrefix = isGrace ? '[GRACE] ' : ''
  const reasonSuffix = isGrace ? ' (during maintenance grace)' : ''

  const text = [
    `${emoji} <b>${gracePrefix}Source ${payload.to.toUpperCase()}: ${safeSourceId}</b>`,
    '',
    `<b>Transition:</b> ${payload.from} \u2192 ${payload.to}`,
    `<b>Reason:</b> ${safeReason}${reasonSuffix}`,
    `<b>Time:</b> ${payload.timestamp}`,
    '',
    `<a href="https://www.teraswap.app/admin/monitor">Dashboard</a>`,
  ].join('\n')

  // [API-H-03] No action buttons on grace alerts — operator set the grace, no action needed
  const keyboard = isGrace ? undefined : buildAlertKeyboard(payload.sourceId, payload.to)

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }
  if (keyboard) {
    body.reply_markup = keyboard
  }

  const startedAt = Date.now()
  try {
    await postOnce(botToken, body, CHANNEL_FETCH_TIMEOUT_MS)
    return
  } catch (first) {
    if (!(first instanceof TelegramAttemptError) || !first.retryable) throw first

    const waitMs = Math.min(first.retryAfterMs ?? TELEGRAM_RETRY_DELAY_MS, TELEGRAM_RETRY_AFTER_CAP_MS)
    console.warn(`[ALERT:telegram] attempt 1 failed (${first.reason}), retrying once in ${waitMs}ms`)
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
    const left = TELEGRAM_TOTAL_BUDGET_MS - (Date.now() - startedAt)
    try {
      await postOnce(botToken, body, Math.max(1, Math.min(CHANNEL_FETCH_TIMEOUT_MS, left)))
    } catch (second) {
      // The wrapper logs the single "delivery failed" line from this message; keep it free of the token and of log breaks.
      throw new Error(forLog(second instanceof Error ? second.message : second, 300))
    }
  }
}
