// @vitest-environment node
/**
 * [fix/user-ip-privacy] Guard: the raw client IP has exactly one reader.
 *
 * `trustedClientIp` (trusted-ip.ts) is the only code that reads the forwarding headers, and
 * `clientIpKey` (client-ip-key.ts) is the only code that calls it — it returns HMAC(IP, daily salt).
 * So no route can put a raw address in a rate-limit key, a log line or a stored row by accident:
 * there is no raw address for it to hold.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p)
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [p] : []
  })
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const sources = walk(SRC).map((p) => ({ rel: relative(SRC, p), code: stripComments(readFileSync(p, 'utf8')) }))

const FORWARDING_HEADER = /['"`](x-forwarded-for|x-real-ip|x-vercel-forwarded-for|cf-connecting-ip|true-client-ip|x-client-ip)['"`]/i

describe('the raw client IP has one reader', () => {
  it('scans the real source tree', () => {
    expect(sources.length).toBeGreaterThan(300)
    expect(sources.some((f) => f.rel === 'lib/trusted-ip.ts' && FORWARDING_HEADER.test(f.code))).toBe(true)
  })

  it('only trusted-ip.ts reads a forwarding header (no route parses x-forwarded-for itself)', () => {
    const offenders = sources.filter((f) => f.rel !== 'lib/trusted-ip.ts' && FORWARDING_HEADER.test(f.code)).map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('only client-ip-key.ts calls trustedClientIp()', () => {
    const callers = sources.filter((f) => /\btrustedClientIp\s*\(/.test(f.code) && f.rel !== 'lib/trusted-ip.ts').map((f) => f.rel)
    expect(callers).toEqual(['lib/client-ip-key.ts'])
  })

  it('every API route that rate-limits per client takes its bucket from clientIpKey / clientIp', () => {
    const routes = sources.filter((f) => f.rel.startsWith('app/api/') && /\bcheckRateLimit(?:Within)?\s*\(/.test(f.code))
    // [fix/privacy-leftovers-a78b] Both limiter names: moving a route to the bounded checkRateLimitWithin must not take it out of this guard.
    expect(routes.length).toBeGreaterThan(15)
    // A per-client key is one built from an `ip`-named value or the helpers; a key built from a wallet or an API-key hash is not.
    const perClient = routes.filter((f) => /\b(clientIpKey|clientIp)\s*\(|\$\{\s*(ip|postIp)\s*\}/.test(f.code))
    expect(perClient.length).toBeGreaterThan(10)
    const withoutHelper = perClient.filter((f) => !/\b(clientIpKey|clientIp)\s*\(\s*req\s*\)/.test(f.code)).map((f) => f.rel)
    expect(withoutHelper).toEqual([])
  })

  it('body-limit.ts `clientIp` is the hash, not the address', () => {
    const body = sources.find((f) => f.rel === 'lib/body-limit.ts')!.code
    expect(body).toMatch(/export function clientIp\(req: Request\): string \{\s*return clientIpKey\(req\)\s*\}/)
  })
})
