/**
 * [CHORE-API-HARDENING-2 / P3a CONFIRMED] trustedClientIp — every per-IP rate
 * limiter in this repo took the LEFT-MOST X-Forwarded-For token, which a client
 * can prepend to on Vercel (the platform APPENDS the true IP as the LAST entry).
 * This let an attacker (a) bypass every per-IP limit with a fresh random
 * left-most token per request, (b) exhaust a victim's bucket by spoofing their
 * IP as the left-most token, (c) spray arbitrary strings into the Redis
 * rate-limit key. Fix: prefer x-vercel-forwarded-for (platform-set, client
 * cannot inject/override it), then x-real-ip, then the RIGHT-most XFF entry.
 */
import { describe, it, expect } from 'vitest'
import { trustedClientIp } from './trusted-ip'

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/anything', { headers })
}

describe('trustedClientIp', () => {
  it('prefers x-vercel-forwarded-for (the platform-set, unspoofable header)', () => {
    expect(
      trustedClientIp(
        req({ 'x-vercel-forwarded-for': '203.0.113.9', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }),
      ),
    ).toBe('203.0.113.9')
  })

  it('ADVERSARIAL: a spoofed left-most x-forwarded-for is IGNORED when x-vercel-forwarded-for is present', () => {
    // Attacker prepends an arbitrary IP; the trusted header must win regardless.
    const ip = trustedClientIp(
      req({ 'x-vercel-forwarded-for': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' }),
    )
    expect(ip).toBe('203.0.113.9')
    expect(ip).not.toBe('1.2.3.4')
  })

  it('falls back to x-real-ip when x-vercel-forwarded-for is absent', () => {
    expect(trustedClientIp(req({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7')
  })

  it('falls back to the RIGHT-most x-forwarded-for entry (nearest trusted hop), not the left-most', () => {
    expect(trustedClientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('ADVERSARIAL: an attacker-prepended fake IP cannot masquerade as the client without x-vercel-forwarded-for', () => {
    // Only x-forwarded-for present (e.g. non-Vercel/local): the client-controlled
    // left-most entry must NOT be trusted; the right-most (proxy-appended) wins.
    const ip = trustedClientIp(req({ 'x-forwarded-for': 'victim-spoof-attempt, 10.0.0.1' }))
    expect(ip).toBe('10.0.0.1')
  })

  it('returns "unknown" when no IP header is present at all', () => {
    expect(trustedClientIp(req({}))).toBe('unknown')
  })

  it('trims whitespace around forwarded-for entries', () => {
    expect(trustedClientIp(req({ 'x-forwarded-for': ' 1.2.3.4 ,  9.9.9.9  ' }))).toBe('9.9.9.9')
  })

  it('ignores an empty x-forwarded-for value and falls back to unknown', () => {
    expect(trustedClientIp(req({ 'x-forwarded-for': '' }))).toBe('unknown')
  })
})
