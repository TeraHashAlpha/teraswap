/**
 * @vitest-environment node
 *
 * [ADR-025] /api/admin/ui-version — same Bearer gate as dca-freeze; sets/clears the signed ts_ui cookie.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'
import { isValidUiCookie } from '@/ui/v2/ui-cookie'

const ADMIN = 'test-ui-admin-secret'
const COOKIE_SECRET = 'test-cookie-secret-abc123'
const originalEnv = { ...process.env }

function post(body: unknown, token?: string): NextRequest {
  return new NextRequest('https://teraswap.app/api/admin/ui-version', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.UI_V2_ADMIN_SECRET = ADMIN
  process.env.UI_V2_COOKIE_SECRET = COOKIE_SECRET
})
afterEach(() => {
  process.env = { ...originalEnv }
})

describe('POST /api/admin/ui-version', () => {
  it('rejects a request with no Authorization header (401, no cookie)', async () => {
    const res = await POST(post({ version: 'v2' }))
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('rejects a wrong token (401)', async () => {
    const res = await POST(post({ version: 'v2' }, 'nope'))
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('503 when the admin secret is not configured', async () => {
    delete process.env.UI_V2_ADMIN_SECRET
    expect((await POST(post({ version: 'v2' }, ADMIN))).status).toBe(503)
  })

  it('503 on v2 when the cookie secret is not configured (never mints an unsigned cookie)', async () => {
    delete process.env.UI_V2_COOKIE_SECRET
    const res = await POST(post({ version: 'v2' }, ADMIN))
    expect(res.status).toBe(503)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('400 on invalid JSON and on an unknown version', async () => {
    expect((await POST(post('{not json', ADMIN))).status).toBe(400)
    expect((await POST(post({ version: 'v3' }, ADMIN))).status).toBe(400)
    expect((await POST(post({}, ADMIN))).status).toBe(400)
  })

  it('v2 sets a signed HttpOnly/Secure/SameSite=Lax 30-day cookie', async () => {
    const res = await POST(post({ version: 'v2' }, ADMIN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: 'v2' })
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/^ts_ui=[0-9a-f]{64};/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=lax/i)
    expect(cookie).toMatch(/Max-Age=2592000/i)
    expect(cookie).toMatch(/Path=\//i)
    const value = /^ts_ui=([0-9a-f]{64})/.exec(cookie)?.[1]
    expect(isValidUiCookie(value, COOKIE_SECRET)).toBe(true)
  })

  it('v1 clears the cookie', async () => {
    const res = await POST(post({ version: 'v1' }, ADMIN))
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/^ts_ui=;/)
    expect(cookie).toMatch(/Max-Age=0/i)
    expect(cookie).toMatch(/HttpOnly/i)
  })
})
