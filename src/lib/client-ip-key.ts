/**
 * [fix/user-ip-privacy] The only form in which a client IP leaves `trustedClientIp`: a keyed hash.
 *
 * WHY. Every per-IP limiter used the raw address as its bucket name — `ratelimit:rpc:203.0.113.7` in
 * Upstash — and when Redis was unreachable the in-memory fallback printed that key, raw IP included,
 * to the function logs on every request. Neither place needs the address itself; both only need "the
 * same client gets the same bucket". So the address is replaced, at the one point every limiter goes
 * through, by `HMAC-SHA256(daily salt, ip)`.
 *
 * THE SALT.
 *  - `RATE_LIMIT_SALT` (server env, any random string of 32+ characters) is the secret. The key used
 *    on a given UTC day is `HMAC(RATE_LIMIT_SALT, "teraswap-rate-limit-ip:" + YYYY-MM-DD)`, so the
 *    same IP hashes differently every day and yesterday's hashes cannot be linked to today's.
 *  - If `RATE_LIMIT_SALT` is not set, a random 32-byte salt is generated once per process. Hashes
 *    are then still irreversible, but DIFFERENT function instances disagree about the bucket name
 *    for the same client, so a limit is enforced per instance rather than across the fleet. That is
 *    a weaker rate limit, not a privacy problem — and it is why production must set the variable.
 *    One warning per process names the missing variable (never a value).
 *
 * WHAT COMES OUT. 32 hex characters (128 bits of the MAC): safe as a Redis key segment and as a log
 * token, with no control characters, no separators and nothing a caller chose.
 *
 * DAY BOUNDARY. At 00:00 UTC every bucket name changes, so a client's sliding window restarts once a
 * day (at most one extra window of requests in the minute, or the hour, that straddles midnight).
 *
 * IPv6: ONE BUCKET PER /64. [fix/user-ip-privacy A76 S-4] A /64 is the smallest block an ISP assigns to one
 * subscriber, and every address in it is that subscriber's to use (SLAAC privacy addresses rotate inside it). Keying
 * by the full address gave one client 2^64 buckets — the audit got 300/min from each of three addresses of one /64.
 * So an IPv6 client is keyed by its /64 prefix (`2001:db8:1:2::/64`), an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)
 * by the IPv4 address it carries, and IPv4 by the address. See {@link rateLimitSubject}.
 *
 * Server-only (node:crypto). Imported by API routes and body-limit.ts; never by client code.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { trustedClientIp } from './trusted-ip'

/** Name of the server env var holding the secret. */
export const RATE_LIMIT_SALT_ENV = 'RATE_LIMIT_SALT'
/** Shorter than this is treated as unset: a guessable salt lets the small IPv4 space be enumerated. */
export const RATE_LIMIT_SALT_MIN_LENGTH = 32
/** Hex characters kept from the MAC. */
export const CLIENT_IP_KEY_LENGTH = 32

const DAY_INFO_PREFIX = 'teraswap-rate-limit-ip:'

/** Per-process fallback secret, created on first use. */
let processSalt: Buffer | null = null
let warnedMissingSalt = false
let cachedDay: { day: string; secret: string | Buffer; key: Buffer } | null = null

/** The configured secret, or the per-process random one (with a one-time warning). */
function baseSecret(): string | Buffer {
  const configured = process.env.RATE_LIMIT_SALT
  if (typeof configured === 'string' && configured.length >= RATE_LIMIT_SALT_MIN_LENGTH) return configured
  if (!warnedMissingSalt) {
    warnedMissingSalt = true
    console.warn(
      `[RATE-LIMIT] ${RATE_LIMIT_SALT_ENV} is not set (or shorter than ${RATE_LIMIT_SALT_MIN_LENGTH} characters): ` +
        'client-IP hashes use a per-process random salt, so per-IP limits are enforced per instance, not across instances.',
    )
  }
  processSalt ??= randomBytes(32)
  return processSalt
}

/** `YYYY-MM-DD` in UTC. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** The HMAC key for the UTC day containing `now` (derived once per day per process). */
function dailyKey(now: number): Buffer {
  const day = utcDay(now)
  const secret = baseSecret()
  if (cachedDay && cachedDay.day === day && cachedDay.secret === secret) return cachedDay.key
  const key = createHmac('sha256', secret).update(`${DAY_INFO_PREFIX}${day}`).digest()
  cachedDay = { day, secret, key }
  return key
}

/** Keyed hash of an IP (or of the `'unknown'` placeholder) for the UTC day containing `now`. */
export function hashClientIp(ip: string, now: number = Date.now()): string {
  return createHmac('sha256', dailyKey(now)).update(ip).digest('hex').slice(0, CLIENT_IP_KEY_LENGTH)
}

/**
 * [A76 S-4] What a client is keyed by: an IPv4 address as-is; an IPv6 address as its /64 prefix, canonical
 * (lower-case, no leading zeros, `::/64`), so every spelling and every interface id of one /64 is one subject; an
 * IPv4-mapped IPv6 address as the IPv4 it carries. A zone id (`%eth0`) or brackets are ignored. Anything that is
 * not an IP (`'unknown'`, a malformed header) is returned unchanged — it is hashed like before.
 */
export function rateLimitSubject(ip: string): string {
  const bare = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (isIP(bare) !== 6) return ip
  // Expand to 8 hextets (numbers): an embedded dotted quad at the end counts as two.
  const hexOnly = bare.replace(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, (_m, a, b, c, d) =>
    `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`,
  )
  const [head, tail] = hexOnly.split('::') as [string, string | undefined]
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const parts = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  const h = parts.map((x) => parseInt(x, 16))
  // ::ffff:a.b.c.d (in either spelling) is an IPv4 client: key it exactly as that IPv4 address.
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join('.')
  return `${h.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}

/**
 * The per-client bucket name for rate-limit keys and log lines: the hash of the TRUSTED client IP
 * (see trusted-ip.ts for how that is established) — of its /64 for IPv6 ({@link rateLimitSubject}). Use this —
 * never `trustedClientIp` — anywhere a value is stored, keyed or logged.
 */
export function clientIpKey(req: Request, now: number = Date.now()): string {
  return hashClientIp(rateLimitSubject(trustedClientIp(req)), now)
}

/** Test-only: forget the per-process salt, the cached daily key and the warning latch. */
export function __resetClientIpKey(): void {
  processSalt = null
  warnedMissingSalt = false
  cachedDay = null
}
