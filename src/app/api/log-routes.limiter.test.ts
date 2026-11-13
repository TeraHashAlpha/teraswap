// @vitest-environment node
/**
 * [fix/privacy-leftovers-a78b S-12] /api/log-quote, /api/log-swap (POST and PATCH) and /api/log-activity use the bounded limiter
 * (checkRateLimitWithin) like /api/log-event, with the SAME key, limit and window, so the per-IP log budget stays one budget.
 *
 * Real limiter code over an in-memory sorted-set KV (no mock of the limiter's decision): the 120th request from one IP is
 * allowed and the 121st is a 429, whichever mix of log routes the 120 went to. The hung-Redis timings are in
 * log-routes.hung-kv.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Member = { score: number; member: string }
const zsets = vi.hoisted(() => new Map<string, Member[]>())
vi.mock('@/lib/kv', () => {
  const kv = {
    pipeline() {
      const ops: Array<() => unknown> = []
      const p = {
        zremrangebyscore(k: string, min: number, max: number) {
          ops.push(() => {
            const before = zsets.get(k) ?? []
            const kept = before.filter((m) => m.score < min || m.score > max)
            zsets.set(k, kept)
            return before.length - kept.length
          })
          return p
        },
        zcard(k: string) {
          ops.push(() => (zsets.get(k) ?? []).length)
          return p
        },
        zadd(k: string, ...members: Member[]) {
          ops.push(() => {
            zsets.set(k, [...(zsets.get(k) ?? []), ...members])
            return members.length
          })
          return p
        },
        expire() {
          ops.push(() => 1)
          return p
        },
        exec: async () => ops.map((op) => op()),
      }
      return p
    },
    zrem: async (k: string, ...members: string[]) => {
      zsets.set(k, (zsets.get(k) ?? []).filter((m) => !members.includes(m.member)))
      return members.length
    },
    zrange: async () => [],
    get: async () => null,
    set: async () => 'OK',
  }
  return { kv }
})

// The routes stop after the limiter: no database client, so nothing downstream runs.
vi.mock('@/lib/supabase', () => ({ getSupabase: () => null, getSupabaseLogger: () => null }))
vi.mock('@/lib/wallet-activity-server', () => ({ trackWalletAction: vi.fn() }))
vi.mock('@/lib/security-tracker', () => ({
  trackLargeTrade: vi.fn(),
  trackSwapFailed: vi.fn(),
  trackOracleDeviation: vi.fn(),
  trackOracleUnavailable: vi.fn(),
  trackQuoteFailure: vi.fn(),
}))

const spies = vi.hoisted(() => ({ within: vi.fn(), plain: vi.fn() }))
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  spies.within.mockImplementation(actual.checkRateLimitWithin)
  spies.plain.mockImplementation(actual.checkRateLimit)
  return { ...actual, checkRateLimitWithin: spies.within, checkRateLimit: spies.plain }
})

import { LOG_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { POST as logEvent } from './log-event/route'
import { POST as logQuote } from './log-quote/route'
import { POST as logSwap, PATCH as logSwapPatch } from './log-swap/route'
import { POST as logActivity } from './log-activity/route'

type Handler = (req: NextRequest) => Promise<Response>
const ROUTES: Array<[string, string, Handler]> = [
  ['log-quote', 'POST', logQuote as Handler],
  ['log-swap', 'POST', logSwap as Handler],
  ['log-swap', 'PATCH', logSwapPatch as Handler],
  ['log-activity', 'POST', logActivity as unknown as Handler],
]

const call = (name: string, method: string, ip: string) =>
  new NextRequest(`http://localhost/api/${name}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: '{}',
  })

beforeEach(() => {
  zsets.clear()
  spies.within.mockClear()
  spies.plain.mockClear()
})

describe('the log routes keep the same per-IP budget', () => {
  it('the numbers are unchanged: 120 requests per 60 s', () => {
    expect(LOG_RATE_LIMIT).toEqual({ limit: 120, windowMs: 60_000 })
  })

  it.each(ROUTES)('%s %s calls checkRateLimitWithin once, with the same key, limit and window as log-event, and never the plain limiter', async (name, method, handler) => {
    await logEvent(call('log-event', 'POST', '203.0.113.50') as never)
    const [eventKey, eventLimit, eventWindow] = spies.within.mock.calls[0]
    spies.within.mockClear()

    await handler(call(name, method, '203.0.113.50'))
    expect(spies.plain).not.toHaveBeenCalled()
    expect(spies.within).toHaveBeenCalledTimes(1)
    const [key, limit, windowMs] = spies.within.mock.calls[0]
    expect(key).toBe(eventKey)
    expect(String(key)).toMatch(/^log:/)
    expect([limit, windowMs]).toEqual([eventLimit, eventWindow])
    expect([limit, windowMs]).toEqual([LOG_RATE_LIMIT.limit, LOG_RATE_LIMIT.windowMs])
  })

  it.each(ROUTES)('%s %s: the limit still applies, request 120 passes and request 121 is a 429', async (name, method, handler) => {
    const ip = `203.0.113.${60 + ROUTES.findIndex((r) => r[0] === name && r[1] === method)}`
    for (let i = 1; i <= LOG_RATE_LIMIT.limit; i++) {
      const res = await handler(call(name, method, ip))
      expect(res.status, `request ${i}`).not.toBe(429)
    }
    const over = await handler(call(name, method, ip))
    expect(over.status).toBe(429)
    expect(over.headers.get('X-RateLimit-Reset')).toBeTruthy()
  })

  it('the 120 are one budget across routes: 40 + 40 + 40 over quote, swap and activity, then every log route (event included) answers 429', async () => {
    const ip = '203.0.113.99'
    for (let i = 0; i < 40; i++) await logQuote(call('log-quote', 'POST', ip))
    for (let i = 0; i < 40; i++) await logSwap(call('log-swap', 'POST', ip))
    for (let i = 0; i < 40; i++) await (logActivity as unknown as Handler)(call('log-activity', 'POST', ip))
    for (const [name, method, handler] of ROUTES) expect((await handler(call(name, method, ip))).status, `${name} ${method}`).toBe(429)
    expect((await logEvent(call('log-event', 'POST', ip) as never)).status).toBe(429)
  })
})
