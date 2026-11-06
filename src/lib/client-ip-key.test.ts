// @vitest-environment node
/**
 * [fix/user-ip-privacy] HMAC(IP, daily salt) — the only form in which a client IP reaches a
 * rate-limit key or a log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetClientIpKey,
  CLIENT_IP_KEY_LENGTH,
  clientIpKey,
  hashClientIp,
  RATE_LIMIT_SALT_ENV,
  RATE_LIMIT_SALT_MIN_LENGTH,
} from './client-ip-key'

const SALT = 'unit-test-salt-0123456789abcdef-0123456789abcdef'
const DAY1 = Date.UTC(2026, 10, 6, 12, 0, 0)
const DAY2 = Date.UTC(2026, 10, 7, 12, 0, 0)
const IPS = ['203.0.113.7', '198.51.100.9', '10.0.0.1', '::1', '2001:db8::1', '::ffff:127.0.0.1', 'unknown']

const reqFrom = (headers: Record<string, string>) => new Request('http://localhost/api/x', { headers })

beforeEach(() => {
  __resetClientIpKey()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  __resetClientIpKey()
})

describe('hashClientIp — shape', () => {
  beforeEach(() => vi.stubEnv(RATE_LIMIT_SALT_ENV, SALT))

  it.each(IPS)('%s → 32 lowercase hex characters, never the address', (ip) => {
    const h = hashClientIp(ip, DAY1)
    expect(h).toMatch(/^[0-9a-f]{32}$/)
    expect(h).toHaveLength(CLIENT_IP_KEY_LENGTH)
    expect(h).not.toContain(ip)
  })

  it('is the documented construction: HMAC-SHA256(HMAC-SHA256(salt, prefix + UTC day), ip), first 32 hex', async () => {
    const { createHmac } = await import('node:crypto')
    const dayKey = createHmac('sha256', SALT).update('teraswap-rate-limit-ip:2026-11-06').digest()
    const expected = createHmac('sha256', dayKey).update('203.0.113.7').digest('hex').slice(0, 32)
    expect(hashClientIp('203.0.113.7', DAY1)).toBe(expected)
  })

  it('same IP, same day → same bucket; different IPs → different buckets', () => {
    expect(hashClientIp('203.0.113.7', DAY1)).toBe(hashClientIp('203.0.113.7', DAY1 + 3_600_000))
    expect(new Set(IPS.map((ip) => hashClientIp(ip, DAY1))).size).toBe(IPS.length)
  })

  it('a hostile "IP" (control characters, separators, a 10 kB string) still yields 32 hex characters', () => {
    for (const hostile of ['1.2.3.4\n[RATE-LIMIT] forged\r\x1b[31m', 'a:b:c', '../../etc/passwd', 'x'.repeat(10_000), '']) {
      expect(hashClientIp(hostile, DAY1)).toMatch(/^[0-9a-f]{32}$/)
    }
  })
})

describe('hashClientIp — DAILY salt', () => {
  beforeEach(() => vi.stubEnv(RATE_LIMIT_SALT_ENV, SALT))

  it('the same IP hashes differently on the next UTC day (yesterday cannot be linked to today)', () => {
    for (const ip of IPS) expect(hashClientIp(ip, DAY1)).not.toBe(hashClientIp(ip, DAY2))
  })

  it('the boundary is UTC midnight, to the millisecond', () => {
    const midnight = Date.UTC(2026, 10, 7, 0, 0, 0, 0)
    expect(hashClientIp('203.0.113.7', midnight - 1)).toBe(hashClientIp('203.0.113.7', DAY1))
    expect(hashClientIp('203.0.113.7', midnight)).toBe(hashClientIp('203.0.113.7', DAY2))
    expect(hashClientIp('203.0.113.7', midnight - 1)).not.toBe(hashClientIp('203.0.113.7', midnight))
  })

  it('going back to an earlier day gives that day’s value again (the cache is keyed by day, not "latest")', () => {
    const a = hashClientIp('203.0.113.7', DAY1)
    hashClientIp('203.0.113.7', DAY2)
    expect(hashClientIp('203.0.113.7', DAY1)).toBe(a)
  })
})

describe('salt source — RATE_LIMIT_SALT, else a per-process random salt', () => {
  it('with RATE_LIMIT_SALT set, two instances (fresh module copies) agree on the bucket', async () => {
    vi.stubEnv(RATE_LIMIT_SALT_ENV, SALT)
    vi.resetModules()
    const a = await import('./client-ip-key')
    vi.resetModules()
    const b = await import('./client-ip-key')
    expect(a).not.toBe(b)
    expect(a.hashClientIp('203.0.113.7', DAY1)).toBe(b.hashClientIp('203.0.113.7', DAY1))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('a different RATE_LIMIT_SALT gives a different hash (the value depends on the secret)', () => {
    vi.stubEnv(RATE_LIMIT_SALT_ENV, SALT)
    const first = hashClientIp('203.0.113.7', DAY1)
    __resetClientIpKey()
    vi.stubEnv(RATE_LIMIT_SALT_ENV, `${SALT}-rotated`)
    expect(hashClientIp('203.0.113.7', DAY1)).not.toBe(first)
  })

  it('without it: stable inside one process, different between two instances', async () => {
    vi.stubEnv(RATE_LIMIT_SALT_ENV, '')
    expect(hashClientIp('203.0.113.7', DAY1)).toBe(hashClientIp('203.0.113.7', DAY1))
    vi.resetModules()
    const a = await import('./client-ip-key')
    vi.resetModules()
    const b = await import('./client-ip-key')
    expect(a.hashClientIp('203.0.113.7', DAY1)).toMatch(/^[0-9a-f]{32}$/)
    expect(a.hashClientIp('203.0.113.7', DAY1)).not.toBe(b.hashClientIp('203.0.113.7', DAY1))
  })

  it('without it: warns ONCE per process, naming the variable and no value', () => {
    vi.stubEnv(RATE_LIMIT_SALT_ENV, '')
    for (let i = 0; i < 5; i++) hashClientIp(`10.0.0.${i}`, DAY1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    const line = String(vi.mocked(console.warn).mock.calls[0][0])
    expect(line).toContain(RATE_LIMIT_SALT_ENV)
    expect(line).not.toMatch(/10\.0\.0\.\d/)
  })

  it(`a salt shorter than ${RATE_LIMIT_SALT_MIN_LENGTH} characters is treated as unset (and never echoed)`, () => {
    vi.stubEnv(RATE_LIMIT_SALT_ENV, 'too-short')
    const weak = hashClientIp('203.0.113.7', DAY1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).not.toContain('too-short')
    // Not derived from the short value: a second process draws a different random salt.
    __resetClientIpKey()
    expect(hashClientIp('203.0.113.7', DAY1)).not.toBe(weak)
  })
})

describe('clientIpKey — hash of the TRUSTED client IP', () => {
  beforeEach(() => vi.stubEnv(RATE_LIMIT_SALT_ENV, SALT))

  it('uses the platform-set header, not the client-writable left-most x-forwarded-for token', () => {
    const key = clientIpKey(reqFrom({ 'x-vercel-forwarded-for': '198.51.100.9', 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }), DAY1)
    expect(key).toBe(hashClientIp('198.51.100.9', DAY1))
    expect(key).not.toBe(hashClientIp('6.6.6.6', DAY1))
  })

  it('a caller cannot move to a fresh bucket by rewriting x-forwarded-for', () => {
    const keys = ['1.1.1.1', '2.2.2.2', 'attacker-chosen', ''].map((spoof) =>
      clientIpKey(reqFrom({ 'x-vercel-forwarded-for': '198.51.100.9', 'x-forwarded-for': `${spoof}, 203.0.113.7` }), DAY1),
    )
    expect(new Set(keys).size).toBe(1)
  })

  it('no IP header at all → the hash of "unknown" (one shared bucket), still not the literal word', () => {
    const key = clientIpKey(reqFrom({}), DAY1)
    expect(key).toBe(hashClientIp('unknown', DAY1))
    expect(key).not.toContain('unknown')
  })
})
