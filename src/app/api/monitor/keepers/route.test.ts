/**
 * Tests for GET /api/monitor/keepers — [fix/executor-alert-masking-rpc-auth] INC-2026-10-30-001:
 * the daily report's authenticated read of the keepers' self-reported paused state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockReadAll = vi.fn()
vi.mock('@/lib/keeper-health-monitor', () => ({
  readAllKeeperPausedStates: () => mockReadAll(),
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

  it('OK when readable and nothing is paused; UNKNOWN when nothing could be read (e.g. migration pending)', async () => {
    mockReadAll.mockResolvedValueOnce([{ chainId: 8453, active: true, readable: true, paused: null, pausedSince: null }])
    expect((await (await callGET({ Authorization: `Bearer ${TEST_SECRET}` })).json()).status).toBe('OK')
    mockReadAll.mockResolvedValueOnce([{ chainId: 8453, active: true, readable: false, paused: null, pausedSince: null }])
    expect((await (await callGET({ Authorization: `Bearer ${TEST_SECRET}` })).json()).status).toBe('UNKNOWN')
  })
})
