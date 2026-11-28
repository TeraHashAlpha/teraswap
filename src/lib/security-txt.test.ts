// @vitest-environment node
/**
 * [goal 139] public/.well-known/security.txt (RFC 9116). The Expires check is the reminder: this suite goes red when the
 * file is under 30 days from expiring. To renew it, set Expires to one year from that day.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config as proxyConfig } from '@/proxy'

const DAY_MS = 86_400_000
const fields = () =>
  readFileSync(join(process.cwd(), 'public/.well-known/security.txt'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const at = line.indexOf(': ')
      return [line.slice(0, at), line.slice(at + 2)] as const
    })

describe('security.txt', () => {
  it('has exactly the four fields, once each', () => {
    expect(fields().map(([name]) => name)).toEqual(['Contact', 'Expires', 'Preferred-Languages', 'Canonical'])
    const value = Object.fromEntries(fields())
    // CHANGED EXPECTATION (owner decision, 2026-11-28): THE CONTACT IS THE PRIVACY PAGE'S ADDRESS, support_teraswap@proton.me (SUPPORT_EMAIL).
    expect(value.Contact).toBe('mailto:support_teraswap@proton.me')
    expect(value['Preferred-Languages']).toBe('en, pt')
    expect(value.Canonical).toBe('https://www.teraswap.app/.well-known/security.txt')
  })

  it('Expires is an ISO 8601 UTC date-time that is at least 30 days away', () => {
    const expires = Object.fromEntries(fields()).Expires
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const daysLeft = (Date.parse(expires) - Date.now()) / DAY_MS
    expect(daysLeft, `security.txt expires ${expires}: renew it (one year from today)`).toBeGreaterThanOrEqual(30)
  })

  it('the proxy does not run on it', () => {
    for (const pattern of proxyConfig.matcher) {
      expect(pattern.startsWith('/.well-known') || pattern === '/:path*' || pattern === '/(.*)', pattern).toBe(false)
    }
  })
})
