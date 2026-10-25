/**
 * @vitest-environment node
 *
 * [ADR-025] getUiVersion() — server-side switch. next/headers is mocked; the HMAC is the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let cookieValue: string | undefined
const cookiesSpy = vi.fn(async () => ({
  get: (name: string) => (name === 'ts_ui' && cookieValue !== undefined ? { name, value: cookieValue } : undefined),
}))
vi.mock('next/headers', () => ({ cookies: () => cookiesSpy() }))

import { getUiVersion } from './version'
import { isValidUiCookie, resolveUiVersion, signUiVersionCookie } from './ui-cookie'

const SECRET = 'test-cookie-secret-abc123'
const originalEnv = { ...process.env }

beforeEach(() => {
  delete process.env.UI_V2_ENABLED
  delete process.env.UI_V2_COOKIE_SECRET
  cookieValue = undefined
  cookiesSpy.mockClear()
})
afterEach(() => {
  process.env = { ...originalEnv }
})

describe('getUiVersion', () => {
  it('no env, no cookie → v1', async () => {
    process.env.UI_V2_COOKIE_SECRET = SECRET
    expect(await getUiVersion()).toBe('v1')
  })

  it("UI_V2_ENABLED === 'true' → v2 without reading cookies", async () => {
    process.env.UI_V2_ENABLED = 'true'
    expect(await getUiVersion()).toBe('v2')
    expect(cookiesSpy).not.toHaveBeenCalled()
  })

  it.each(['1', 'TRUE', 'True', 'yes', 'false', ''])("UI_V2_ENABLED=%j is not 'true' → v1", async (val) => {
    process.env.UI_V2_ENABLED = val
    expect(await getUiVersion()).toBe('v1')
  })

  it('valid signed cookie → v2', async () => {
    process.env.UI_V2_COOKIE_SECRET = SECRET
    cookieValue = signUiVersionCookie(SECRET)
    expect(await getUiVersion()).toBe('v2')
  })

  it('cookie signed with a different secret → v1', async () => {
    process.env.UI_V2_COOKIE_SECRET = SECRET
    cookieValue = signUiVersionCookie('some-other-secret')
    expect(await getUiVersion()).toBe('v1')
  })

  it.each([
    ['plain v2', 'v2'],
    ['truncated mac', signUiVersionCookie(SECRET).slice(0, 63)],
    ['uppercased mac', signUiVersionCookie(SECRET).toUpperCase()],
    ['non-hex 64 chars', 'z'.repeat(64)],
    ['empty', ''],
  ])('forged cookie (%s) → v1', async (_label, forged) => {
    process.env.UI_V2_COOKIE_SECRET = SECRET
    cookieValue = forged
    expect(await getUiVersion()).toBe('v1')
  })

  it('missing secret disables the cookie path (and skips cookies())', async () => {
    cookieValue = signUiVersionCookie(SECRET)
    expect(await getUiVersion()).toBe('v1')
    expect(cookiesSpy).not.toHaveBeenCalled()
  })
})

describe('isValidUiCookie', () => {
  it('accepts only the exact HMAC of "v2"', () => {
    const good = signUiVersionCookie(SECRET)
    expect(isValidUiCookie(good, SECRET)).toBe(true)
    expect(isValidUiCookie(good, 'other')).toBe(false)
    expect(isValidUiCookie(undefined, SECRET)).toBe(false)
    expect(isValidUiCookie(good, undefined)).toBe(false)
  })
})

describe('resolveUiVersion (the rule proxy.ts applies to the request)', () => {
  const good = signUiVersionCookie(SECRET)
  it.each([
    ['no env, no cookie', {}, 'v1'],
    ["env 'true'", { enabled: 'true' }, 'v2'],
    ['env true + no secret', { enabled: 'true', secret: undefined }, 'v2'],
    ["env 'TRUE' is not 'true'", { enabled: 'TRUE' }, 'v1'],
    ['valid cookie', { secret: SECRET, cookie: good }, 'v2'],
    ['valid cookie, wrong secret', { secret: 'other', cookie: good }, 'v1'],
    ['valid cookie, secret missing', { cookie: good }, 'v1'],
    ['forged cookie', { secret: SECRET, cookie: 'f'.repeat(64) }, 'v1'],
    ['plain v2 cookie', { secret: SECRET, cookie: 'v2' }, 'v1'],
  ])('%s → %s', (_label, input, expected) => {
    expect(resolveUiVersion(input)).toBe(expected)
  })
})
