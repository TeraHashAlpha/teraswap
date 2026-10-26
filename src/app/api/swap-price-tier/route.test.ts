// @vitest-environment node
/**
 * [feat/swap-price-tiers] GET /api/swap-price-tier — the SERVER's price tier for a swap pair (D1), from the
 * shared ADR-024 quorum (D4) over Chainlink (mocked read) + DefiLlama + CoinGecko (fetch stubbed per address).
 * Rate-limited as /api/quote, 30 s cache per (chainId, in, out), never 5xx: an exception answers `unpriced`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { resetQuorumQuoteCache } from '@/lib/price-quorum'

type RateArgs = [key: string, limit: number, windowMs: number]
const mockRate = vi.fn<(...a: RateArgs) => Promise<{ allowed: boolean; remaining: number; resetAt: number }>>(
  async () => ({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 }),
)
vi.mock('@/lib/kv-rate-limiter', async () => ({
  ...(await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')),
  checkRateLimit: (...a: RateArgs) => mockRate(...a),
}))
const mockChainlink = vi.fn<(addr: string, chainId: number) => Promise<{ price: number; updatedAt: number } | null>>(async () => null)
vi.mock('@/lib/chainlink', () => ({ fetchChainlinkPriceRaw: (...a: [string, number]) => mockChainlink(...a) }))

import { GET } from './route'

const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'
const ETHFI = '0x6c240dda6b5c336df09a4d011139beaaa1ea2aa2'
const BASE_WETH = '0x4200000000000000000000000000000000000006'
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const lc = (a: string) => a.toLowerCase()

type Ans = { price: number; ts?: number } | null | 'throw'
let NOW_SEC = 1_793_028_425
const llama: Record<string, Ans> = {}
const gecko: Record<string, Ans> = {}
const fetched: string[] = []
function stubSources() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url)
    const u = new URL(url)
    const reply = (a: Ans | undefined, body: (a: { price: number; ts?: number }) => unknown) => {
      if (a === 'throw') throw new TypeError('Failed to fetch')
      if (!a) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body(a) }
    }
    if (u.origin === 'https://coins.llama.fi') {
      const key = decodeURIComponent(u.pathname.replace('/prices/current/', ''))
      const [slug, addr] = key.split(':')
      return reply(llama[addr], a => ({ coins: { [`${slug}:${addr}`]: { price: a.price, timestamp: a.ts ?? NOW_SEC - 60, confidence: 0.99 } } }))
    }
    if (u.origin === 'https://api.coingecko.com') {
      const addr = u.searchParams.get('contract_addresses') ?? ''
      expect(addr).not.toContain(',') // one address per request (keyless tier)
      return reply(gecko[addr], a => ({ [addr]: { usd: a.price, last_updated_at: a.ts ?? NOW_SEC - 30 } }))
    }
    throw new Error(`unexpected host ${url}`)
  }))
}
const call = async (q: string, headers: Record<string, string> = {}) => {
  const r = await GET(new NextRequest(`http://localhost/api/swap-price-tier${q}`, { headers }))
  return { status: r.status, json: await r.json(), cache: r.headers.get('cache-control'), headers: r.headers }
}
const PAIR = `?chainId=8453&tokenIn=${AERO}&tokenOut=${ETHFI}`
const priceBoth = () => {
  llama[lc(AERO)] = { price: 0.6924 }; gecko[lc(AERO)] = { price: 0.691398 }
  llama[lc(ETHFI)] = { price: 0.6373 }; gecko[lc(ETHFI)] = { price: 0.636623 }
}

beforeEach(() => {
  for (const m of [llama, gecko]) for (const k of Object.keys(m)) delete m[k]
  fetched.length = 0
  mockRate.mockClear(); mockChainlink.mockClear().mockResolvedValue(null)
  resetQuorumQuoteCache()
  // Each test starts past the previous test's 30 s pair cache; the freshness clock follows.
  NOW_SEC += 120
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW_SEC * 1000)
  stubSources()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('GET /api/swap-price-tier — validation + limits', () => {
  it('400 on a bad or unsupported chainId, a malformed token, or a missing leg; no source is asked', async () => {
    for (const q of [`?chainId=abc&tokenIn=${AERO}&tokenOut=${ETHFI}`, `?chainId=999&tokenIn=${AERO}&tokenOut=${ETHFI}`,
      `?chainId=8453&tokenIn=0x123&tokenOut=${ETHFI}`, `?chainId=8453&tokenIn=${AERO}`, `?tokenIn=${AERO}&tokenOut=${ETHFI}`]) {
      expect((await call(q)).status, q).toBe(400)
    }
    expect(fetched).toHaveLength(0)
    expect(mockChainlink).not.toHaveBeenCalled()
  })
  it('429 with the rate-limit headers before any source fetch (same limiter as /api/quote)', async () => {
    mockRate.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: 123 })
    const r = await call(PAIR)
    expect(r.status).toBe(429)
    expect(r.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(fetched).toHaveLength(0)
    expect(mockRate.mock.calls[0][0]).toMatch(/^swap-price-tier:/)
  })
})

describe('GET /api/swap-price-tier — the tiers (D4)', () => {
  it('both legs agree on 2 sources -> priced, per-leg sources/usd/agreementBps, pair agreementBps = the worse leg', async () => {
    priceBoth()
    const r = await call(PAIR)
    expect(r.status).toBe(200)
    expect(r.cache).toBe('public, max-age=30, s-maxage=30')
    expect(r.json.tier).toBe('priced')
    expect(r.json.legs.in).toMatchObject({ tier: 'priced', sources: ['defillama', 'coingecko'], usd: 0.691398 })
    expect(r.json.legs.out).toMatchObject({ tier: 'priced', sources: ['defillama', 'coingecko'], usd: 0.636623 })
    expect(r.json.agreementBps).toBeCloseTo(Math.max(r.json.legs.in.agreementBps, r.json.legs.out.agreementBps), 9)
    expect(r.json.agreementBps).toBeLessThan(300)
  })
  it('one leg on ONE source, the other on none -> single-source: that leg names the vendor, no usd on the other, no pair agreementBps', async () => {
    llama[lc(AERO)] = { price: 0.69 }
    const r = await call(PAIR)
    expect(r.json).toEqual({
      tier: 'single-source',
      legs: { in: { tier: 'single-source', sources: ['defillama'], usd: 0.69 }, out: { tier: 'unpriced', sources: [] } },
    })
  })
  it('one leg priced + one leg unpriced -> priced (D2: one priced leg sizes the trade)', async () => {
    llama[lc(ETHFI)] = { price: 0.6373 }; gecko[lc(ETHFI)] = { price: 0.636623 }
    const r = await call(PAIR)
    expect(r.json.tier).toBe('priced')
    expect(r.json.legs.in).toEqual({ tier: 'unpriced', sources: [] })
  })
  it('no source on either leg -> unpriced (the consent tier, never an error)', async () => {
    const r = await call(PAIR)
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ tier: 'unpriced', legs: { in: { tier: 'unpriced', sources: [] }, out: { tier: 'unpriced', sources: [] } } })
  })
  it('two sources disagreeing beyond 300 bps on a leg -> that leg is unpriced (sources listed, no usd)', async () => {
    llama[lc(AERO)] = { price: 1 }; gecko[lc(AERO)] = { price: 1.05 }
    const r = await call(PAIR)
    expect(r.json.tier).toBe('unpriced')
    expect(r.json.legs.in).toEqual({ tier: 'unpriced', sources: ['defillama', 'coingecko'] })
  })
  it('Chainlink is the first source: chainlink + defillama agreeing with CoinGecko down -> priced via those two, read on the pair\'s chain', async () => {
    llama[lc(AERO)] = { price: 0.69 }; llama[lc(ETHFI)] = { price: 0.64 }
    mockChainlink.mockImplementation(async (addr) => (lc(addr) === lc(AERO) ? { price: 0.692, updatedAt: NOW_SEC - 30 } : { price: 0.641, updatedAt: NOW_SEC - 30 }))
    const r = await call(PAIR)
    expect(r.json.tier).toBe('priced')
    expect(r.json.legs.in.sources).toEqual(['chainlink', 'defillama'])
    expect(r.json.legs.in.usd).toBe(0.69)
    expect(mockChainlink).toHaveBeenCalledWith(lc(AERO), 8453)
    expect(mockChainlink).toHaveBeenCalledWith(lc(ETHFI), 8453)
  })
  it('a stale Chainlink round is absent (same 600 s gate as every source)', async () => {
    llama[lc(AERO)] = { price: 0.69 }
    mockChainlink.mockResolvedValue({ price: 0.69, updatedAt: NOW_SEC - 601 })
    const r = await call(PAIR)
    expect(r.json.legs.in).toEqual({ tier: 'single-source', sources: ['defillama'], usd: 0.69 })
  })
  it('native ETH is priced as the chain\'s wrapped native (Base WETH), the address the keeper and the oracle know', async () => {
    llama[lc(BASE_WETH)] = { price: 2500 }; gecko[lc(BASE_WETH)] = { price: 2501 }
    const r = await call(`?chainId=8453&tokenIn=${NATIVE}&tokenOut=${ETHFI}`)
    expect(r.json.legs.in.tier).toBe('priced')
    expect(mockChainlink).toHaveBeenCalledWith(lc(BASE_WETH), 8453)
    expect(fetched.some(u => u.includes(lc(BASE_WETH)))).toBe(true)
    expect(fetched.some(u => u.includes(lc(NATIVE)))).toBe(false)
  })
  it('every source failing (network + RPC throw) -> 200 unpriced, never a 5xx', async () => {
    llama[lc(AERO)] = 'throw'; gecko[lc(AERO)] = 'throw'; llama[lc(ETHFI)] = 'throw'; gecko[lc(ETHFI)] = 'throw'
    mockChainlink.mockRejectedValue(new Error('rpc down'))
    const r = await call(PAIR)
    expect(r.status).toBe(200)
    expect(r.json.tier).toBe('unpriced')
  })
})

describe('GET /api/swap-price-tier — 30 s cache per (chainId, tokenIn, tokenOut)', () => {
  it('a second identical ask within 30 s answers from cache (no fetch, no Chainlink read); case-insensitive key', async () => {
    priceBoth()
    await call(PAIR)
    const n = fetched.length, c = mockChainlink.mock.calls.length
    expect(n).toBe(4); expect(c).toBe(2)
    vi.setSystemTime((NOW_SEC + 20) * 1000)
    const again = await call(`?chainId=8453&tokenIn=${lc(AERO)}&tokenOut=${ETHFI.toUpperCase().replace('0X', '0x')}`)
    expect(again.json.tier).toBe('priced')
    expect(fetched.length).toBe(n); expect(mockChainlink.mock.calls.length).toBe(c)
  })
  it('after 30 s the pair is re-classified', async () => {
    priceBoth()
    await call(PAIR)
    vi.setSystemTime((NOW_SEC + 31) * 1000)
    resetQuorumQuoteCache() // the quorum's own 30 s quote cache expired too
    await call(PAIR)
    expect(mockChainlink.mock.calls.length).toBe(4)
  })
  it('the reversed pair and another chain are different keys', async () => {
    priceBoth()
    await call(PAIR)
    await call(`?chainId=8453&tokenIn=${ETHFI}&tokenOut=${AERO}`)
    expect(mockChainlink.mock.calls.length).toBe(4)
  })
})
