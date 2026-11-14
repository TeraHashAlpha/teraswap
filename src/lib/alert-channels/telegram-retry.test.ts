/**
 * Telegram delivery retry: one retry on timeout / network error / 5xx / 429, never on other 4xx.
 *
 * Production 2026-11-13 13:26, 14:01, 14:28 UTC: `[ALERT:telegram] delivery failed for openocean: The operation was
 * aborted due to timeout`. The channel is exercised for real (fetch is the only stub); the wrapper tests run the real
 * fan-out with email and Discord replaced by spies.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@/lib/kv', () => ({
  kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') },
}))

const mockEmail = vi.fn()
const mockDiscord = vi.fn()
vi.mock('./email', () => ({ sendEmailAlert: (...a: unknown[]) => mockEmail(...a) }))
vi.mock('./discord', () => ({ sendDiscordAlert: (...a: unknown[]) => mockDiscord(...a) }))

import {
  sendTelegramAlert,
  TELEGRAM_RETRY_DELAY_MS,
  TELEGRAM_RETRY_AFTER_CAP_MS,
  TELEGRAM_TOTAL_BUDGET_MS,
} from './telegram'
import { CHANNEL_FETCH_TIMEOUT_MS } from './utils'
import { emitTransitionAlert } from '../alert-wrapper'

const TOKEN = '123456:SECRET-bot-token-value'
const payload = {
  sourceId: 'openocean',
  from: 'active' as const,
  to: 'degraded' as const,
  reason: 'probe <timeout> & more',
  timestamp: '2026-11-13T14:28:00.000Z',
}

const ok = () => new Response('{"ok":true}', { status: 200 })
const timeoutErr = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')
const http = (status: number, body = '{}') => new Response(body, { status })

let fetchMock: ReturnType<typeof vi.fn>
let warn: MockInstance<typeof console.warn>
let error: MockInstance<typeof console.error>
let log: MockInstance<typeof console.log>

/** Everything the code printed, flattened, to prove the token never reaches a log. */
const printed = () =>
  [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls].map((c) => c.map(String).join(' ')).join('\n')

beforeEach(() => {
  vi.useFakeTimers()
  process.env.TELEGRAM_BOT_TOKEN = TOKEN
  process.env.TELEGRAM_CHAT_ID = '42'
  delete process.env.MONITOR_GRACE_UNTIL
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  mockEmail.mockReset().mockResolvedValue(undefined)
  mockDiscord.mockReset().mockResolvedValue(undefined)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
})

describe('sendTelegramAlert retry', () => {
  it('timeout then success: one more send, exactly one log line', async () => {
    fetchMock.mockRejectedValueOnce(timeoutErr()).mockResolvedValueOnce(ok())
    const done = sendTelegramAlert(payload)
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    await expect(done).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('attempt 1 failed (timeout)')
    expect(error).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('the retry sends the SAME escaped text and keyboard (redaction runs once, before the first attempt)', async () => {
    fetchMock.mockRejectedValueOnce(timeoutErr()).mockResolvedValueOnce(ok())
    const done = sendTelegramAlert(payload)
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    await done
    const [first, second] = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1].body)))
    expect(second).toEqual(first)
    expect(first.text).toContain('probe &lt;timeout&gt; &amp; more')
    expect(first.text).not.toContain('<timeout>')
    expect(first.reply_markup.inline_keyboard[0]).toHaveLength(3)
  })

  it.each([
    ['a network error', () => new TypeError('fetch failed'), 'network error'],
    ['HTTP 500', () => http(500), 'HTTP 500'],
    ['HTTP 502', () => http(502), 'HTTP 502'],
    ['HTTP 429 without retry_after', () => http(429, '{"ok":false}'), 'HTTP 429'],
  ])('retries once on %s', async (_n, first, reason) => {
    const f = first()
    if (f instanceof Response) fetchMock.mockResolvedValueOnce(f)
    else fetchMock.mockRejectedValueOnce(f)
    fetchMock.mockResolvedValueOnce(ok())
    const done = sendTelegramAlert(payload)
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    await expect(done).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0][0])).toContain(`(${reason})`)
  })

  it.each([400, 401, 403, 404, 409])('does NOT retry on HTTP %i', async (status) => {
    fetchMock.mockResolvedValueOnce(http(status, '{"ok":false,"description":"bad"}'))
    await expect(sendTelegramAlert(payload)).rejects.toThrow(`Telegram API ${status}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('honours 429 retry_after: waits that long, not less', async () => {
    fetchMock
      .mockResolvedValueOnce(http(429, '{"ok":false,"error_code":429,"parameters":{"retry_after":1}}'))
      .mockResolvedValueOnce(ok())
    const done = sendTelegramAlert(payload)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caps retry_after: a 30 s ask waits TELEGRAM_RETRY_AFTER_CAP_MS, no more', async () => {
    fetchMock
      .mockResolvedValueOnce(http(429, '{"parameters":{"retry_after":30}}'))
      .mockResolvedValueOnce(ok())
    const done = sendTelegramAlert(payload)
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_AFTER_CAP_MS - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('ignores a malformed or negative retry_after and uses the default pause', async () => {
    for (const body of ['not json', '{"parameters":{"retry_after":"soon"}}', '{"parameters":{"retry_after":-5}}']) {
      fetchMock.mockReset().mockResolvedValueOnce(http(429, body)).mockResolvedValueOnce(ok())
      const done = sendTelegramAlert(payload)
      await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
      await expect(done, body).resolves.toBeUndefined()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  })

  it('only ONE retry: two failures reject with the second error, three sends never happen', async () => {
    fetchMock.mockRejectedValueOnce(timeoutErr()).mockRejectedValueOnce(timeoutErr()).mockResolvedValue(ok())
    const done = sendTelegramAlert(payload)
    const settled = done.then(() => 'ok', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    expect(await settled).toBe('The operation was aborted due to timeout')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does nothing without a token or chat id (no fetch, no retry)', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    await sendTelegramAlert(payload)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendTelegramAlert worst case is bounded', () => {
  /** A fetch that "hangs" for `ms` of fake time, then times out, recording the timeout it was given. */
  const timeouts: number[] = []
  beforeEach(() => {
    timeouts.length = 0
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms)
      return new AbortController().signal
    })
  })

  it('every attempt hung: 5000 + 500 + 5000 = 10500 ms, within the 12000 ms budget', async () => {
    fetchMock.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + CHANNEL_FETCH_TIMEOUT_MS)
      throw timeoutErr()
    })
    const t0 = Date.now()
    const settled = sendTelegramAlert(payload).then(() => 'ok', () => 'failed')
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    expect(await settled).toBe('failed')
    expect(timeouts).toEqual([CHANNEL_FETCH_TIMEOUT_MS, CHANNEL_FETCH_TIMEOUT_MS])
    expect(Date.now() - t0).toBe(2 * CHANNEL_FETCH_TIMEOUT_MS + TELEGRAM_RETRY_DELAY_MS)
    expect(Date.now() - t0).toBeLessThanOrEqual(TELEGRAM_TOTAL_BUDGET_MS)
  })

  it('the absolute worst case (429 asking for the cap, then a hang) still ends inside the budget', async () => {
    fetchMock
      .mockResolvedValueOnce(http(429, '{"parameters":{"retry_after":999}}'))
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + CHANNEL_FETCH_TIMEOUT_MS)
        throw timeoutErr()
      })
    const t0 = Date.now()
    const settled = sendTelegramAlert(payload).then(() => 'ok', () => 'failed')
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_AFTER_CAP_MS)
    expect(await settled).toBe('failed')
    expect(Date.now() - t0).toBeLessThanOrEqual(TELEGRAM_TOTAL_BUDGET_MS)
    expect(TELEGRAM_TOTAL_BUDGET_MS).toBe(12_000)
  })

  it('a slow first attempt shrinks the second timeout so the total never passes the budget', async () => {
    fetchMock
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 9_000) // pretend the first attempt overran its own signal
        throw timeoutErr()
      })
      .mockResolvedValueOnce(ok())
    const done = sendTelegramAlert(payload)
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    await done
    expect(timeouts[1]).toBe(TELEGRAM_TOTAL_BUDGET_MS - 9_000 - TELEGRAM_RETRY_DELAY_MS) // 2500
  })
})

describe('the bot token never reaches a log or an error', () => {
  it('a transport error that quotes the URL is scrubbed, on the retry line and on the final error', async () => {
    const leaky = () => new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage ECONNRESET`)
    fetchMock.mockRejectedValueOnce(leaky()).mockRejectedValueOnce(leaky())
    const settled = sendTelegramAlert(payload).then(() => 'ok', (e: Error) => e)
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    const err = (await settled) as Error
    expect(err.message).toContain('ECONNRESET')
    expect(err.message).not.toContain(TOKEN)
    expect(err.cause).toBeUndefined()
    expect(printed()).not.toContain(TOKEN)
  })

  it('an HTTP error body that echoes the token is scrubbed (non-retryable path too)', async () => {
    fetchMock.mockResolvedValueOnce(http(400, `{"description":"bad request: bot${TOKEN}"}`))
    const err = await sendTelegramAlert(payload).then(() => null, (e: Error) => e)
    expect(err?.message).toContain('Telegram API 400')
    expect(err?.message).not.toContain(TOKEN)
  })

  it('through the wrapper: the one "delivery failed" line carries no token', async () => {
    fetchMock.mockRejectedValue(new TypeError(`boom bot${TOKEN}`))
    const done = emitTransitionAlert('openocean', 'active', 'degraded', 'probe failed')
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    await done
    expect(printed()).not.toContain(TOKEN)
  })
})

describe('through emitTransitionAlert (real fan-out)', () => {
  it('two failures log exactly one "delivery failed" line for telegram', async () => {
    fetchMock.mockRejectedValueOnce(timeoutErr()).mockRejectedValueOnce(timeoutErr())
    const done = emitTransitionAlert('openocean', 'active', 'degraded', 'probe failed')
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    await done

    const failedLines = error.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('delivery failed'))
    expect(failedLines).toEqual([
      '[ALERT:telegram] delivery failed for openocean: The operation was aborted due to timeout',
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mockEmail).toHaveBeenCalledTimes(1)
    expect(mockDiscord).toHaveBeenCalledTimes(1)
  })

  it('timeout then success logs no "delivery failed" at all and counts 3/3 delivered', async () => {
    fetchMock.mockRejectedValueOnce(timeoutErr()).mockResolvedValueOnce(ok())
    const done = emitTransitionAlert('openocean', 'active', 'degraded', 'probe failed')
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    await done
    expect(error).not.toHaveBeenCalled()
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('3/3 channels delivered')
  })

  it('a 400 fails once without delay: one send, one "delivery failed" line, nothing waits', async () => {
    fetchMock.mockResolvedValueOnce(http(400, '{"ok":false}'))
    await emitTransitionAlert('openocean', 'active', 'degraded', 'probe failed') // no timer advance needed
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(error.mock.calls.filter((c) => String(c[0]).includes('delivery failed'))).toHaveLength(1)
  })

  it('the retry does not delay the other channels: email and Discord are sent before the retry wait ends', async () => {
    fetchMock.mockRejectedValueOnce(timeoutErr()).mockResolvedValueOnce(ok())
    let settled = false
    const done = emitTransitionAlert('openocean', 'active', 'degraded', 'probe failed').then(() => {
      settled = true
    })
    // No timer has advanced: Telegram is parked in its retry pause.
    await vi.advanceTimersByTimeAsync(0)
    expect(mockEmail).toHaveBeenCalledTimes(1)
    expect(mockDiscord).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_DELAY_MS)
    await done
    expect(settled).toBe(true)
  })
})
