/**
 * [A71 L-1] GET /api/monitor/keepers is rate-limited per trusted client IP BEFORE the auth check:
 * `checkRateLimit("monitor:<ip>", 30, 60_000)`. A limited caller gets 429 whatever its token, and
 * nothing is read from Supabase.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hashClientIp } from '@/lib/client-ip-key'

const mockReadAll = vi.fn()
vi.mock('@/lib/keeper-health-monitor', () => ({
  readAllKeeperPausedStates: () => mockReadAll(),
}))
const mockRate = vi.fn()
vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockRate(...args),
}))

const TEST_SECRET = 'test-monitor-secret-keepers-123'
const IP = '203.0.113.7'
let originalSecret: string | undefined

async function callGET(headers: Record<string, string> = {}) {
  const { GET } = await import('./route')
  return GET(new Request('http://localhost/api/monitor/keepers', { headers: { 'x-vercel-forwarded-for': IP, ...headers } }) as never)
}

describe('[A71 L-1] GET /api/monitor/keepers — rate limit before auth', () => {
  beforeEach(() => {
    originalSecret = process.env.MONITOR_SECRET
    process.env.MONITOR_SECRET = TEST_SECRET
    // [fix/user-ip-privacy] The key is HMAC(daily salt, ip). `vi.resetModules()` below gives the route its OWN copy of
    // client-ip-key.ts — a second "instance" — so without a configured salt it and this file would each draw a
    // different per-process random one. RATE_LIMIT_SALT is what makes two instances agree, in tests as in production.
    vi.stubEnv('RATE_LIMIT_SALT', 'test-rate-limit-salt-0123456789abcdef-0123456789')
    mockReadAll.mockReset()
    mockRate.mockReset()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (originalSecret !== undefined) process.env.MONITOR_SECRET = originalSecret
    else delete process.env.MONITOR_SECRET
  })

  it('limited ⇒ 429 with Retry-After, before the token is even looked at; nothing is read', async () => {
    mockRate.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 42_000 })
    const cases: Array<Record<string, string>> = [{ Authorization: `Bearer ${TEST_SECRET}` }, { Authorization: 'Bearer nope' }, {}]
    for (const headers of cases) {
      const res = await callGET(headers)
      expect(res.status).toBe(429)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    }
    delete process.env.MONITOR_SECRET
    expect((await callGET()).status).toBe(429) // not 503: the limiter runs first
    expect(mockReadAll).not.toHaveBeenCalled()
  })

  it('keyed by the trusted client IP under the monitor: prefix, 30 per minute', async () => {
    mockRate.mockResolvedValue({ allowed: true, remaining: 29, resetAt: Date.now() + 60_000 })
    mockReadAll.mockResolvedValue([{ chainId: 8453, active: true, readable: true, paused: null, pausedSince: null }])
    expect((await callGET({ Authorization: `Bearer ${TEST_SECRET}` })).status).toBe(200)
    expect(mockRate).toHaveBeenCalledTimes(1)
    expect(mockRate).toHaveBeenCalledWith(`monitor:${hashClientIp(IP)}`, 30, 60_000)
    expect(String(mockRate.mock.calls[0][0])).not.toContain(IP)
  })

  it('allowed ⇒ the auth check still applies (401 without a token)', async () => {
    mockRate.mockResolvedValue({ allowed: true, remaining: 29, resetAt: Date.now() + 60_000 })
    expect((await callGET()).status).toBe(401)
    expect(mockRate).toHaveBeenCalledTimes(1)
    expect(mockReadAll).not.toHaveBeenCalled()
  })
})
