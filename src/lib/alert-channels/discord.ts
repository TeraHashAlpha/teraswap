/**
 * Discord alert channel via webhook.
 *
 * Sends monitoring alerts as rich embeds to a Discord channel.
 * Gracefully degrades if DISCORD_WEBHOOK_URL is not set.
 */

import type { AlertPayload } from '../alert-wrapper'
import { CHANNEL_FETCH_TIMEOUT_MS } from './utils'

const VALID_WEBHOOK_PREFIXES = [
  'https://discord.com/api/webhooks/',
  'https://discordapp.com/api/webhooks/',
]

/** Discord embed colour: red for disabled, orange for degraded, green for active. */
function embedColour(state: string): number {
  switch (state) {
    case 'disabled': return 0xdc2626 // red-600
    case 'degraded': return 0xf59e0b // amber-500
    case 'active':   return 0x22c55e // green-500
    default:         return 0x6b7280 // gray-500
  }
}

export async function sendDiscordAlert(payload: AlertPayload): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL

  if (!webhookUrl) {
    console.warn('[ALERT:discord] DISCORD_WEBHOOK_URL not set — skipping')
    return
  }

  if (!VALID_WEBHOOK_PREFIXES.some(prefix => webhookUrl.startsWith(prefix))) {
    console.error('[ALERT:discord] Invalid webhook URL — must be a Discord webhook. Skipping.')
    return
  }

  const res = await fetch(webhookUrl, {
    signal: AbortSignal.timeout(CHANNEL_FETCH_TIMEOUT_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [
        {
          title: `Source ${payload.to.toUpperCase()}: ${payload.sourceId}`,
          color: embedColour(payload.to),
          fields: [
            { name: 'Transition', value: `${payload.from} \u2192 ${payload.to}`, inline: true },
            { name: 'Reason', value: payload.reason || 'unknown', inline: true },
            { name: 'Time', value: payload.timestamp, inline: false },
          ],
          footer: { text: 'TeraSwap Monitor' },
          url: 'https://teraswap.app/admin/monitor',
        },
      ],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '?')
    throw new Error(`Discord webhook ${res.status}: ${body}`)
  }
}
