// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockRate = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 }))
vi.mock('@/lib/kv-rate-limiter', async () => ({ ...(await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')), checkRateLimit: () => mockRate() }))
let row: unknown = null
let throws = false
const eq = vi.fn(() => ({ maybeSingle: async () => { if (throws) throw new Error('db'); return { data: row } } }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (t: string) => ({ select: () => { expect(t).toBe('keeper_runtime_config'); return { eq } } }) }) }))

// The chain's V3 executor and its `tokenUsdFeeds` registry (Base only; every other chain has none).
const BASE_V3 = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'
vi.mock('@/lib/order-engine/config', async () => ({
  ...(await vi.importActual<typeof import('@/lib/order-engine/config')>('@/lib/order-engine/config')),
  getOrderExecutorV3: (id: number) => (id === 8453 ? BASE_V3 : null),
}))
const registered = new Set<string>()
let registryDown = false
const registryCalls: Array<{ address: string; token: string }> = []
vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: () => ({
    readContract: async ({ address, args }: { address: string; args: readonly unknown[] }) => {
      const token = String(args[0]).toLowerCase()
      registryCalls.push({ address, token })
      if (registryDown) throw new Error('rpc down')
      return registered.has(token)
        ? ['0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 8, 18, 3600n, true]
        : ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false]
    },
  }),
}))

import { GET } from './route'
import { DCA_NO_PRICE_FILL_CAP_MAX_USD as MAX } from '@/lib/order-engine/dca-floor-tier'
import { getChainTokenList } from '@/lib/chains/tokens'

const baseAddr = (symbol: string) => getChainTokenList(8453).find(t => t.symbol === symbol)!.address.toLowerCase()
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

const call = async (q: string) => { const r = await GET(new NextRequest(`http://localhost/api/dca-floor-cap${q}`)); return { status: r.status, json: await r.json(), cache: r.headers.get('cache-control') } }
const ENV0 = { ...process.env }
let clock = Date.UTC(2026, 9, 11)
beforeEach(() => {
  mockRate.mockClear(); eq.mockClear(); row = null; throws = false
  process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'
  registered.clear(); registered.add(baseAddr('WETH')).add(baseAddr('USDC'))
  registryDown = false; registryCalls.length = 0
  // Every test starts past the previous test's 60s count cache.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock += 120_000)
})
afterEach(() => { vi.useRealTimers(); process.env = { ...ENV0 } })

describe('GET /api/dca-floor-cap', () => {
  it('rejects a bad chainId', async () => { expect((await call('?chainId=abc')).status).toBe(400) })
  it('no row -> the ceiling', async () => { expect((await call('?chainId=8453')).json).toEqual({ maxUsd: MAX, effectiveUsd: MAX, registeredFeedCount: 2 }) })
  it('row below MAX -> min(row, MAX)', async () => { row = { no_price_fill_cap_usd: '75' }; expect((await call('?chainId=8453')).json.effectiveUsd).toBe(75) })
  it('row above MAX -> clamped to MAX', async () => { row = { no_price_fill_cap_usd: 5000 }; expect((await call('?chainId=8453')).json.effectiveUsd).toBe(MAX) })
  it('db failure -> the ceiling', async () => { throws = true; expect((await call('?chainId=8453')).json.effectiveUsd).toBe(MAX) })
  it('is public-cacheable for 60s on success and on the ceiling fallback', async () => {
    expect((await call('?chainId=8453')).cache).toBe('public, max-age=60')
    throws = true
    expect((await call('?chainId=8453')).cache).toBe('public, max-age=60')
  })
  it('is rate limited: 429 before any DB read, and it consults the limiter on every call', async () => {
    mockRate.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 })
    const r = await call('?chainId=8453')
    expect(r.status).toBe(429)
    expect(eq).not.toHaveBeenCalled()
    expect(registryCalls).toHaveLength(0) // nor any registry read
    await call('?chainId=8453')
    expect(mockRate).toHaveBeenCalledTimes(2)
  })
})

describe('GET /api/dca-floor-cap — registeredFeedCount [fix/dca-consent-copy-and-tier-check]', () => {
  it('counts the suggested-set tokens the chain\'s V3 registry has a feed for (native ETH asked as WETH, once)', async () => {
    const { json } = await call('?chainId=8453')
    expect(json.registeredFeedCount).toBe(2)
    expect(new Set(registryCalls.map(c => c.address))).toEqual(new Set([BASE_V3]))
    const asked = registryCalls.map(c => c.token)
    expect(asked).not.toContain(NATIVE)
    expect(asked.filter(t => t === baseAddr('WETH'))).toHaveLength(1)
    expect(new Set(asked)).toEqual(new Set(getChainTokenList(8453).map(t => (t.address.toLowerCase() === NATIVE ? baseAddr('WETH') : t.address.toLowerCase()))))
  })

  it('grows when the registry adds a token — after the 60s cache, not before', async () => {
    expect((await call('?chainId=8453')).json.registeredFeedCount).toBe(2)
    registered.add(baseAddr('AERO'))
    vi.setSystemTime(clock += 59_000)
    expect((await call('?chainId=8453')).json.registeredFeedCount).toBe(2) // cached
    vi.setSystemTime(clock += 2_000)
    expect((await call('?chainId=8453')).json.registeredFeedCount).toBe(3)
  })

  it('registry unreadable -> null (never 0, never cached); the cap is still served with Cache-Control', async () => {
    registryDown = true
    const r = await call('?chainId=8453')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ maxUsd: MAX, effectiveUsd: MAX, registeredFeedCount: null })
    expect(r.cache).toBe('public, max-age=60')
    registryDown = false
    expect((await call('?chainId=8453')).json.registeredFeedCount).toBe(2) // the failure was not cached
  })

  it('no V3 executor on the chain -> null, without asking any registry', async () => {
    expect((await call('?chainId=1')).json.registeredFeedCount).toBeNull()
    expect(registryCalls).toHaveLength(0)
  })

  it('also present when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.NEXT_PUBLIC_SUPABASE_URL
    expect((await call('?chainId=8453')).json).toEqual({ maxUsd: MAX, effectiveUsd: MAX, registeredFeedCount: 2 })
  })
})
