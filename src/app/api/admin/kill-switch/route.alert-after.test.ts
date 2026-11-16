// @vitest-environment node
/**
 * A user-facing path that causes a transition (POST /api/admin/kill-switch -> forceDisable) must not wait for the alert,
 * and must not lose it: the reply goes out at once and the alert is handed to Next's `after()`, which the platform keeps
 * alive until it settles. Real route, real source-state-machine, real alert-wrapper and alert-inflight over a fake KV; the
 * three channels are fakes and Telegram takes 1 s (real time), so a route that awaited the alert could not answer < 500 ms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const kvStore = new Map<string, unknown>()
const kvSets = new Map<string, Set<string>>()
function getSet(key: string): Set<string> {
  if (!kvSets.has(key)) kvSets.set(key, new Set())
  return kvSets.get(key)!
}
vi.mock('@/lib/kv', () => ({
  kv: {
    get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { kvStore.set(key, value) }),
    smembers: vi.fn(async (key: string) => Array.from(getSet(key))),
    pipeline: () => {
      const p = {
        set: (key: string, value: unknown) => { kvStore.set(key, value); return p },
        sadd: (key: string, member: string) => { getSet(key).add(member); return p },
        del: () => p,
        exec: async () => [],
      }
      return p
    },
  },
}))

const channels = vi.hoisted(() => ({ telegram: vi.fn(), email: vi.fn(), discord: vi.fn() }))
vi.mock('@/lib/alert-channels/telegram', () => ({ sendTelegramAlert: (...a: unknown[]) => channels.telegram(...a) }))
vi.mock('@/lib/alert-channels/email', () => ({ sendEmailAlert: (...a: unknown[]) => channels.email(...a) }))
vi.mock('@/lib/alert-channels/discord', () => ({ sendDiscordAlert: (...a: unknown[]) => channels.discord(...a) }))

/** The framework hook, as the platform uses it: it keeps what it was given and runs it to the end after the reply. */
const handedToAfter = vi.hoisted(() => [] as Promise<unknown>[])
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: (task: Promise<unknown>) => { handedToAfter.splice(handedToAfter.length, 0, task) },
}))

import { POST } from './route'
import { beginTick } from '@/lib/source-state-machine'

const SECRET = 'kill-switch-secret-for-after-test'
const TELEGRAM_DELAY_MS = 1_000

describe('POST /api/admin/kill-switch with a slow alert channel', () => {
  const originalSecret = process.env.KILL_SWITCH_SECRET
  beforeEach(() => {
    process.env.KILL_SWITCH_SECRET = SECRET
    kvStore.clear()
    kvSets.clear()
    handedToAfter.splice(0, handedToAfter.length)
    beginTick()
    getSet('teraswap:source-state:index').add('openocean')
    channels.telegram.mockReset()
    channels.email.mockReset().mockResolvedValue(undefined)
    channels.discord.mockReset().mockResolvedValue(undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (originalSecret === undefined) delete process.env.KILL_SWITCH_SECRET
    else process.env.KILL_SWITCH_SECRET = originalSecret
  })

  it('answers at once, hands the alert to after(), and the alert is delivered once it finishes', async () => {
    let telegramDeliveredAt = 0
    channels.telegram.mockImplementation(() => new Promise<void>((resolve) => {
      setTimeout(() => { telegramDeliveredAt = Date.now(); resolve() }, TELEGRAM_DELAY_MS)
    }))
    const req = new NextRequest('https://teraswap.app/api/admin/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ sourceId: 'openocean', reason: 'vendor outage' }),
    })

    const t0 = Date.now()
    const res = await POST(req)
    const responseMs = Date.now() - t0
    console.info(`[alerts-after] kill-switch answered in ${responseMs} ms while Telegram takes ${TELEGRAM_DELAY_MS} ms`)

    expect(res.status).toBe(200)
    expect(responseMs).toBeLessThan(TELEGRAM_DELAY_MS / 2) // the reply did not wait for the alert
    expect(telegramDeliveredAt).toBe(0) // ...which is still in flight
    expect(handedToAfter).toHaveLength(1) // ...and was handed to the hook, once

    await Promise.all(handedToAfter) // the platform runs the hook's work to the end after the reply
    expect(telegramDeliveredAt).toBeGreaterThanOrEqual(t0 + TELEGRAM_DELAY_MS - 50)
    // one transition, one alert per channel
    expect(channels.telegram).toHaveBeenCalledTimes(1)
    expect(channels.email).toHaveBeenCalledTimes(1)
    expect(channels.discord).toHaveBeenCalledTimes(1)
  })
})
