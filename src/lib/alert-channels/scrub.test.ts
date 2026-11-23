/**
 * [fix/keeper-errors-no-signature] A87 S-2, owner answer 2 (2026-11-18): one shared scrub (scrubAlertText, utils.ts)
 * on the alert reason in all three outgoing bodies AND on the error each channel throws.
 *
 * Before: no channel scrubbed the reason it sends; Telegram scrubbed only its own bot token out of its errors; Email
 * and Discord threw the provider's reply raw. Each case below carries DUMMY secrets only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendTelegramAlert } from './telegram'
import { sendEmailAlert } from './email'
import { sendDiscordAlert } from './discord'
import { ALERT_TEXT_MAX, SECRET_MASK, TRUNCATED, scrubAlertText } from './utils'
import type { AlertPayload } from '../alert-wrapper'

const BOT_TOKEN = '123456:DUMMY-bot-token-value'
const RESEND_KEY = 're_DUMMYresendKey0123'
const HOOK_TOKEN = 'DUMMYwebhookTokenQwerty'
const HOOK_URL = `https://discord.com/api/webhooks/1111/${HOOK_TOKEN}`
const SIG_HEX = `${'dead5ea1'.repeat(16)}1b`
const RPC_KEY = 'DUMMYrpcKeyZxcv'
const BEARER = 'DUMMYbearerPoiu'
const API_KEY = 'DUMMYapiKeyLkjh'

/** Everything a leaked error could carry: an order signature, a keyed RPC URL, a bearer token, a key=…, and every
 *  channel's own credential. */
const SECRETS = [SIG_HEX, RPC_KEY, BEARER, API_KEY, BOT_TOKEN, RESEND_KEY, HOOK_TOKEN]
const LEAKY = [
  `probe failed: ContractFunctionExecutionError args: (0x${SIG_HEX})`,
  `URL: https://rpc.example.com/v2/${RPC_KEY}`,
  `Authorization: Bearer ${BEARER}`,
  `apikey=${API_KEY}`,
  `echo bot${BOT_TOKEN} ${RESEND_KEY} ${HOOK_URL}`,
].join(' | ')

const payload = (reason = LEAKY): AlertPayload => ({
  sourceId: 'openocean',
  from: 'active',
  to: 'degraded',
  reason,
  timestamp: '2026-11-18T15:00:00.000Z',
})

let fetchMock: ReturnType<typeof vi.fn>
const bodies = () => fetchMock.mock.calls.map((c) => String((c[1] as RequestInit).body))
const leaks = (s: string) => SECRETS.filter((x) => s.toLowerCase().includes(x.toLowerCase()))

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN
  process.env.TELEGRAM_CHAT_ID = '42'
  process.env.RESEND_API_KEY = RESEND_KEY
  process.env.ALERT_EMAIL_TO = 'ops@example.com'
  process.env.DISCORD_WEBHOOK_URL = HOOK_URL
  fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'RESEND_API_KEY', 'ALERT_EMAIL_TO', 'DISCORD_WEBHOOK_URL']) delete process.env[k]
})

const CHANNELS = [
  ['telegram', (p: AlertPayload) => sendTelegramAlert(p)],
  ['email', (p: AlertPayload) => sendEmailAlert(p)],
  ['discord', (p: AlertPayload) => sendDiscordAlert(p)],
] as const

describe('the outgoing payload of every channel carries no secret from the alert reason', () => {
  it.each(CHANNELS)('%s', async (_name, send) => {
    await send(payload())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [body] = bodies()
    expect(leaks(body)).toEqual([])
    expect(body).toContain('probe failed') // the reason itself still reaches the operator
    expect(body).toContain('https://rpc.example.com/') // ...with the provider's host
  })

  it.each(CHANNELS)('%s: a plain reason is sent as it was', async (_name, send) => {
    await send(payload('probe timeout after 5000 ms'))
    expect(bodies()[0]).toContain('probe timeout after 5000 ms')
  })

  it('discord: a long reason fits the 1,024-character embed field (no lost alert)', async () => {
    await sendDiscordAlert(payload(`x ${'word '.repeat(5_000)}`))
    const field = JSON.parse(bodies()[0]).embeds[0].fields.find((f: { name: string }) => f.name === 'Reason')
    expect(field.value.length).toBeLessThanOrEqual(1_024)
    expect(field.value).toContain(TRUNCATED)
  })
})

describe('the error every channel throws on a failed delivery carries no secret', () => {
  const echo = `bad request: bot${BOT_TOKEN} key ${RESEND_KEY} hook ${HOOK_URL} sig 0x${SIG_HEX} url https://rpc.example.com/v2/${RPC_KEY}`

  it.each(CHANNELS)('%s: a 400 whose body echoes them', async (_name, send) => {
    fetchMock.mockResolvedValue(new Response(echo, { status: 400 }))
    const err = await send(payload('probe failed')).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(leaks(err!.message)).toEqual([])
    expect(err!.message).toMatch(/400/)
  })

  it.each(CHANNELS)('%s: a transport error whose message echoes them', async (_name, send) => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed ${echo}`))
    const err = await send(payload('probe failed')).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(leaks(err!.message)).toEqual([])
    expect(err!.message).toContain('fetch failed')
  })
})

describe('scrubAlertText', () => {
  it('masks the configured channel secrets by value, and any extra secret it is given', () => {
    const out = scrubAlertText(`a ${BOT_TOKEN} b ${HOOK_TOKEN} c ONE-OFF-SECRET d`, { secrets: ['ONE-OFF-SECRET'] })
    expect(out).toBe(`a ${SECRET_MASK} b ${SECRET_MASK} c ${SECRET_MASK} d`)
  })

  it('keyed URLs, bearer tokens, key= assignments and 130+ hex runs', () => {
    expect(scrubAlertText(`https://rpc.example.com/v2/${RPC_KEY} Bearer ${BEARER} apikey=${API_KEY} 0x${SIG_HEX}`)).toBe(
      'https://rpc.example.com/[redacted] Bearer [redacted] apikey=[redacted] 0x<hex 130>',
    )
    const short = `0x${'ab'.repeat(64)}f`
    expect(scrubAlertText(short)).toBe(short)
  })

  it(`caps at ${ALERT_TEXT_MAX} with the marker; a lower max is honoured`, () => {
    const long = scrubAlertText('word '.repeat(10_000))
    expect(long.length).toBeLessThanOrEqual(ALERT_TEXT_MAX)
    expect(long).toContain(TRUNCATED)
    expect(scrubAlertText('word '.repeat(100), { max: 60 }).length).toBeLessThanOrEqual(60)
  })

  it('a secret across the pre-bound is masked whole (masking happens before any cut)', () => {
    const s = `${'x '.repeat(8_190)}${BOT_TOKEN} tail`
    const out = scrubAlertText(s)
    expect(out).not.toContain('DUMMY')
  })

  it('a multi-megabyte text: bounded and fast', () => {
    const s = `big ${`https://rpc.example.com/v2/${RPC_KEY} 0x${SIG_HEX} `.repeat(30_000)}`
    const t0 = performance.now()
    const out = scrubAlertText(s)
    expect(performance.now() - t0).toBeLessThan(2_000)
    expect(out.length).toBeLessThanOrEqual(ALERT_TEXT_MAX)
    expect(leaks(out)).toEqual([])
  })

  it('never throws', () => {
    const hostile = { toString() { throw new Error('no') } }
    for (const v of [null, undefined, 42, Symbol('s'), hostile, new Error('e'), {}]) {
      expect(typeof scrubAlertText(v)).toBe('string')
    }
  })
})
