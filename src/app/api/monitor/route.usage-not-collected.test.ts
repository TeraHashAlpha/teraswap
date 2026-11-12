/**
 * [fix/privacy-no-usage-tracking] /api/monitor no longer reads `usage_events` (page views, clicks, devices,
 * sessions are not collected). The payload keeps a `usage` key that says so, so no consumer fails on a missing key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fromTables: string[] = []
function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'limit', 'eq', 'gte']) c[m] = () => c
  c.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
  return c
}
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ from: (t: string) => { fromTables.push(t); return chain() } }),
}))

import { GET } from './route'

beforeEach(() => {
  fromTables.length = 0
  vi.stubEnv('MONITOR_SECRET', 'test-monitor-secret-0123456789')
})

describe('GET /api/monitor: usage analytics', () => {
  it('reports usage as not collected and never queries usage_events', async () => {
    const res = await GET(new Request('http://localhost/api/monitor', { headers: { authorization: 'Bearer test-monitor-secret-0123456789' } }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.usage).toEqual({ collected: false, note: 'not collected' })
    expect(fromTables).not.toContain('usage_events')
    expect(fromTables).toEqual(expect.arrayContaining(['swaps', 'quotes']))
  })
})
