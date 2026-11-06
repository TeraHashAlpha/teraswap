/**
 * Which alert delivery channels are actually configured — NAMES/booleans only, never values.
 *
 * Mirrors the "would this channel send?" gate at the top of each sender (telegram.ts / email.ts /
 * discord.ts). Each sender silently `console.warn`s and returns when unconfigured, so an
 * installation with no channel at all used to look healthy while paging nobody
 * (fix/monitor-self-source-alerts). This is the single place that answers "can anyone be told?".
 */

import { VALID_WEBHOOK_PREFIXES } from './discord'

export interface AlertChannelStatus {
  telegram: boolean
  email: boolean
  discord: boolean
  anyConfigured: boolean
}

export function getAlertChannelStatus(env: NodeJS.ProcessEnv = process.env): AlertChannelStatus {
  const telegram = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
  const email = Boolean(env.RESEND_API_KEY && env.ALERT_EMAIL_TO)
  const discordUrl = env.DISCORD_WEBHOOK_URL
  const discord = Boolean(discordUrl && VALID_WEBHOOK_PREFIXES.some(prefix => discordUrl.startsWith(prefix)))
  return { telegram, email, discord, anyConfigured: telegram || email || discord }
}

/** Exact env var NAMES per channel, for operator-facing messages. */
export const ALERT_CHANNEL_ENV_NAMES = {
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  email: ['RESEND_API_KEY', 'ALERT_EMAIL_TO'],
  discord: ['DISCORD_WEBHOOK_URL'],
} as const
