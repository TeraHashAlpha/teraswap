/**
 * Tests for public heartbeat + admin heartbeat (API-H-01).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock KV
const mockKvGet = vi.fn()
vi.mock('@/lib/kv', () => ({
  kv: { get: (...args: unknown[]) => mockKvGet(...args) },
}))

// Mock grace period
const mockGrace = vi.fn().mockResolvedValue(false)
vi.mock('@/lib/grace-period', () => ({
  isInGracePeriodAsync: () => mockGrace(),
}))

// Mock source state machine
vi.mock('@/lib/source-state-machine', () => ({
  getAllStatuses: vi.fn().mockResolvedValue([
    { sourceId: 'cowswap', state: 'active' },
    { sourceId: '1inch', state: 'degraded' },
    { sourceId: 'odos', state: 'disabled' },
  ]),
}))

const TEST_SECRET = 'heartbeat-admin-secret-xyz'

describe('GET /api/monitor/heartbeat (public)', () => {
  beforeEach(() => {
    vi.resetModules()
    mockKvGet.mockReset()
    mockGrace.mockResolvedValue(false)
  })

  async function callPublic() {
    const { GET } = await import('./route')
    return GET()
  }

  it('returns only healthy, ageSeconds, tickFresh — no source data', async () => {
    mockKvGet.mockResolvedValue(new Date(Date.now() - 60_000).toISOString())

    const res = await callPublic()
    expect(res.status).toBe(200)

    const body = await res.json()
    // Must have only these keys
    const keys = Object.keys(body).sort()
    expect(keys).toEqual(['ageSeconds', 'healthy', 'tickFresh'])

    expect(body.healthy).toBe(true)
    expect(body.tickFresh).toBe(true)
    expect(typeof body.ageSeconds).toBe('number')

    // Must NOT have source/quorum/grace data
    expect(body.sources).toBeUndefined()
    expect(body.quorumHealthy).toBeUndefined()
    expect(body.quorumOutliers).toBeUndefined()
    expect(body.lastTick).toBeUndefined()
    expect(body.tickCount).toBeUndefined()
  })

  it('returns healthy=false when tick is stale', async () => {
    mockKvGet.mockResolvedValue(new Date(Date.now() - 300_000).toISOString()) // 5 min old

    const res = await callPublic()
    const body = await res.json()

    expect(body.healthy).toBe(false)
    expect(body.tickFresh).toBe(false)
  })

  it('returns healthy=true during grace period even if stale', async () => {
    mockKvGet.mockResolvedValue(new Date(Date.now() - 300_000).toISOString())
    mockGrace.mockResolvedValue(true)

    const res = await callPublic()
    const body = await res.json()

    expect(body.healthy).toBe(true)
    expect(body.tickFresh).toBe(false) // tick is stale, but grace overrides healthy
  })

  it('has public cache header', async () => {
    mockKvGet.mockResolvedValue(new Date().toISOString())

    const res = await callPublic()
    expect(res.headers.get('cache-control')).toContain('public')
    expect(res.headers.get('cache-control')).toContain('s-maxage=30')
  })
})

describe('GET /api/monitor/heartbeat/admin', () => {
  beforeEach(() => {
    vi.resetModules()
    mockKvGet.mockReset()
    mockGrace.mockResolvedValue(false)
  })

  async function callAdmin(headers: Record<string, string> = {}) {
    process.env.MONITOR_CRON_SECRET = TEST_SECRET
    const { GET } = await import('./admin/route')
    const req = new Request('http://localhost/api/monitor/heartbeat/admin', { headers })
    return GET(req as any)
  }

  it('returns full data with correct auth', async () => {
    mockKvGet.mockImplementation((key: string) => {
      if (key === 'teraswap:monitor:lastTick') return new Date().toISOString()
      if (key === 'teraswap:monitor:tickCount') return 42
      if (key === 'teraswap:monitor:lastQuorumResult') return {
        timestamp: new Date().toISOString(),
        outliers: [],
        correlatedOutlierCount: 0,
        skipped: false,
      }
      return null
    })

    const res = await callAdmin({ Authorization: `Bearer ${TEST_SECRET}` })
    expect(res.status).toBe(200)

    const body = await res.json()
    // Admin response includes detailed fields
    expect(body.sources).toBeDefined()
    expect(body.sources.active).toBe(1)
    expect(body.sources.degraded).toBe(1)
    expect(body.sources.disabled).toBe(1)
    expect(body.quorumHealthy).toBeDefined()
    expect(body.tickCount).toBe(42)
    expect(body.lastTick).toBeDefined()
  })

  it('returns 401 without auth', async () => {
    const res = await callAdmin({})
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong token', async () => {
    const res = await callAdmin({ Authorization: 'Bearer wrong-token' })
    expect(res.status).toBe(401)
  })

  it('returns 503 when secret not configured', async () => {
    delete process.env.MONITOR_CRON_SECRET
    const { GET } = await import('./admin/route')
    const req = new Request('http://localhost/api/monitor/heartbeat/admin', {
      headers: { Authorization: 'Bearer anything' },
    })
    const res = await GET(req as any)
    expect(res.status).toBe(503)
  })

  it('has no-store cache header', async () => {
    mockKvGet.mockResolvedValue(new Date().toISOString())

    const res = await callAdmin({ Authorization: `Bearer ${TEST_SECRET}` })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
