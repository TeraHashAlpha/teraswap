/**
 * Shared utilities for alert channels.
 */

import { sanitizeUpstreamError } from '../sanitize-error'

/** Escape user-controlled strings for safe HTML interpolation (Telegram HTML, Email). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/** Fetch timeout (ms) for all outbound alert channel requests. */
export const CHANNEL_FETCH_TIMEOUT_MS = 5_000

// ── [fix/keeper-errors-no-signature] One scrub for every alert channel's error text (A87 S-2, owner answer 2) ──
//
// Before: Telegram scrubbed its own bot token out of the error it throws on a failed delivery; Email and Discord
// threw the provider's reply raw (`Resend API 401: …`, `Discord webhook 400: …`), and no channel scrubbed the alert
// `reason` it sends — a reason built from an upstream error (a probe failure, a KV error) can carry a keyed URL, a
// bearer token or an order signature. Now the reason in all three outgoing bodies AND the error each channel throws
// pass through scrubAlertText. Who is alerted, and when, is unchanged.

/** The longest reason / error text a channel sends or throws. Discord refuses an embed field over 1,024 characters
 *  (the whole webhook call fails and the alert is lost). */
export const ALERT_TEXT_MAX = 1_000
/** What stands in for a configured channel secret. */
export const SECRET_MASK = '[redacted]'
/** The start of the visible marker a cut text ends with: `…[truncated N chars]`. */
export const TRUNCATED = '…[truncated'

const HEX_RUN = /[0-9a-f]{130,}/gi
// What reaches the pattern passes is bounded first, cut where whitespace begins (a URL or a hex run is one
// whitespace-free token, so none is split into a shape the patterns no longer see). Secrets are masked by value
// BEFORE the bound, so no secret is ever cut in half.
const PRE_MAX = 16_384
const MIN_SECRET_LENGTH = 4

/** Every alert channel's configured credential values, read at call time; the Discord webhook's token segment too. */
function configuredSecrets(): string[] {
  const out: string[] = []
  for (const name of ['TELEGRAM_BOT_TOKEN', 'RESEND_API_KEY', 'DISCORD_WEBHOOK_URL'] as const) {
    const v = process.env[name]
    if (v) out.push(v)
  }
  const hook = process.env.DISCORD_WEBHOOK_URL
  if (hook) {
    try {
      const segments = new URL(hook).pathname.split('/').filter(Boolean)
      const token = segments[segments.length - 1]
      if (token) out.push(token)
    } catch {
      /* not a URL: masked whole above */
    }
  }
  return out
}

/**
 * The text of an alert reason or a channel error, safe to send or log. In order: every configured channel secret
 * (and each of `secrets`) masked by value; the bound; sanitizeUpstreamError (URL path / query, Bearer, key=…);
 * any run of 130+ hex digits replaced by `<hex N>`; the cap (`max`, default 1,000) ending with
 * `…[truncated N chars]`. Never throws.
 */
export function scrubAlertText(value: unknown, { max = ALERT_TEXT_MAX, secrets = [] }: { max?: number; secrets?: readonly string[] } = {}): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value ?? '')
  } catch {
    text = '[unprintable]'
  }
  try {
    const all = [...secrets, ...configuredSecrets()].filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH)
    for (const s of all.sort((a, b) => b.length - a.length)) text = text.split(s).join(SECRET_MASK)
  } catch {
    text = '[unprintable]'
  }
  let cut = 0
  if (text.length > PRE_MAX) {
    let end = PRE_MAX
    while (end > 0 && !/\s/.test(text[end])) end--
    cut = text.length - end
    text = text.slice(0, end)
  }
  text = sanitizeUpstreamError(text).replace(HEX_RUN, (m) => `<hex ${m.length}>`)
  if (cut === 0 && text.length <= max) return text
  const marker = (n: number) => `${TRUNCATED} ${n} chars]`
  let keep = Math.max(0, Math.min(text.length, max - marker(text.length + cut).length - 1))
  if (keep > 0 && keep < text.length && /[\uD800-\uDBFF]/.test(text[keep - 1])) keep--
  const out = `${text.slice(0, keep)}${keep > 0 ? ' ' : ''}${marker(text.length - keep + cut)}`
  return out.length <= max ? out : out.slice(0, max)
}
