// @vitest-environment node
/**
 * [fix/privacy-leftovers-a78b S-21] POST /api/log-swap with a SLOW Redis: one that answers, but later than the 1 s gate.
 *
 * The sibling tests cover a Redis that never answers (log-routes.hung-kv.test.ts). A slow one is the case the per-instance
 * arithmetic in src/app/api/CLAUDE.md is about: past the gate (`RATE_LIMIT_GATE_TIMEOUT_MS`) the request is decided by the
 * in-memory limiter, which allows ceil(limit / 2) per key per window PER INSTANCE, and it is charged there exactly once
 * whether Redis answers late with a count or with an error (`checkRateLimit`'s `abandoned` flag, kv-rate-limiter.ts:246-247).
 *
 * The limiter is the real checkRateLimitWithin over the real kv-rate-limiter; only the Redis client is replaced.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const redis = vi.hoisted(() => ({ delayMs: 0, fail: false }))
vi.mock('@/lib/kv', () => {
  const p: Record<string, unknown> = {}
  for (const m of ['zremrangebyscore', 'zcard', 'zadd', 'expire']) p[m] = () => p
  // ZREMRANGEBYSCORE, ZCARD (0 entries before ours), ZADD, EXPIRE: Redis would allow every request.
  p.exec = () =>
    new Promise((resolve, reject) => {
      setTimeout(() => (redis.fail ? reject(new Error('upstream timeout')) : resolve([0, 0, 1, 1])), redis.delayMs)
    })
  return { kv: { get: vi.fn(), set: vi.fn(), zrem: vi.fn(async () => 1), zrange: vi.fn(async () => []), pipeline: () => p } }
})
vi.mock('@/lib/supabase', () => ({ getSupabase: () => null, getSupabaseLogger: () => null }))
vi.mock('@/lib/wallet-activity-server', () => ({ trackWalletAction: vi.fn() }))
vi.mock('@/lib/security-tracker', () => ({
  trackLargeTrade: vi.fn(),
  trackSwapFailed: vi.fn(),
  trackOracleDeviation: vi.fn(),
  trackOracleUnavailable: vi.fn(),
}))

import { _internal, LOG_RATE_LIMIT, RATE_LIMIT_GATE_TIMEOUT_MS } from '@/lib/kv-rate-limiter'
import { POST } from './route'

const post = (ip: string) =>
  new NextRequest('http://localhost/api/log-swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: '{}',
  })

/** What the in-memory fallback has been charged, summed over keys (one key here: the caller's hashed IP). */
const charged = () => [..._internal.getFallbackMap().values()].reduce((n, e) => n + e.count, 0)

beforeEach(() => {
  _internal.reset()
  redis.delayMs = 0
  redis.fail = false
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('POST /api/log-swap with a slow Redis', () => {
  it('Redis answering inside the gate decides alone: the request passes and the in-memory limiter is never charged', async () => {
    redis.delayMs = 300
    const pending = POST(post('198.51.100.1'))
    await vi.advanceTimersByTimeAsync(300)
    expect((await pending).status).not.toBe(429)
    expect(charged()).toBe(0)
  })

  it('Redis answering after the gate: the request is decided at the gate by the in-memory limiter, which is charged once', async () => {
    redis.delayMs = 2_500
    const pending = POST(post('198.51.100.2'))
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_GATE_TIMEOUT_MS - 1)
    expect(charged(), 'still waiting on Redis before the gate').toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).status).not.toBe(429)
    expect(charged()).toBe(1)
    // The late answer (a count) lands: it changes nothing here.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(charged()).toBe(1)
  })

  it('Redis failing after the gate: the late error does not charge the in-memory limiter a second time', async () => {
    redis.delayMs = 2_500
    redis.fail = true
    const pending = POST(post('198.51.100.3'))
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_GATE_TIMEOUT_MS)
    expect((await pending).status).not.toBe(429)
    expect(charged()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(charged(), 'the abandoned call is not charged again').toBe(1)
  })

  it('under a slow Redis one instance allows ceil(limit / 2) per key and window, then answers 429, though Redis would have allowed every request', async () => {
    redis.delayMs = 5_000
    const degraded = Math.ceil(LOG_RATE_LIMIT.limit / 2)
    const send = async () => {
      const pending = POST(post('198.51.100.4'))
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_GATE_TIMEOUT_MS)
      return pending
    }
    for (let i = 1; i <= degraded; i++) expect((await send()).status, `request ${i}`).not.toBe(429)
    expect(charged()).toBe(degraded)
    expect((await send()).status).toBe(429)
  }, 20_000)
})
