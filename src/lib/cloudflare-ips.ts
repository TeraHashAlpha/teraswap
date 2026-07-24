/**
 * [FIX-CLIENT-IP-CLOUDFLARE-AWARE] Cloudflare edge-IP membership + IP validation.
 *
 * teraswap.app is proxied through Cloudflare, so the peer that connects to Vercel is a CF EDGE,
 * not the real client. `CF-Connecting-IP` carries the real client — but only a request that
 * actually came through Cloudflare may be believed: CF overwrites that header at its edge, while
 * anyone hitting the Vercel origin directly can set it to whatever they like. This module answers
 * the one question that gates that trust: **is the connecting peer a Cloudflare edge?**
 *
 * It also exports `isValidIp`, which lives here rather than in a third module because it reuses
 * these same strict parsers — `trusted-ip.ts` must never put an unvalidated header value into a
 * Redis rate-limit key (the P3a key-poisoning class).
 *
 * ── PROVENANCE ──────────────────────────────────────────────────────────────────────────────
 * The CIDR lists below are Cloudflare's PUBLISHED set, copied verbatim from:
 *   https://www.cloudflare.com/ips-v4   (15 ranges)
 *   https://www.cloudflare.com/ips-v6   (7 ranges)
 * Fetched 2026-07-24 (both HTTP 200). Nothing here is inferred or hand-derived.
 *
 * ⚠️ REFRESH PERIODICALLY. Cloudflare adds ranges over time. A range we are missing FAILS SAFE —
 * `isCloudflareIp` returns false, the CF branch is skipped, and `trustedClientIp` falls back to
 * exactly today's pre-fix behaviour (bucketing by the CF edge). Traffic is never dropped and no
 * spoofed header is ever trusted; the only cost is that clients behind that new edge share one
 * rate-limit bucket until the list is updated. Re-copy both URLs when Cloudflare announces a
 * change, or on a routine cadence.
 */

/** Cloudflare IPv4 edge ranges — verbatim from https://www.cloudflare.com/ips-v4 (2026-07-24). */
export const CLOUDFLARE_IPV4_CIDRS: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]

/** Cloudflare IPv6 edge ranges — verbatim from https://www.cloudflare.com/ips-v6 (2026-07-24). */
export const CLOUDFLARE_IPV6_CIDRS: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]

// ── Parsing ───────────────────────────────────────────────────────────────────────────────────
// Deliberately STRICT: anything we cannot parse unambiguously returns null, which makes every
// caller fail closed (not a CF IP / not a valid IP). A lenient parser is a liability here — the
// output of `isValidIp` becomes part of a Redis key, and a parser that disagrees with the one
// upstream is how IP-based allow/deny checks get bypassed.

/**
 * Dotted-quad IPv4 → unsigned 32-bit integer, or null.
 * Rejects leading zeros (`010.0.0.1`), which some parsers read as octal and others as decimal —
 * an ambiguity we refuse rather than pick a side on.
 */
function parseIpv4(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null

  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part.startsWith('0')) return null
    const n = Number(part)
    if (n > 255) return null
    out = out * 256 + n
  }
  return out >>> 0
}

/**
 * IPv6 → eight 16-bit groups, or null. Handles `::` compression (at most one) and a trailing
 * embedded IPv4 (`::ffff:192.0.2.1`). Zone ids (`%eth0`) are refused outright.
 */
function parseIpv6(value: string): number[] | null {
  if (value.includes('%')) return null

  const dc = value.indexOf('::')
  if (dc !== value.lastIndexOf('::')) return null // more than one '::' is ambiguous

  const headStr = dc === -1 ? value : value.slice(0, dc)
  const tailStr = dc === -1 ? '' : value.slice(dc + 2)

  // An embedded IPv4 may only be the FINAL component of the whole address.
  const toGroups = (parts: string[], allowTrailingIpv4: boolean): number[] | null => {
    const out: number[] = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (allowTrailingIpv4 && i === parts.length - 1 && part.includes('.')) {
        const v4 = parseIpv4(part)
        if (v4 === null) return null
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff)
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
      out.push(parseInt(part, 16))
    }
    return out
  }

  const head = toGroups(headStr === '' ? [] : headStr.split(':'), dc === -1)
  const tail = toGroups(tailStr === '' ? [] : tailStr.split(':'), true)
  if (head === null || tail === null) return null

  if (dc === -1) return head.length === 8 ? head : null

  const elided = 8 - head.length - tail.length
  if (elided < 1) return null // '::' must stand for at least one group
  return [...head, ...new Array<number>(elided).fill(0), ...tail]
}

/** `::ffff:a.b.c.d` → the embedded IPv4 as a uint32, else null. */
function ipv4Mapped(groups: number[]): number | null {
  for (let i = 0; i < 5; i++) if (groups[i] !== 0) return null
  if (groups[5] !== 0xffff) return null
  return ((groups[6] << 16) | groups[7]) >>> 0
}

// ── Pre-parsed ranges ─────────────────────────────────────────────────────────────────────────
// Parsed once at module load rather than per request. A malformed entry becomes `null` and is
// SKIPPED at match time (never a wildcard) — and `cloudflare-ips.test.ts` asserts there are none,
// so a typo fails CI instead of silently shrinking the trusted set.

interface Ipv4Range { base: number; mask: number }
interface Ipv6Range { base: number[]; prefix: number }

function parseIpv4Cidr(cidr: string): Ipv4Range | null {
  const [base, prefixStr] = cidr.split('/')
  const baseNum = parseIpv4(base ?? '')
  const prefix = Number(prefixStr)
  if (baseNum === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  // A /0 would trust the entire internet; `~0 << 32` is a no-op in JS, so guard it explicitly.
  if (prefix === 0) return null
  const mask = (~0 << (32 - prefix)) >>> 0
  return { base: (baseNum & mask) >>> 0, mask }
}

function parseIpv6Cidr(cidr: string): Ipv6Range | null {
  const [base, prefixStr] = cidr.split('/')
  const baseGroups = parseIpv6(base ?? '')
  const prefix = Number(prefixStr)
  if (baseGroups === null || !Number.isInteger(prefix) || prefix < 1 || prefix > 128) return null
  return { base: baseGroups, prefix }
}

const CLOUDFLARE_IPV4_RANGES = CLOUDFLARE_IPV4_CIDRS.map(parseIpv4Cidr)
const CLOUDFLARE_IPV6_RANGES = CLOUDFLARE_IPV6_CIDRS.map(parseIpv6Cidr)

function inIpv4Ranges(ip: number): boolean {
  return CLOUDFLARE_IPV4_RANGES.some((r) => r !== null && ((ip & r.mask) >>> 0) === r.base)
}

function inIpv6Ranges(groups: number[]): boolean {
  return CLOUDFLARE_IPV6_RANGES.some((r) => {
    if (r === null) return false
    let bitsLeft = r.prefix
    for (let i = 0; i < 8 && bitsLeft > 0; i++) {
      const take = Math.min(16, bitsLeft)
      const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff
      if ((groups[i] & mask) !== (r.base[i] & mask)) return false
      bitsLeft -= take
    }
    return true
  })
}

// ── Public API ────────────────────────────────────────────────────────────────────────────────

/**
 * Is `value` EXACTLY a well-formed IPv4 or IPv6 address?
 *
 * Used by `trusted-ip.ts` to refuse an arbitrary `CF-Connecting-IP` string before it can reach a
 * Redis rate-limit key. Rejects the empty string, hostnames, `ip:port`, CIDR notation, and any
 * other free text.
 *
 * STRICT about surrounding whitespace — deliberately. The contract must be "a true answer means
 * this exact string is safe to use verbatim", otherwise a caller that validates a value and then
 * uses the untrimmed original would smuggle `\r\n` into a key. Callers trim first (trusted-ip.ts
 * does) rather than relying on this to do it for them.
 */
export function isValidIp(value: string): boolean {
  if (typeof value !== 'string' || value === '') return false
  return parseIpv4(value) !== null || parseIpv6(value) !== null
}

/**
 * Is `ip` inside Cloudflare's published edge ranges?
 *
 * This is the TRUST GATE for `CF-Connecting-IP`. It answers "did this request really arrive via
 * Cloudflare?" — false for every direct-to-origin connection, so a client that bypasses CF can
 * never nominate its own client IP. An IPv4-mapped IPv6 peer (`::ffff:172.64.0.1`) is matched
 * against the IPv4 ranges, since it denotes the same address.
 *
 * Whitespace-strict for the same reason as `isValidIp` (callers trim first); an unparseable peer
 * simply reads as "not Cloudflare", which fails closed onto the pre-Cloudflare chain.
 */
export function isCloudflareIp(ip: string): boolean {
  if (typeof ip !== 'string' || ip === '') return false
  const value = ip

  const v4 = parseIpv4(value)
  if (v4 !== null) return inIpv4Ranges(v4)

  const v6 = parseIpv6(value)
  if (v6 === null) return false

  const mapped = ipv4Mapped(v6)
  if (mapped !== null) return inIpv4Ranges(mapped)

  return inIpv6Ranges(v6)
}

// ── Test-only exports (mirrors the `_internal` convention in kv-rate-limiter.ts) ───────────────

/** Do NOT use from production code. */
export const _internal = {
  parseIpv4,
  parseIpv6,
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
}
