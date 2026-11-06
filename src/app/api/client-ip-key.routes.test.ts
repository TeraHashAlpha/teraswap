// @vitest-environment node
/**
 * [fix/user-ip-privacy] What reaches Redis and the function logs when a route rate-limits a client.
 *
 * Runs the REAL limiter (kv-rate-limiter.ts) against a recording Redis stub, through real route
 * handlers, and asserts on the two places a raw IP used to land:
 *   - the Redis key (`ratelimit:<route>:<ip>` in Upstash), and
 *   - the `[RATE-LIMIT] … in-memory fallback for <key>` warning printed on every request while Redis
 *     is unreachable (the recon saw `token-logo:::1` in the logs).
 *
 * It also pins the four routes that still read the LEFT-MOST x-forwarded-for token themselves —
 * /api/portfolio/prices, /api/portfolio/tokens, /api/oracle-coverage, /api/admin/kill-switch — onto the
 * trusted-IP chain: a caller can no longer pick its own bucket by writing that header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const redis = vi.hoisted(() => ({ keys: [] as string[], fail: false }))
vi.mock('@/lib/kv', () => {
  const pipeline = () => {
    const p = {
      zremrangebyscore: (key: string) => (redis.keys.push(key), p),
      zcard: (key: string) => (redis.keys.push(key), p),
      zadd: (key: string) => (redis.keys.push(key), p),
      expire: (key: string) => (redis.keys.push(key), p),
      exec: async () => {
        if (redis.fail) throw new Error('KV unreachable')
        return [0, 0, 1, 1]
      },
      set: () => p,
      sadd: () => p,
    }
    return p
  }
  return { kv: { pipeline, zrem: async () => 0, zrange: async () => [], get: async () => null, set: async () => 'OK' } }
})

import { hashClientIp } from '@/lib/client-ip-key'
import { _internal as limiter } from '@/lib/kv-rate-limiter'
import { GET as portfolioPrices } from './portfolio/prices/route'
import { GET as portfolioTokens } from './portfolio/tokens/route'
import { GET as oracleCoverage } from './oracle-coverage/route'
import { GET as tokenLogo } from './token-logo/route'
import { POST as rpc } from './rpc/route'
import { POST as killSwitch, _internal as killSwitchInternal } from './admin/kill-switch/route'

const TRUSTED = '198.51.100.9'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/

/** A request as it arrives on Vercel: the platform header carries the real client; x-forwarded-for's left-most token is the caller's to write. */
const headers = (leftMostXff: string) => ({ 'x-vercel-forwarded-for': TRUSTED, 'x-forwarded-for': `${leftMostXff}, 203.0.113.7` })
const get = (path: string, leftMostXff = '6.6.6.6') => new NextRequest(`http://localhost${path}`, { method: 'GET', headers: headers(leftMostXff) })

/** The routes that used to build their key from the raw left-most x-forwarded-for token (and their key prefix). */
const FORMERLY_RAW_XFF = [
  { name: '/api/portfolio/prices', prefix: 'portfolio-prices', call: (xff?: string) => portfolioPrices(get(`/api/portfolio/prices?tokens=${USDC}`, xff)) },
  { name: '/api/portfolio/tokens', prefix: 'portfolio-tokens', call: (xff?: string) => portfolioTokens(get(`/api/portfolio/tokens?address=${USDC}`, xff)) },
  { name: '/api/oracle-coverage', prefix: 'oracle', call: (xff?: string) => oracleCoverage(get(`/api/oracle-coverage?token=${USDC}`, xff)) },
] as const

let logged: string[] = []
beforeEach(() => {
  redis.keys.length = 0
  redis.fail = false
  limiter.reset()
  killSwitchInternal.rateLimitMap.clear()
  logged = []
  for (const level of ['warn', 'error', 'log', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 }))) // no route below needs a real upstream
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the four formerly raw-XFF routes key on HMAC(trusted IP)', () => {
  it.each(FORMERLY_RAW_XFF)('$name → ratelimit:$prefix:<hash of the platform-reported IP>', async ({ prefix, call }) => {
    await call()
    const expected = `ratelimit:${prefix}:${hashClientIp(TRUSTED)}`
    expect(redis.keys.length).toBeGreaterThan(0)
    expect([...new Set(redis.keys)]).toEqual([expected])
  })

  it.each(FORMERLY_RAW_XFF)('$name: rewriting x-forwarded-for does not move the caller to another bucket', async ({ call }) => {
    for (const spoof of ['1.1.1.1', '2.2.2.2', 'attacker-chosen', '9.9.9.9']) await call(spoof)
    expect(new Set(redis.keys).size).toBe(1)
  })

  it('/api/admin/kill-switch: the in-memory limiter is keyed the same way, so a spoofed header no longer dodges it', async () => {
    const post = (spoof: string) =>
      killSwitch(new NextRequest('http://localhost/api/admin/kill-switch', { method: 'POST', headers: { ...headers(spoof), 'content-type': 'application/json' }, body: '{}' }))
    const statuses: number[] = []
    // One distinct left-most token per request: before, each was its own bucket and none was ever limited.
    for (let i = 0; i <= killSwitchInternal.RATE_LIMIT_MAX; i++) statuses.push((await post(`10.9.8.${i}`)).status)
    expect(statuses.at(-1)).toBe(429)
    expect(statuses.slice(0, -1)).not.toContain(429)
    expect([...killSwitchInternal.rateLimitMap.keys()]).toEqual([hashClientIp(TRUSTED)])
  })
})

describe('no raw IP in a Redis key', () => {
  it('every key written for a per-IP limit is `ratelimit:<route>:<32 hex>`', async () => {
    for (const { call } of FORMERLY_RAW_XFF) await call()
    await tokenLogo(get(`/api/token-logo?chainId=1&address=${USDC}`))
    await rpc(new NextRequest('http://localhost/api/rpc', { method: 'POST', headers: { ...headers('6.6.6.6'), 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_newFilter"}' }))

    const keys = [...new Set(redis.keys)]
    expect(keys.map((k) => k.split(':')[1]).sort()).toEqual(['oracle', 'portfolio-prices', 'portfolio-tokens', 'rpc', 'token-logo'])
    for (const key of keys) {
      expect(key).toMatch(/^ratelimit:[a-z-]+:[0-9a-f]{32}$/)
      expect(key).not.toMatch(IPV4)
      expect(key).not.toContain(TRUSTED)
    }
  })
})

// [fix/user-ip-privacy A76 S-4] The audit got 300/min from EACH of three addresses of one /64 — one subscriber, three
// budgets. An IPv6 client is now one bucket per /64 at every per-IP limiter (they all go through clientIpKey).
describe('IPv6: one bucket per /64 [A76 S-4]', () => {
  const rpcFrom = (ip: string) =>
    rpc(new NextRequest('http://localhost/api/rpc', { method: 'POST', headers: { 'x-vercel-forwarded-for': ip, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_newFilter"}' }))

  it('three addresses of one /64 (any spelling) share ONE rpc bucket; the next /64 is another', async () => {
    for (const ip of ['2001:db8:1:2::1', '2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd', '2001:DB8:1:2:FFFF:FFFF:FFFF:FFFF']) await rpcFrom(ip)
    const sameSlash64 = [...new Set(redis.keys)]
    expect(sameSlash64).toEqual([`ratelimit:rpc:${hashClientIp('2001:db8:1:2::/64')}`])
    redis.keys.length = 0
    await rpcFrom('2001:db8:1:3::1')
    expect([...new Set(redis.keys)]).toEqual([`ratelimit:rpc:${hashClientIp('2001:db8:1:3::/64')}`])
  })
})

describe('no raw IP in a log line (Redis outage → the in-memory fallback logs every request)', () => {
  it('the fallback warning names the hashed bucket, never the address', async () => {
    redis.fail = true
    for (const { call } of FORMERLY_RAW_XFF) await call()
    await tokenLogo(get(`/api/token-logo?chainId=1&address=${USDC}`))
    await rpc(new NextRequest('http://localhost/api/rpc', { method: 'POST', headers: { ...headers('6.6.6.6'), 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_newFilter"}' }))

    const fallbackLines = logged.filter((l) => l.includes('in-memory fallback for'))
    expect(fallbackLines.length).toBeGreaterThanOrEqual(5) // the recon's `token-logo:::1` line, once per request
    expect(fallbackLines.some((l) => l.includes(`token-logo:${hashClientIp(TRUSTED)}`))).toBe(true)
    for (const line of logged) {
      expect(line).not.toMatch(IPV4)
      expect(line).not.toContain(TRUSTED)
      expect(line).not.toContain('6.6.6.6')
    }
  })
})
