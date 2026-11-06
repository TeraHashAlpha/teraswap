import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockKvSet = vi.fn()
vi.mock('@/lib/kv', () => ({ kv: { set: (...a: unknown[]) => mockKvSet(...a) } }))

const sendTelegram = vi.fn()
const sendEmail = vi.fn()
const sendDiscord = vi.fn()
vi.mock('@/lib/alert-channels/telegram', () => ({ sendTelegramAlert: (...a: unknown[]) => sendTelegram(...a) }))
vi.mock('@/lib/alert-channels/email', () => ({ sendEmailAlert: (...a: unknown[]) => sendEmail(...a) }))
vi.mock('@/lib/alert-channels/discord', () => ({
  sendDiscordAlert: (...a: unknown[]) => sendDiscord(...a),
  VALID_WEBHOOK_PREFIXES: ['https://discord.com/api/webhooks/', 'https://discordapp.com/api/webhooks/'],
}))

import { GET, POST } from './route'

const NAMES = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DISCORD_WEBHOOK_URL', 'RESEND_API_KEY', 'ALERT_EMAIL_TO'] as const
const req = (method: 'GET' | 'POST', auth?: string) =>
  new NextRequest('http://localhost/api/monitor/alerts', { method, headers: auth ? { authorization: auth } : {} })

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  for (const n of NAMES) vi.stubEnv(n, '')
  vi.stubEnv('MONITOR_SECRET', 'test-monitor-secret')
  mockKvSet.mockResolvedValue('OK')
  sendTelegram.mockResolvedValue(undefined)
  sendEmail.mockResolvedValue(undefined)
  sendDiscord.mockResolvedValue(undefined)
})

describe('GET /api/monitor/alerts', () => {
  it('401 without or with a wrong bearer; 401 when MONITOR_SECRET is unset', async () => {
    expect((await GET(req('GET'))).status).toBe(401)
    expect((await GET(req('GET', 'Bearer nope'))).status).toBe(401)
    vi.stubEnv('MONITOR_SECRET', '')
    expect((await GET(req('GET', 'Bearer '))).status).toBe(401)
  })

  it('NOT CONFIGURED when no channel is set, with env NAMES but never values', async () => {
    const res = await GET(req('GET', 'Bearer test-monitor-secret'))
    const body = await res.json()
    expect(body.status).toBe('NOT CONFIGURED')
    expect(body.channels).toEqual({ telegram: false, email: false, discord: false })
    expect(body.envNames.discord).toEqual(['DISCORD_WEBHOOK_URL'])
  })

  it('OK + booleans only when configured; secrets never appear in the body', async () => {
    vi.stubEnv('RESEND_API_KEY', 'SECRET-RESEND-VALUE')
    vi.stubEnv('ALERT_EMAIL_TO', 'owner@example.test')
    const text = await (await GET(req('GET', 'Bearer test-monitor-secret'))).text()
    expect(JSON.parse(text)).toMatchObject({ status: 'OK', channels: { email: true, telegram: false, discord: false } })
    expect(text).not.toContain('SECRET-RESEND-VALUE')
    expect(text).not.toContain('owner@example.test')
  })
})

describe('POST /api/monitor/alerts (test-fire)', () => {
  it('401 and sends nothing without auth', async () => {
    expect((await POST(req('POST'))).status).toBe(401)
    expect(sendTelegram).not.toHaveBeenCalled()
    expect(mockKvSet).not.toHaveBeenCalled()
  })

  it('nothing configured: every channel skipped, ok=false, nothing sent', async () => {
    const body = await (await POST(req('POST', 'Bearer test-monitor-secret'))).json()
    expect(body.ok).toBe(false)
    expect(body.results).toEqual({ telegram: 'skipped (not configured)', email: 'skipped (not configured)', discord: 'skipped (not configured)' })
    expect(sendTelegram).not.toHaveBeenCalled()
  })

  it('fires only configured channels with a clearly-labelled test payload', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 't')
    vi.stubEnv('TELEGRAM_CHAT_ID', 'c')
    const body = await (await POST(req('POST', 'Bearer test-monitor-secret'))).json()
    expect(body).toEqual({ ok: true, results: { telegram: 'sent', email: 'skipped (not configured)', discord: 'skipped (not configured)' } })
    expect(sendTelegram).toHaveBeenCalledTimes(1)
    expect(sendTelegram.mock.calls[0][0]).toMatchObject({ sourceId: 'alert-test', from: 'active', to: 'active' })
    expect(String(sendTelegram.mock.calls[0][0].reason)).toContain('TEST ALERT')
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('a failing channel is reported as failed without echoing the upstream error body', async () => {
    vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/1/abc')
    sendDiscord.mockRejectedValue(new Error('Discord webhook 404: {"message":"Unknown Webhook"}'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const text = await (await POST(req('POST', 'Bearer test-monitor-secret'))).text()
    expect(JSON.parse(text)).toMatchObject({ ok: false, results: { discord: 'failed' } })
    expect(text).not.toContain('Unknown Webhook')
    err.mockRestore()
  })

  it('throttled: a second call within 30 s gets 429 and sends nothing', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 't')
    vi.stubEnv('TELEGRAM_CHAT_ID', 'c')
    mockKvSet.mockResolvedValueOnce(null) // NX lock already held
    const res = await POST(req('POST', 'Bearer test-monitor-secret'))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('30')
    expect(sendTelegram).not.toHaveBeenCalled()
  })

  it('KV outage fails open (operator can still verify delivery)', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 't')
    vi.stubEnv('TELEGRAM_CHAT_ID', 'c')
    mockKvSet.mockRejectedValueOnce(new Error('kv down'))
    expect((await POST(req('POST', 'Bearer test-monitor-secret'))).status).toBe(200)
    expect(sendTelegram).toHaveBeenCalledTimes(1)
  })
})
