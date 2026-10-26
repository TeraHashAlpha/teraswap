/**
 * @vitest-environment node
 *
 * [ADR-025] The whole opt-in, end to end with the REAL pieces: the admin route (/api/admin/ui-version) answers the
 * form's POST, and proxy.ts reads the cookie it sets. no cookie → v1 · right secret → cookie → v2 · wrong secret →
 * 401, no cookie → still v1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'
import { POST } from '@/app/api/admin/ui-version/route'
import { UI_COOKIE_NAME } from '@/ui/v2/ui-cookie'

const ADMIN = 'admin-secret-for-the-test'
const COOKIE_SECRET = 'cookie-secret-for-the-test'
const originalEnv = { ...process.env }

beforeEach(() => {
  delete process.env.UI_V2_ENABLED
  process.env.UI_V2_ADMIN_SECRET = ADMIN
  process.env.UI_V2_COOKIE_SECRET = COOKIE_SECRET
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VERCEL_ENV', 'preview')
})
afterEach(() => {
  process.env = { ...originalEnv }
  vi.unstubAllEnvs()
})

// Exactly what enable-form.tsx sends.
function formPost(secret: string): NextRequest {
  return new NextRequest('https://preview.teraswap.app/api/admin/ui-version', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ version: 'v2' }),
  })
}
const visit = (path: string, cookie?: string) =>
  proxy(new NextRequest(`https://preview.teraswap.app${path}`, cookie ? { headers: { cookie: `${UI_COOKIE_NAME}=${cookie}` } } : undefined))
const isV1 = (res: Response) => res.headers.get('x-middleware-next') === '1' && res.headers.get('x-middleware-rewrite') === null
const rewrittenTo = (res: Response) => new URL(res.headers.get('x-middleware-rewrite') ?? 'x:/').pathname

describe('preview opt-in flow', () => {
  it('no cookie → v1 on `/` and the tabs', () => {
    expect(isV1(visit('/'))).toBe(true)
    expect(isV1(visit('/swap'))).toBe(true)
  })

  it('right secret → 200 + the signed ts_ui cookie (HttpOnly, Secure, Lax, 30 d) → `/` is v2 afterwards', async () => {
    const res = await POST(formPost(ADMIN))
    expect(res.status).toBe(200)
    const set = res.cookies.get(UI_COOKIE_NAME)!
    expect(set.value).toMatch(/^[0-9a-f]{64}$/)
    expect([set.httpOnly, set.secure, set.sameSite, set.maxAge]).toEqual([true, true, 'lax', 30 * 24 * 60 * 60])
    expect(rewrittenTo(visit('/', set.value))).toBe('/v2')
    expect(rewrittenTo(visit('/swap', set.value))).toBe('/v2/swap')
  })

  it('wrong secret → 401, NO Set-Cookie → still v1', async () => {
    const res = await POST(formPost('wrong-secret'))
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.cookies.get(UI_COOKIE_NAME)).toBeUndefined()
    expect(isV1(visit('/'))).toBe(true)
  })

  it('no secret / no Authorization header → 401, no cookie; an unset admin secret → 503, no cookie', async () => {
    const bare = new NextRequest('https://preview.teraswap.app/api/admin/ui-version', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"version":"v2"}',
    })
    const res = await POST(bare)
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
    delete process.env.UI_V2_ADMIN_SECRET
    const unconfigured = await POST(formPost(ADMIN))
    expect(unconfigured.status).toBe(503)
    expect(unconfigured.headers.get('set-cookie')).toBeNull()
  })

  it('a cookie signed under another secret never opens v2 (the cookie, not the form, is the gate)', async () => {
    process.env.UI_V2_COOKIE_SECRET = 'a-different-secret'
    const res = await POST(formPost(ADMIN))
    const value = res.cookies.get(UI_COOKIE_NAME)!.value
    process.env.UI_V2_COOKIE_SECRET = COOKIE_SECRET
    expect(isV1(visit('/', value))).toBe(true)
  })

  it('the form itself is reachable with no cookie in preview, and 404s in production', () => {
    expect(visit('/v2/_enable').headers.get('x-middleware-next')).toBe('1')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(rewrittenTo(visit('/v2/_enable'))).toBe('/v2-disabled')
  })
})
