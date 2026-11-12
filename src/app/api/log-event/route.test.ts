/**
 * [fix/privacy-no-usage-tracking] POST /api/log-event is retired: 204, never reads the body, never writes.
 * (Old cached bundles keep posting here; the per-IP rate limit and the header-only size guard stay.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const dbTouched = vi.fn()
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => { dbTouched('getSupabase'); return null },
  getSupabaseLogger: () => { dbTouched('getSupabaseLogger'); return null },
}))

const mockCheckRateLimit = vi.fn(async (..._args: unknown[]) => ({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 }))
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  return { ...actual, checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args) }
})

import { POST, OPTIONS } from './route'

const EVENT = {
  events: [{
    session_id: 'abc', event_type: 'page_view', page: '/', referrer: 'https://x.test/',
    screen_w: 1280, user_agent: 'Mozilla/5.0', click_target: 'Swap',
  }],
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/log-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  dbTouched.mockClear()
  mockCheckRateLimit.mockClear()
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 })
})

describe('POST /api/log-event (retired)', () => {
  it('answers 204 with an empty body', async () => {
    const res = await POST(req(EVENT))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('never reads the request body', async () => {
    const r = req(EVENT)
    const json = vi.spyOn(r, 'json')
    const text = vi.spyOn(r, 'text')
    const buf = vi.spyOn(r, 'arrayBuffer')
    const form = vi.spyOn(r, 'formData')
    const res = await POST(r)
    expect(res.status).toBe(204)
    expect(json).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(buf).not.toHaveBeenCalled()
    expect(form).not.toHaveBeenCalled()
    expect(r.bodyUsed).toBe(false)
  })

  it('writes nothing: no database client is even requested', async () => {
    await POST(req(EVENT))
    await POST(req({ not: 'events' }))
    expect(dbTouched).not.toHaveBeenCalled()
  })

  it('keeps its rate limit (shared log:<ip> budget → 429)', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 })
    const res = await POST(req(EVENT, { 'x-forwarded-for': '6.6.6.6' }))
    expect(res.status).toBe(429)
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.stringMatching(/^log:/), expect.any(Number), expect.any(Number))
  })

  it('keeps the CORS preflight', () => {
    expect(OPTIONS(req({})).status).toBe(204)
  })
})
