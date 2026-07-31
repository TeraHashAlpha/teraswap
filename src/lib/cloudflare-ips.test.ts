/**
 * [FIX-CLIENT-IP-CLOUDFLARE-AWARE] cloudflare-ips — the trust gate for `CF-Connecting-IP`.
 *
 * `isCloudflareIp` decides whether a request really arrived via Cloudflare. Everything downstream
 * of it (every per-IP rate-limit bucket) depends on it being tight in BOTH directions: a false
 * positive lets a direct-to-origin attacker nominate their own client IP; a false negative merely
 * degrades to the pre-fix behaviour. `isValidIp` is the second half of the gate — it keeps an
 * arbitrary header string out of the Redis rate-limit key (the P3a poisoning class).
 */
import { describe, it, expect } from 'vitest'
import {
  isCloudflareIp,
  isValidIp,
  CLOUDFLARE_IPV4_CIDRS,
  CLOUDFLARE_IPV6_CIDRS,
  _internal,
} from './cloudflare-ips'

describe('published ranges — provenance integrity', () => {
  it('carries the full published set (15 IPv4 + 7 IPv6 as of 2026-07-24)', () => {
    expect(CLOUDFLARE_IPV4_CIDRS).toHaveLength(15)
    expect(CLOUDFLARE_IPV6_CIDRS).toHaveLength(7)
  })

  it('EVERY published CIDR parses — a typo shrinks the trusted set, so it must fail here not silently', () => {
    expect(_internal.CLOUDFLARE_IPV4_RANGES.filter((r) => r === null)).toEqual([])
    expect(_internal.CLOUDFLARE_IPV6_RANGES.filter((r) => r === null)).toEqual([])
  })

  it('every entry is well-formed CIDR notation with a sane prefix', () => {
    for (const c of CLOUDFLARE_IPV4_CIDRS) expect(c).toMatch(/^(\d{1,3}\.){3}\d{1,3}\/([1-9]|[12]\d|3[0-2])$/)
    for (const c of CLOUDFLARE_IPV6_CIDRS) expect(c).toMatch(/^[0-9a-f:]+\/(\d{1,3})$/)
  })

  it('no range is a /0 — a wildcard would trust the entire internet', () => {
    for (const r of _internal.CLOUDFLARE_IPV4_RANGES) expect(r?.mask).not.toBe(0)
    for (const r of _internal.CLOUDFLARE_IPV6_RANGES) expect(r?.prefix).toBeGreaterThan(0)
  })
})

describe('isCloudflareIp — IPv4', () => {
  it('matches addresses inside published ranges', () => {
    // One probe per range family, at boundaries and interiors.
    expect(isCloudflareIp('173.245.48.0')).toBe(true)      // 173.245.48.0/20 — network address
    expect(isCloudflareIp('173.245.63.255')).toBe(true)    // …/20 — broadcast address
    expect(isCloudflareIp('104.16.0.1')).toBe(true)        // 104.16.0.0/13
    expect(isCloudflareIp('104.24.5.5')).toBe(true)        // 104.24.0.0/14 (nested in /13 upstream)
    expect(isCloudflareIp('172.64.128.9')).toBe(true)      // 172.64.0.0/13
    expect(isCloudflareIp('162.158.255.254')).toBe(true)   // 162.158.0.0/15
    expect(isCloudflareIp('131.0.72.1')).toBe(true)        // 131.0.72.0/22
    expect(isCloudflareIp('198.41.128.0')).toBe(true)      // 198.41.128.0/17
  })

  it('rejects addresses just OUTSIDE a range boundary (off-by-one in the mask would show here)', () => {
    expect(isCloudflareIp('173.245.47.255')).toBe(false)   // one below 173.245.48.0/20
    expect(isCloudflareIp('173.245.64.0')).toBe(false)     // one above the /20
    expect(isCloudflareIp('131.0.71.255')).toBe(false)     // one below 131.0.72.0/22
    expect(isCloudflareIp('131.0.76.0')).toBe(false)       // one above the /22
    expect(isCloudflareIp('162.157.255.255')).toBe(false)  // one below 162.158.0.0/15
    expect(isCloudflareIp('162.160.0.0')).toBe(false)      // one above the /15
  })

  it('rejects ordinary public and private addresses', () => {
    for (const ip of ['203.0.113.9', '8.8.8.8', '1.1.1.1', '10.0.0.1', '192.168.1.1', '127.0.0.1']) {
      expect(isCloudflareIp(ip)).toBe(false)
    }
  })

  it('rejects 1.1.1.1 specifically — Cloudflare RUNS it, but it is not an edge range', () => {
    // A tempting thing to "helpfully" add. It is not in the published set, so it must not match.
    expect(isCloudflareIp('1.1.1.1')).toBe(false)
  })
})

describe('isCloudflareIp — IPv6', () => {
  it('matches addresses inside published ranges, in compressed and expanded form', () => {
    expect(isCloudflareIp('2400:cb00::1')).toBe(true)
    expect(isCloudflareIp('2400:cb00:0:0:0:0:0:1')).toBe(true)
    expect(isCloudflareIp('2606:4700:3033::ac43:a01f')).toBe(true)
    expect(isCloudflareIp('2803:f800::abcd')).toBe(true)
    expect(isCloudflareIp('2c0f:f248::1')).toBe(true)
  })

  it('honours the /29 boundary of 2a06:98c0::/29 (a group-straddling prefix)', () => {
    expect(isCloudflareIp('2a06:98c0::1')).toBe(true)
    expect(isCloudflareIp('2a06:98c7:ffff::1')).toBe(true)  // last address covered by the /29
    expect(isCloudflareIp('2a06:98c8::1')).toBe(false)      // first address beyond it
    expect(isCloudflareIp('2a06:98bf::1')).toBe(false)      // just below it
  })

  it('rejects unrelated IPv6 addresses', () => {
    for (const ip of ['2001:db8::1', '::1', 'fe80::1', '2607:f8b0:4004::200e']) {
      expect(isCloudflareIp(ip)).toBe(false)
    }
  })

  it('treats an IPv4-mapped IPv6 peer as its embedded IPv4', () => {
    expect(isCloudflareIp('::ffff:172.64.0.1')).toBe(true)      // CF edge, v4-mapped
    expect(isCloudflareIp('::ffff:203.0.113.9')).toBe(false)    // non-CF, v4-mapped
  })
})

describe('isCloudflareIp — malformed input fails CLOSED (never a wildcard match)', () => {
  it('returns false for garbage, empty, and non-string input', () => {
    const garbage = [
      '', '   ', 'unknown', 'not-an-ip', 'localhost', 'teraswap.app',
      '999.999.999.999', '104.16.0', '104.16.0.1.2', '104.16.0.-1',
      '104.16.0.1/13',              // CIDR notation is not an address
      '104.16.0.1:443',             // host:port
      '2400:cb00::1%eth0',          // zone id
      '2400::cb00::1',              // two '::'
      '2400:cb00:0:0:0:0:0:0:1',    // nine groups
      'GGGG::1',
      '*', '../../etc/passwd', 'ratelimit:quote:*',
    ]
    for (const value of garbage) expect(isCloudflareIp(value)).toBe(false)
    expect(isCloudflareIp(undefined as unknown as string)).toBe(false)
    expect(isCloudflareIp(null as unknown as string)).toBe(false)
  })

  it('rejects leading-zero octets rather than guessing octal vs decimal', () => {
    // '0104.016.000.001' could be read as octal by another parser; refuse rather than disagree.
    expect(isCloudflareIp('0104.16.0.1')).toBe(false)
    expect(_internal.parseIpv4('010.0.0.1')).toBeNull()
  })

  it('is whitespace-STRICT — callers trim; a padded value reads as not-Cloudflare (fails closed)', () => {
    expect(isCloudflareIp('  172.64.0.1  ')).toBe(false)
    expect(isCloudflareIp('172.64.0.1')).toBe(true)
  })
})

describe('isValidIp — the gate that keeps arbitrary strings out of the Redis key', () => {
  it('accepts well-formed IPv4 and IPv6', () => {
    for (const ip of ['203.0.113.9', '0.0.0.0', '255.255.255.255', '::1', '2001:db8::1', '::ffff:1.2.3.4']) {
      expect(isValidIp(ip)).toBe(true)
    }
  })

  it('REJECTS everything that is not an address — the P3a poisoning class', () => {
    const poison = [
      '', '   ', 'unknown', 'victim-spoof-attempt',
      'ratelimit:quote:*',          // a key-shaped injection
      '1.2.3.4, 5.6.7.8',           // a whole header value, not one address
      '1.2.3.4:8080', '1.2.3.4/24',
      'a'.repeat(4096),             // unbounded string into a key
      'localhost', '::1%eth0',
    ]
    for (const value of poison) expect(isValidIp(value)).toBe(false)
    expect(isValidIp(undefined as unknown as string)).toBe(false)
  })

  it('REJECTS a CRLF-padded address — a true answer must mean "safe to use verbatim in a key"', () => {
    // If isValidIp trimmed internally it would bless these, and a caller using the ORIGINAL string
    // would smuggle a newline into `ratelimit:<route>:<ip>`. Strictness is the contract.
    for (const value of ['\n1.2.3.4', '1.2.3.4\r\n', ' 1.2.3.4', '1.2.3.4 ', '\t2001:db8::1']) {
      expect(isValidIp(value)).toBe(false)
    }
    expect(isValidIp('1.2.3.4')).toBe(true)
  })

  it('accepts a CF edge address (isValidIp and isCloudflareIp agree on well-formedness)', () => {
    expect(isValidIp('172.64.0.1')).toBe(true)
    expect(isValidIp('2400:cb00::1')).toBe(true)
  })
})
