// @vitest-environment node
/**
 * [fix/privacy-no-usage-tracking A78 S-7] The retired /api/log-event must answer when Redis hangs.
 *
 * The limiter is the REAL code (checkRateLimitWithin over the real kv-rate-limiter) on a Redis client whose every call
 * never settles. Before: `await checkRateLimit(...)` waited out the client's retries, ~4.5 s per 204. Now the wait is
 * bounded at 1 s and the in-memory limiter decides.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const hang = vi.hoisted(() => () => new Promise<never>(() => {}))
vi.mock('@/lib/kv', () => {
  const p: Record<string, unknown> = {}
  for (const m of ['zremrangebyscore', 'zcard', 'zadd', 'expire']) p[m] = () => p
  p.exec = hang
  return { kv: { get: vi.fn(hang), set: vi.fn(hang), zrem: vi.fn(hang), zrange: vi.fn(hang), pipeline: () => p } }
})

import { POST } from './route'

const post = (ip: string) =>
  new NextRequest('http://localhost/api/log-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ events: [{ event_type: 'page_view' }] }),
  })

afterEach(() => vi.restoreAllMocks())

describe('POST /api/log-event with a hung Redis', () => {
  it('answers 204 in under 1.5 s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const t0 = Date.now()
    const res = await POST(post('203.0.113.21'))
    const ms = Date.now() - t0
    console.info(`[hung-kv] log-event answered in ${ms} ms`)
    expect(res.status).toBe(204)
    expect(ms).toBeLessThan(1_500)
  }, 10_000)
})
