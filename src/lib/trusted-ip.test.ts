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

/**
 * [FIX-CLIENT-IP-CLOUDFLARE-AWARE] teraswap.app sits behind Cloudflare, so the peer connecting to
 * Vercel is a CF EDGE and every per-IP limiter was bucketing by edge, not by client. CF-Connecting-IP
 * carries the real client, but is only trusted behind a two-part gate:
 *
 *     peer ∈ Cloudflare's published ranges  AND  CF-Connecting-IP parses as an IP
 *
 * Fail either half and we fall through to the pre-existing P3a chain, unchanged.
 */
const CF_EDGE_V4 = '172.64.0.1'      // inside 172.64.0.0/13
const CF_EDGE_V6 = '2400:cb00::1'    // inside 2400:cb00::/32
const REAL_CLIENT = '203.0.113.9'

describe('trustedClientIp — Cloudflare path (peer IS a CF edge)', () => {
  it('returns the REAL client from cf-connecting-ip instead of the CF edge', () => {
    expect(
      trustedClientIp(req({ 'x-vercel-forwarded-for': CF_EDGE_V4, 'cf-connecting-ip': REAL_CLIENT })),
    ).toBe(REAL_CLIENT)
  })

  it('is what un-shares the rate-limit bucket: two clients behind ONE edge get distinct keys', () => {
    const a = trustedClientIp(req({ 'x-vercel-forwarded-for': CF_EDGE_V4, 'cf-connecting-ip': '198.51.100.1' }))
    const b = trustedClientIp(req({ 'x-vercel-forwarded-for': CF_EDGE_V4, 'cf-connecting-ip': '198.51.100.2' }))
    expect(a).not.toBe(b)
    expect([a, b]).not.toContain(CF_EDGE_V4)
  })

  it('the header name is matched case-insensitively (CF sends CF-Connecting-IP)', () => {
    expect(
      trustedClientIp(req({ 'X-Vercel-Forwarded-For': CF_EDGE_V4, 'CF-Connecting-IP': REAL_CLIENT })),
    ).toBe(REAL_CLIENT)
  })

  it('works for an IPv6 CF edge, and for an IPv6 real client', () => {
    expect(
      trustedClientIp(req({ 'x-vercel-forwarded-for': CF_EDGE_V6, 'cf-connecting-ip': REAL_CLIENT })),
    ).toBe(REAL_CLIENT)
    expect(
      trustedClientIp(req({ 'x-vercel-forwarded-for': CF_EDGE_V4, 'cf-connecting-ip': '2001:db8::1' })),
    ).toBe('2001:db8::1')
  })

  it('also gates on a CF edge seen via x-real-ip (the non-Vercel peer header)', () => {
    expect(trustedClientIp(req({ 'x-real-ip': CF_EDGE_V4, 'cf-connecting-ip': REAL_CLIENT }))).toBe(REAL_CLIENT)
  })

  it('takes the FIRST x-vercel-forwarded-for token as the peer, as the pre-fix chain did', () => {
    expect(
      trustedClientIp(req({ 'x-vercel-forwarded-for': `${CF_EDGE_V4}, 10.0.0.1`, 'cf-connecting-ip': REAL_CLIENT })),
    ).toBe(REAL_CLIENT)
  })

  it('a spoofed x-forwarded-for still cannot win on the CF path either', () => {
    const ip = trustedClientIp(
      req({ 'x-vercel-forwarded-for': CF_EDGE_V4, 'cf-connecting-ip': REAL_CLIENT, 'x-forwarded-for': '6.6.6.6' }),
    )
    expect(ip).toBe(REAL_CLIENT)
    expect(ip).not.toBe('6.6.6.6')
  })
})

describe('trustedClientIp — ADVERSARIAL: the CF-trust gate', () => {
  it('IGNORES cf-connecting-ip when the peer is NOT a Cloudflare IP (direct-to-Vercel attacker)', () => {
    // The whole point of the gate. An attacker who bypasses Cloudflare and hits the origin
    // directly sets cf-connecting-ip themselves; they must get their OWN IP, not their choice.
    const attackerPeer = '198.51.100.66'
    const ip = trustedClientIp(
      req({ 'x-vercel-forwarded-for': attackerPeer, 'cf-connecting-ip': '1.2.3.4' }),
    )
    expect(ip).toBe(attackerPeer)
    expect(ip).not.toBe('1.2.3.4')
  })

  it('cannot be used to exhaust a VICTIM bucket from outside Cloudflare', () => {
    const victim = '203.0.113.77'
    const ip = trustedClientIp(req({ 'x-vercel-forwarded-for': '8.8.8.8', 'cf-connecting-ip': victim }))
    expect(ip).not.toBe(victim)
    expect(ip).toBe('8.8.8.8')
  })

  it('cannot be used to evade a limit by rotating cf-connecting-ip from outside Cloudflare', () => {
    const keys = ['1.1.1.1', '2.2.2.2', '3.3.3.3'].map((forged) =>
      trustedClientIp(req({ 'x-vercel-forwarded-for': '198.51.100.66', 'cf-connecting-ip': forged })),
    )
    expect(new Set(keys).size).toBe(1) // all collapse to the one real peer → one bucket
    expect(keys[0]).toBe('198.51.100.66')
  })

  it('IGNORES a malformed cf-connecting-ip even from a genuine CF edge (no Redis-key poisoning)', () => {
    for (const poison of ['ratelimit:quote:*', 'victim-spoof-attempt', '999.999.999.999', '1.2.3.4, 5.6.7.8', '   ']) {
      const ip = trustedClientIp(req({ 'x-vercel-forwarded-for': CF_EDGE_V4, 'cf-connecting-ip': poison }))
      expect(ip).toBe(CF_EDGE_V4) // falls back to the peer, never the garbage
      expect(ip).not.toBe(poison)
    }
  })

  it('an unbounded cf-connecting-ip string never reaches the key', () => {
    const huge = 'a'.repeat(8192)
    expect(trustedClientIp(req({ 'x-vercel-forwarded-for': CF_EDGE_V4, 'cf-connecting-ip': huge }))).toBe(CF_EDGE_V4)
  })

  it('a CF edge with NO cf-connecting-ip falls back to the edge (degraded, never wrong)', () => {
    expect(trustedClientIp(req({ 'x-vercel-forwarded-for': CF_EDGE_V4 }))).toBe(CF_EDGE_V4)
  })

  it('cf-connecting-ip alone, with no platform peer header, is NOT trusted', () => {
    // No peer ⇒ the gate cannot be satisfied ⇒ the existing chain runs (right-most XFF, else unknown).
    expect(trustedClientIp(req({ 'cf-connecting-ip': REAL_CLIENT }))).toBe('unknown')
    expect(trustedClientIp(req({ 'cf-connecting-ip': REAL_CLIENT, 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe(
      '10.0.0.1',
    )
  })
})

describe('trustedClientIp — the no-Cloudflare path is byte-identical to pre-fix', () => {
  // Same inputs as the original suite above, asserted again with cf-connecting-ip ABSENT, to pin
  // that adding the CF branch changed nothing for a request that never touched Cloudflare.
  const cases: Array<[Record<string, string>, string]> = [
    [{ 'x-vercel-forwarded-for': '203.0.113.9', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, '203.0.113.9'],
    [{ 'x-vercel-forwarded-for': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' }, '203.0.113.9'],
    [{ 'x-real-ip': '198.51.100.7' }, '198.51.100.7'],
    [{ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.9' }, '203.0.113.9'],
    [{ 'x-forwarded-for': 'victim-spoof-attempt, 10.0.0.1' }, '10.0.0.1'],
    [{}, 'unknown'],
    [{ 'x-forwarded-for': ' 1.2.3.4 ,  9.9.9.9  ' }, '9.9.9.9'],
    [{ 'x-forwarded-for': '' }, 'unknown'],
  ]

  it.each(cases)('headers %j → %s', (headers, expected) => {
    expect(trustedClientIp(req(headers))).toBe(expected)
  })

  it('an empty first x-vercel-forwarded-for token still falls through to x-real-ip', () => {
    expect(trustedClientIp(req({ 'x-vercel-forwarded-for': ', 1.2.3.4', 'x-real-ip': '198.51.100.7' }))).toBe(
      '198.51.100.7',
    )
  })

  it('a non-CF peer never consults cf-connecting-ip, so the result equals the pre-fix chain exactly', () => {
    for (const [headers, expected] of cases) {
      expect(trustedClientIp(req({ ...headers, 'cf-connecting-ip': '9.9.9.9' }))).toBe(expected)
    }
  })
})
