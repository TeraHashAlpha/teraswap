import { describe, it, expect } from 'vitest'
import { getAlertChannelStatus } from './status'

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv

describe('getAlertChannelStatus', () => {
  it('nothing set → nothing configured', () => {
    expect(getAlertChannelStatus(env({}))).toEqual({ telegram: false, email: false, discord: false, anyConfigured: false })
  })

  it('a channel needs ALL of its vars (half-configured counts as not configured)', () => {
    expect(getAlertChannelStatus(env({ TELEGRAM_BOT_TOKEN: 't' })).telegram).toBe(false)
    expect(getAlertChannelStatus(env({ RESEND_API_KEY: 'k' })).email).toBe(false)
    expect(getAlertChannelStatus(env({ ALERT_EMAIL_TO: 'a@b.test' })).email).toBe(false)
    expect(getAlertChannelStatus(env({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' })).telegram).toBe(true)
    expect(getAlertChannelStatus(env({ RESEND_API_KEY: 'k', ALERT_EMAIL_TO: 'a@b.test' })).email).toBe(true)
  })

  it('discord must be a real Discord webhook URL (same gate as the sender)', () => {
    expect(getAlertChannelStatus(env({ DISCORD_WEBHOOK_URL: 'https://evil.test/hook' })).discord).toBe(false)
    expect(getAlertChannelStatus(env({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' })).discord).toBe(true)
  })

  it('anyConfigured is the OR of the channels', () => {
    expect(getAlertChannelStatus(env({ DISCORD_WEBHOOK_URL: 'https://discordapp.com/api/webhooks/1/abc' })).anyConfigured).toBe(true)
  })
})
