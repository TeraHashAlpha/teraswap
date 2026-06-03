/**
 * Email alert channel via Resend API.
 *
 * Sends monitoring alerts as transactional emails.
 * Gracefully degrades if RESEND_API_KEY / ALERT_EMAIL_TO are not set.
 */

import type { AlertPayload } from '../alert-wrapper'
import { escapeHtml, CHANNEL_FETCH_TIMEOUT_MS } from './utils'

/** [P110/M-04] Channel-level options mirroring the Telegram shape. */
export interface EmailAlertOptions {
  /** When true, prepend [GRACE] to the subject and add a banner to the
   *  HTML body explaining the alert may resolve automatically. */
  grace?: boolean
}

export async function sendEmailAlert(
  payload: AlertPayload,
  options?: EmailAlertOptions,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  const emailTo = process.env.ALERT_EMAIL_TO

  if (!apiKey || !emailTo) {
    console.warn('[ALERT:email] RESEND_API_KEY or ALERT_EMAIL_TO not set — skipping')
    return
  }

  const safeSourceId = escapeHtml(payload.sourceId)
  const safeReason = escapeHtml(payload.reason || 'unknown')

  const isGrace = options?.grace === true
  const gracePrefix = isGrace ? '[GRACE] ' : ''
  const subject = `[TeraSwap] ${gracePrefix}Source ${payload.sourceId} \u2192 ${payload.to}`

  // [P110/M-04] Grace banner before the headline so on-call operators
  // see the maintenance context immediately when they open the email
  // \u2014 and don't waste time chasing an alert that may auto-resolve.
  const graceBanner = isGrace
    ? '<div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; margin-bottom: 16px; color: #92400e; font-size: 14px;">'
      + '\u26a0\ufe0f <strong>Alert received during grace period</strong> \u2014 may resolve automatically. '
      + 'No action expected unless the alert persists after grace ends.'
      + '</div>'
    : ''

  const html = [
    '<div style="font-family: sans-serif; max-width: 600px;">',
    graceBanner,
    `<h2 style="color: ${payload.to === 'disabled' ? '#dc2626' : payload.to === 'degraded' ? '#f59e0b' : '#22c55e'};">`,
    `${gracePrefix}Source ${payload.to.toUpperCase()}: ${safeSourceId}`,
    '</h2>',
    '<table style="border-collapse: collapse; width: 100%;">',
    `<tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Transition</strong></td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${payload.from} \u2192 ${payload.to}</td></tr>`,
    `<tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Reason</strong></td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${safeReason}</td></tr>`,
    `<tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Time</strong></td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${payload.timestamp}</td></tr>`,
    '</table>',
    '<p style="margin-top: 16px;">',
    '<a href="https://www.teraswap.app/admin/monitor" style="color: #3b82f6;">View Dashboard</a>',
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
