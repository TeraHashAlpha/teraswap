/**
 * @vitest-environment node
 *
 * [ADR-025] proxy.ts is the switch: `/` → `/v2` rewrite only for v2; direct `/v2/*` hits are a real 404
 * (rewrite to a non-existent path) unless the same rule says v2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { config, proxy } from './proxy'
import { isV2KitEnabled } from '@/ui/v2/kit-gate'
import { signUiVersionCookie } from '@/ui/v2/ui-cookie'

const SECRET = 'test-cookie-secret-abc123'
const originalEnv = { ...process.env }

function req(path: string, cookie?: string): NextRequest {
  return new NextRequest(`https://www.teraswap.app${path}`, cookie ? { headers: { cookie: `ts_ui=${cookie}` } } : undefined)
}
const passes = (res: Response) => res.headers.get('x-middleware-next') === '1' && res.headers.get('x-middleware-rewrite') === null
const rewrittenTo = (res: Response) => new URL(res.headers.get('x-middleware-rewrite') ?? 'x:/').pathname

beforeEach(() => {
  delete process.env.UI_V2_ENABLED
  process.env.UI_V2_COOKIE_SECRET = SECRET
})
afterEach(() => {
  process.env = { ...originalEnv }
  vi.unstubAllEnvs()
})

describe('matcher', () => {
  it('covers `/` and the v2 tree only — nothing else is touched', () => {
    expect(config.matcher).toEqual(['/', '/v2', '/v2/:path*'])
  })
})

describe('`/` (the v1 landing)', () => {
  it('no env, no cookie → untouched (v1)', () => {
    expect(passes(proxy(req('/')))).toBe(true)
  })
  it('forged / wrong-secret cookie → untouched (v1)', () => {
    expect(passes(proxy(req('/', 'f'.repeat(64))))).toBe(true)
    expect(passes(proxy(req('/', signUiVersionCookie('other-secret'))))).toBe(true)
  })
  it('UI_V2_ENABLED=true → rewritten to /v2', () => {
    process.env.UI_V2_ENABLED = 'true'
    expect(rewrittenTo(proxy(req('/')))).toBe('/v2')
  })
  it('valid cookie → rewritten to /v2', () => {
    expect(rewrittenTo(proxy(req('/', signUiVersionCookie(SECRET))))).toBe('/v2')
  })
  it('cookie path disabled when the secret is unset', () => {
    const cookie = signUiVersionCookie(SECRET)
    delete process.env.UI_V2_COOKIE_SECRET
    expect(passes(proxy(req('/', cookie)))).toBe(true)
  })
})

describe('direct requests to /v2/* (requirement: must NOT render v2 without env/valid cookie)', () => {
  it.each(['/v2', '/v2/swap', '/v2/_kit', '/v2/anything/deep'])('%s with no env/cookie → real 404 path', (path) => {
    const res = proxy(req(path))
    expect(rewrittenTo(res)).toBe('/v2-disabled')
    expect(res.headers.get('x-middleware-next')).toBeNull()
  })
  it('forged and wrong-secret cookies → 404 path', () => {
    expect(rewrittenTo(proxy(req('/v2', 'f'.repeat(64))))).toBe('/v2-disabled')
    expect(rewrittenTo(proxy(req('/v2/swap', signUiVersionCookie('other-secret'))))).toBe('/v2-disabled')
  })
  it('UI_V2_ENABLED=true → passes through', () => {
    process.env.UI_V2_ENABLED = 'true'
    expect(passes(proxy(req('/v2')))).toBe(true)
    expect(passes(proxy(req('/v2/swap')))).toBe(true)
  })
  it('valid cookie → passes through', () => {
    expect(passes(proxy(req('/v2', signUiVersionCookie(SECRET))))).toBe(true)
  })
})

describe('/v2/_kit (dev kit: Preview / next dev only, independent of the switch)', () => {
  const cookie = () => signUiVersionCookie(SECRET)

  it.each([
    ['production', 'production', false],
    ['production', '', false],
    ['test', '', false],
    ['production', 'preview', true],
    ['development', '', true],
  ])('isV2KitEnabled NODE_ENV=%s VERCEL_ENV=%s → %s', (nodeEnv, vercelEnv, expected) => {
    vi.stubEnv('NODE_ENV', nodeEnv)
    vi.stubEnv('VERCEL_ENV', vercelEnv)
    expect(isV2KitEnabled()).toBe(expected)
  })

  it('production: real 404 even with the owner cookie or UI_V2_ENABLED=true', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(rewrittenTo(proxy(req('/v2/_kit')))).toBe('/v2-disabled')
    expect(rewrittenTo(proxy(req('/v2/_kit', cookie())))).toBe('/v2-disabled')
    process.env.UI_V2_ENABLED = 'true'
    expect(rewrittenTo(proxy(req('/v2/_kit')))).toBe('/v2-disabled')
  })

  it('preview → passes through (no cookie needed)', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(passes(proxy(req('/v2/_kit')))).toBe(true)
  })

  it('development → passes through', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('VERCEL_ENV', '')
    expect(passes(proxy(req('/v2/_kit')))).toBe(true)
  })

  it('does not open the rest of /v2 (preview is not the switch)', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(rewrittenTo(proxy(req('/v2')))).toBe('/v2-disabled')
  })
})
