/**
 * Email alert channel via Resend API.
 *
 * Sends monitoring alerts as transactional emails.
 * Gracefully degrades if RESEND_API_KEY / ALERT_EMAIL_TO are not set.
 */

import type { AlertPayload } from '../alert-wrapper'
import { escapeHtml, CHANNEL_FETCH_TIMEOUT_MS } from './utils'

export async function sendEmailAlert(payload: AlertPayload): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  const emailTo = process.env.ALERT_EMAIL_TO

  if (!apiKey || !emailTo) {
    console.warn('[ALERT:email] RESEND_API_KEY or ALERT_EMAIL_TO not set — skipping')
    return
  }

  const safeSourceId = escapeHtml(payload.sourceId)
  const safeReason = escapeHtml(payload.reason || 'unknown')

  const subject = `[TeraSwap] Source ${payload.sourceId} \u2192 ${payload.to}`

  const html = [
    '<div style="font-family: sans-serif; max-width: 600px;">',
    `<h2 style="color: ${payload.to === 'disabled' ? '#dc2626' : payload.to === 'degraded' ? '#f59e0b' : '#22c55e'};">`,
    `Source ${payload.to.toUpperCase()}: ${safeSourceId}`,
    '</h2>',
    '<table style="border-collapse: collapse; width: 100%;">',
    `<tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Transition</strong></td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${payload.from} \u2192 ${payload.to}</td></tr>`,
    `<tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Reason</strong></td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${safeReason}</td></tr>`,
    `<tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Time</strong></td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${payload.timestamp}</td></tr>`,
    '</table>',
    '<p style="margin-top: 16px;">',
    '<a href="https://teraswap.app/admin/monitor" style="color: #3b82f6;">View Dashboard</a>',
    '</p>',
    '</div>',
  ].join('\n')

  const res = await fetch('https://api.resend.com/emails', {
    signal: AbortSignal.timeout(CHANNEL_FETCH_TIMEOUT_MS),
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'TeraSwap Alerts <alerts@teraswap.app>',
      to: [emailTo],
      subject,
      html,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '?')
    throw new Error(`Resend API ${res.status}: ${body}`)
  }
}
