// @vitest-environment node
/**
 * POST /api/monitor/tick keeps the alerts it caused alive until the response is sent.
 *
 * Real route, real source-state-machine, real alert-wrapper, real alert-inflight over a fake KV; the three delivery
 * channels are the only fakes (their own timeouts are modelled in fake time). Production 2026-11-13 13:26, 14:01, 14:28 UTC:
 * a transition alert still in flight when the response went out was cut ("delivery failed for openocean: The operation
 * was aborted due to timeout").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const kvStore = new Map<string, unknown>()
const kvSets = new Set<string>()
vi.mock('@/lib/kv', () => ({
  kv: {
    get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { kvStore.set(key, value) }),
    smembers: vi.fn(async () => Array.from(kvSets)),
    pipeline: () => {
      const p = {
        set: (key: string, value: unknown) => { kvStore.set(key, value); return p },
        sadd: (_key: string, id: string) => { kvSets.add(id); return p },
        del: () => p,
        exec: async () => [],
      }
      return p
    },
  },
}))

const channels = vi.hoisted(() => ({
  telegram: vi.fn(),
  email: vi.fn(),
  discord: vi.fn(),
}))
vi.mock('@/lib/alert-channels/telegram', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/alert-channels/telegram')>()), // the real TELEGRAM_TOTAL_BUDGET_MS
  sendTelegramAlert: (...a: unknown[]) => channels.telegram(...a),
}))
vi.mock('@/lib/alert-channels/email', () => ({ sendEmailAlert: (...a: unknown[]) => channels.email(...a) }))
vi.mock('@/lib/alert-channels/discord', () => ({ sendDiscordAlert: (...a: unknown[]) => channels.discord(...a) }))

const afterMock = vi.hoisted(() => vi.fn())
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: afterMock,
}))

/** What the mocked tick does: transitions caused through the real state machine, after `workMs` of work. */
const tick = vi.hoisted(() => ({ workMs: 0, sources: ['openocean'] as string[], fail: false }))
vi.mock('@/lib/monitoring-loop', () => ({
  runMonitoringTick: async () => {
    const sm = await import('@/lib/source-state-machine')
    if (tick.workMs > 0) await new Promise<void>((r) => setTimeout(r, tick.workMs))
    for (const id of tick.sources) await sm.forceDisable(id, `operator-disable: test ${id}`)
    if (tick.fail) throw new Error('tick exploded')
    return { ok: true, transitions: tick.sources.length }
  },
}))

import { ALERT_SETTLE_MAX_MS } from '@/lib/alert-inflight'
import { TELEGRAM_TOTAL_BUDGET_MS } from '@/lib/alert-channels/telegram'

const SECRET = 'tick-secret-for-alert-test'
const TIMEOUT_MSG = 'The operation was aborted due to timeout'

/** A channel that fails with a timeout after `ms`, like a real fetch whose AbortSignal.timeout fires. */
function failsAfter(ms: number) {
  return () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error(TIMEOUT_MSG)), ms))
}
const hangsForever = () => new Promise<void>(() => {})

let POST: (req: never) => Promise<Response>
const tickRequest = () => new Request('http://localhost/api/monitor/tick', {
  method: 'POST',
  headers: { Authorization: `Bearer ${SECRET}` },
}) as never

/** Starts one tick at the current fake time; `at` is the fake ms until the response. */
function callTick(): Promise<{ status: number; at: number }> {
  const t0 = Date.now()
  return POST(tickRequest()).then((res) => ({ status: res.status, at: Date.now() - t0 }))
}

describe('POST /api/monitor/tick and the alerts it causes', () => {
  let errors: string[]
  let warns: string[]
  beforeEach(async () => {
    process.env.MONITOR_CRON_SECRET = SECRET
    POST = (await import('./route')).POST as typeof POST // loaded under real timers, so no module load meets the fake clock
    const sm = await import('@/lib/source-state-machine')
    sm.beginTick() // the per-tick cache would otherwise carry `disabled` from the previous test
    vi.useFakeTimers()
    kvStore.clear()
    kvSets.clear()
    afterMock.mockReset()
    channels.telegram.mockReset().mockResolvedValue(undefined)
    channels.email.mockReset().mockResolvedValue(undefined)
    channels.discord.mockReset().mockResolvedValue(undefined)
    tick.workMs = 0
    tick.sources = ['openocean']
    tick.fail = false
    errors = []
    warns = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')) })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete process.env.MONITOR_CRON_SECRET
  })

  it('a channel that answers after 3 s: the response goes out only after the alert was delivered', async () => {
    const order: string[] = []
    channels.telegram.mockImplementation(() => new Promise<void>((resolve) => {
      setTimeout(() => { order.push('telegram delivered'); resolve() }, 3_000)
    }))
    const pending = POST(tickRequest()).then((res) => { order.push('response'); return res })

    await vi.advanceTimersByTimeAsync(2_999)
    expect(order).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    const res = await pending
    expect(order).toEqual(['telegram delivered', 'response'])
    expect(res.status).toBe(200)
    // No duplicate: one transition, one alert per channel; the collector is the only path (the hook is not also used).
    expect(channels.telegram).toHaveBeenCalledTimes(1)
    expect(channels.email).toHaveBeenCalledTimes(1)
    expect(channels.discord).toHaveBeenCalledTimes(1)
    expect(afterMock).not.toHaveBeenCalled()
    expect(errors.filter((l) => l.includes('delivery failed'))).toEqual([])
  })

  it('every channel hung until its own timeout: answers inside the bound, one "delivery failed" line per channel, state untouched', async () => {
    channels.telegram.mockImplementation(failsAfter(TELEGRAM_TOTAL_BUDGET_MS)) // the real worst case: 2 attempts + the longest wait
    channels.email.mockImplementation(failsAfter(5_000))
    channels.discord.mockImplementation(failsAfter(5_000))
    const pending = callTick()
    await vi.advanceTimersByTimeAsync(TELEGRAM_TOTAL_BUDGET_MS)
    const { status, at } = await pending

    expect(status).toBe(200)
    expect(at).toBeLessThanOrEqual(ALERT_SETTLE_MAX_MS)
    const failed = errors.filter((l) => l.includes('delivery failed for openocean'))
    expect(failed).toHaveLength(3)
    expect(failed.filter((l) => l.startsWith('[ALERT:telegram]'))).toHaveLength(1)
    expect(failed.filter((l) => l.startsWith('[ALERT:email]'))).toHaveLength(1)
    expect(failed.filter((l) => l.startsWith('[ALERT:discord]'))).toHaveLength(1)
    expect(failed.every((l) => l.includes(TIMEOUT_MSG))).toBe(true)
    // a failing alert never changes a source's state
    expect((kvStore.get('teraswap:source-state:openocean') as { state: string }).state).toBe('disabled')
    expect(afterMock).not.toHaveBeenCalled() // all settled inside the bound: nothing left to hand over
    console.info(`[alerts-tick] all channels hung to their own timeout: response at ${at} ms (cap ${ALERT_SETTLE_MAX_MS} ms, maxDuration 30000 ms)`)
  })

  it('a channel that never answers: the response goes out at the cap, the leftover goes to after()', async () => {
    channels.telegram.mockImplementation(hangsForever)
    const pending = callTick()
    await vi.advanceTimersByTimeAsync(ALERT_SETTLE_MAX_MS - 1)
    let done = false
    void pending.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const { status, at } = await pending
    expect(status).toBe(200)
    expect(at).toBe(ALERT_SETTLE_MAX_MS)
    expect(warns.some((l) => l.includes('1 alert(s) still in flight after'))).toBe(true)
    expect(afterMock).toHaveBeenCalledTimes(1)
  })

  it('a slow tick leaves the alert less than the cap: the response never goes past 27 s of the 30 s maxDuration', async () => {
    channels.telegram.mockImplementation(hangsForever)
    tick.workMs = 20_000 // the transition happens at 20 s, so only 7 s remain before 27 s
    const pending = callTick()
    await vi.advanceTimersByTimeAsync(27_000)
    const { status, at } = await pending
    expect(status).toBe(200)
    expect(at).toBe(27_000)
    expect(at).toBeLessThan(30_000)
  })

  it('a tick that throws still waits for the alerts it caused, then answers 500', async () => {
    channels.telegram.mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 2_000)))
    tick.fail = true // the tick causes its transition, then fails
    const pending = callTick()
    await vi.advanceTimersByTimeAsync(1_999)
    let done = false
    void pending.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const { status } = await pending
    expect(status).toBe(500)
    expect(channels.telegram).toHaveBeenCalledTimes(1)
  })
})
