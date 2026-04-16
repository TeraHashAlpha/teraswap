/**
 * Tests for POST /api/monitor/tick — auth enforcement (API-C-01).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock monitoring-loop before importing route
vi.mock('@/lib/monitoring-loop', () => ({
  runMonitoringTick: vi.fn().mockResolvedValue({ ok: true, sources: [] }),
}))

const TEST_SECRET = 'test-monitor-cron-secret-abc123'
let originalEnv: string | undefined

describe('POST /api/monitor/tick', () => {
  beforeEach(() => {
    originalEnv = process.env.MONITOR_CRON_SECRET
    vi.resetModules()
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MONITOR_CRON_SECRET = originalEnv
    } else {
      delete process.env.MONITOR_CRON_SECRET
    }
  })

  async function callPOST(headers: Record<string, string> = {}) {
    process.env.MONITOR_CRON_SECRET = TEST_SECRET
    const { POST } = await import('./route')
    const req = new Request('http://localhost/api/monitor/tick', {
      method: 'POST',
      headers,
    })
    return POST(req as any)
  }

  it('returns 200 with correct Bearer token', async () => {
    const res = await callPOST({ Authorization: `Bearer ${TEST_SECRET}` })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('returns 401 without auth header', async () => {
    const res = await callPOST({})
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('unauthorized')
  })

  it('returns 401 with wrong token', async () => {
    const res = await callPOST({ Authorization: 'Bearer wrong-token' })
    expect(res.status).toBe(401)
  })

  it('returns 401 with non-Bearer auth scheme', async () => {
    const res = await callPOST({ Authorization: `Basic ${TEST_SECRET}` })
    expect(res.status).toBe(401)
  })

  it('returns 503 when MONITOR_CRON_SECRET is not set', async () => {
    delete process.env.MONITOR_CRON_SECRET
    const { POST } = await import('./route')
    const req = new Request('http://localhost/api/monitor/tick', {
      method: 'POST',
      headers: { Authorization: 'Bearer anything' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('not configured')
  })

  it('no GET export exists (Next.js returns 405)', async () => {
    process.env.MONITOR_CRON_SECRET = TEST_SECRET
    const mod = await import('./route')
    expect((mod as any).GET).toBeUndefined()
  })
})
