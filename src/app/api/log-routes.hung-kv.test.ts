// @vitest-environment node
/**
 * [fix/privacy-leftovers-a78b S-12] The log routes answer when Redis hangs, like /api/log-event (A78 S-7, log-event/route.hung-kv.test.ts).
 *
 * The limiter is the REAL code (checkRateLimitWithin over the real kv-rate-limiter) on a Redis client whose every call never
 * settles. Before: `await checkRateLimit(...)` waited out the client's retries, ~4.5 s per request, on every quote, swap and
 * activity post. Now the wait is bounded at 1 s and the in-memory limiter decides, at half the quota per instance:
 * degraded, never unlimited.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const hang = vi.hoisted(() => () => new Promise<never>(() => {}))
vi.mock('@/lib/kv', () => {
  const p: Record<string, unknown> = {}
  for (const m of ['zremrangebyscore', 'zcard', 'zadd', 'expire']) p[m] = () => p
  p.exec = hang
  return { kv: { get: vi.fn(hang), set: vi.fn(hang), zrem: vi.fn(hang), zrange: vi.fn(hang), pipeline: () => p } }
})
vi.mock('@/lib/supabase', () => ({ getSupabase: () => null, getSupabaseLogger: () => null }))
vi.mock('@/lib/wallet-activity-server', () => ({ trackWalletAction: vi.fn() }))
vi.mock('@/lib/security-tracker', () => ({
  trackLargeTrade: vi.fn(),
  trackSwapFailed: vi.fn(),
  trackOracleDeviation: vi.fn(),
  trackOracleUnavailable: vi.fn(),
  trackQuoteFailure: vi.fn(),
}))

import { _internal, LOG_RATE_LIMIT } from '@/lib/kv-rate-limiter'
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
  _internal.reset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the log routes with a hung Redis', () => {
  it.each(ROUTES)('%s %s answers (not 429) in under 1.5 s', async (name, method, handler) => {
    const t0 = Date.now()
    const res = await handler(call(name, method, `198.51.100.${ROUTES.findIndex((r) => r[0] === name && r[1] === method) + 10}`))
    const ms = Date.now() - t0
    process.stdout.write(`[hung-kv] ${name} ${method} answered ${res.status} in ${ms} ms\n`)
    expect(res.status).not.toBe(429)
    expect(ms).toBeLessThan(1_500)
  }, 10_000)

  it.each(ROUTES)('%s %s: the limit still applies, degraded to half: 60 pass, the 61st is a 429', async (name, method, handler) => {
    vi.useFakeTimers()
    const degraded = Math.ceil(LOG_RATE_LIMIT.limit / 2)
    const ip = `198.51.100.${ROUTES.findIndex((r) => r[0] === name && r[1] === method) + 40}`
    const send = async () => {
      const pending = handler(call(name, method, ip))
      await vi.advanceTimersByTimeAsync(1_000)
      return pending
    }
    for (let i = 1; i <= degraded; i++) expect((await send()).status, `request ${i}`).not.toBe(429)
    expect((await send()).status).toBe(429)
  }, 20_000)
})
