/**
 * Tests for GET /api/monitor/keepers — [fix/executor-alert-masking-rpc-auth] INC-2026-10-30-001:
 * the daily report's authenticated read of the keepers' self-reported paused state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockReadAll = vi.fn()
vi.mock('@/lib/keeper-health-monitor', () => ({
  readAllKeeperPausedStates: () => mockReadAll(),
}))
// [A71 L-1] The route rate-limits first (pinned in route.rate-limit.test.ts); these tests are about
// auth and status, so the limiter always allows here.
vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 29, resetAt: Date.now() + 60_000 }),
}))

const TEST_SECRET = 'test-monitor-secret-keepers-123'
const SINCE = '2026-10-30T15:00:00.000Z'
let originalSecret: string | undefined

async function callGET(headers: Record<string, string> = {}) {
  const { GET } = await import('./route')
  return GET(new Request('http://localhost/api/monitor/keepers', { headers }) as never)
}

describe('GET /api/monitor/keepers', () => {
  beforeEach(() => {
    originalSecret = process.env.MONITOR_SECRET
    process.env.MONITOR_SECRET = TEST_SECRET
    mockReadAll.mockReset()
    vi.resetModules()
  })

  afterEach(() => {
    if (originalSecret !== undefined) process.env.MONITOR_SECRET = originalSecret
    else delete process.env.MONITOR_SECRET
  })

  it('503 when MONITOR_SECRET is not configured; nothing is read', async () => {
    delete process.env.MONITOR_SECRET
    const res = await callGET({ Authorization: `Bearer ${TEST_SECRET}` })
    expect(res.status).toBe(503)
    expect(mockReadAll).not.toHaveBeenCalled()
  })

  it('401 without / with a wrong Bearer token; nothing is read', async () => {
    expect((await callGET()).status).toBe(401)
    expect((await callGET({ Authorization: 'Bearer nope' })).status).toBe(401)
    expect(mockReadAll).not.toHaveBeenCalled()
  })

  it('PAUSED when any keeper reports a pause, with the per-chain rows; never cached', async () => {
    mockReadAll.mockResolvedValue([
      { chainId: 8453, active: true, readable: true, paused: 'rpc-auth', pausedSince: SINCE },
      { chainId: 42161, active: false, readable: true, paused: null, pausedSince: null },
    ])
    const res = await callGET({ Authorization: `Bearer ${TEST_SECRET}` })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.status).toBe('PAUSED')
    expect(body.chains[0]).toEqual({ chainId: 8453, active: true, readable: true, paused: 'rpc-auth', pausedSince: SINCE })
  })

  it('[ADR-026 / A73 S-4] infraMissOrders24h + infraMissStatus (ok | missing | error) pass through per chain; they never change the status', async () => {
    mockReadAll.mockResolvedValue([
      { chainId: 8453, active: true, readable: true, paused: null, pausedSince: null, infraMissOrders24h: 3, infraMissStatus: 'ok' },
      { chainId: 42161, active: false, readable: true, paused: null, pausedSince: null, infraMissOrders24h: null, infraMissStatus: 'missing' },
      { chainId: 1, active: true, readable: true, paused: null, pausedSince: null, infraMissOrders24h: null, infraMissStatus: 'error' },
    ])
    const body = await (await callGET({ Authorization: `Bearer ${TEST_SECRET}` })).json()
    expect(body.status).toBe('OK')
    expect(body.chains.map((c: { chainId: number; infraMissOrders24h: unknown; infraMissStatus: unknown }) => [c.chainId, c.infraMissOrders24h, c.infraMissStatus])).toEqual([[8453, 3, 'ok'], [42161, null, 'missing'], [1, null, 'error']])
  })

  it('OK when readable and nothing is paused; UNKNOWN when nothing could be read (e.g. migration pending)', async () => {
    mockReadAll.mockResolvedValueOnce([{ chainId: 8453, active: true, readable: true, paused: null, pausedSince: null }])
    expect((await (await callGET({ Authorization: `Bearer ${TEST_SECRET}` })).json()).status).toBe('OK')
    mockReadAll.mockResolvedValueOnce([{ chainId: 8453, active: true, readable: false, paused: null, pausedSince: null }])
    expect((await (await callGET({ Authorization: `Bearer ${TEST_SECRET}` })).json()).status).toBe('UNKNOWN')
  })

  it('[A71 M-2] one ACTIVE chain unreadable ⇒ UNKNOWN, never OK — even when another chain reads fine', async () => {
    mockReadAll.mockResolvedValueOnce([
      { chainId: 8453, active: true, readable: false, paused: null, pausedSince: null },
      { chainId: 42161, active: true, readable: true, paused: null, pausedSince: null },
    ])
    expect((await (await callGET({ Authorization: `Bearer ${TEST_SECRET}` })).json()).status).toBe('UNKNOWN')
    // an unreadable INACTIVE chain executes nothing: it does not downgrade an otherwise readable set
    mockReadAll.mockResolvedValueOnce([
      { chainId: 8453, active: true, readable: true, paused: null, pausedSince: null },
      { chainId: 42161, active: false, readable: false, paused: null, pausedSince: null },
    ])
    expect((await (await callGET({ Authorization: `Bearer ${TEST_SECRET}` })).json()).status).toBe('OK')
    // a pause still wins over an unreadable chain
    mockReadAll.mockResolvedValueOnce([
      { chainId: 8453, active: true, readable: true, paused: 'rpc-auth', pausedSince: SINCE },
      { chainId: 42161, active: true, readable: false, paused: null, pausedSince: null },
    ])
    expect((await (await callGET({ Authorization: `Bearer ${TEST_SECRET}` })).json()).status).toBe('PAUSED')
  })
})
