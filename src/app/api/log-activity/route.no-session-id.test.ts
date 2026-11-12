/**
 * [fix/privacy-no-usage-tracking] /api/log-activity ignores a session id sent by an old cached bundle:
 * the stored row carries `session_id: null`.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

const insert = vi.fn(async (_rows: unknown) => ({ error: null }))
vi.mock('@/lib/supabase', () => ({ getSupabaseLogger: () => ({ from: () => ({ insert }) }) }))
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 }) }
})

import { POST } from './route'

describe('POST /api/log-activity: session id', () => {
  it('stores session_id as null even when the client sends one', async () => {
    const res = await POST(new NextRequest('http://localhost/api/log-activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ wallet: '0x' + '1'.repeat(40), session_id: 'old-bundle-session', category: 'swap', action: 'swap_ok' }] }),
    }))
    expect(res.status).toBe(200)
    expect(insert).toHaveBeenCalledTimes(1)
    const rows = insert.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].session_id).toBeNull()
    expect(rows[0].wallet).toBe('0x' + '1'.repeat(40))
  })
})
