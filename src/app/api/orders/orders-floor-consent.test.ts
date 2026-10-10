// @vitest-environment node
/**
 * [FEAT-DCA-FLOOR-TIERS] POST /api/orders — the server classifies the DCA pair itself and requires
 * (and records) the matching acknowledgement. Runs the REAL classifier against a mocked executor
 * registry reader and mocked price sources, so the whole decision chain is exercised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockRecover = vi.fn()
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return { ...actual, recoverTypedDataAddress: (...args: unknown[]) => mockRecover(...args) }
})

const mockRpc = vi.fn()
const mockSingle = vi.fn()
const mockInsert = vi.fn((_row: Record<string, unknown>) => ({ select: () => ({ single: () => mockSingle() }) }))
const mockFrom = vi.fn((..._args: unknown[]) => ({ insert: mockInsert }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}))
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  return { ...actual, checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })) }
})

const V3_MAINNET = '0x3333333333333333333333333333333333333333'
vi.mock('@/lib/order-engine/config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine/config')>('@/lib/order-engine/config')
  return {
    ...actual,
    getOrderExecutorV3: (chainId: number) => (chainId === 1 ? V3_MAINNET : null),
    getOrderExecutorV3Domain: (chainId: number) => {
      if (chainId !== 1) throw new Error(`No OrderExecutorV3 deployed on chain ${chainId}`)
      return { name: 'TeraSwapOrderExecutor' as const, version: '3' as const, chainId, verifyingContract: V3_MAINNET }
    },
  }
})

// The executor's `tokenUsdFeeds` reader. `registryMode` drives it.
let registryMode: 'all' | 'none' | 'down' = 'none'
const readerCalls: Array<{ address: string; token: string }> = []
vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: () => ({
    readContract: async ({ address, args }: { address: string; args: readonly unknown[] }) => {
      readerCalls.push({ address, token: String(args[0]).toLowerCase() })
      if (registryMode === 'down') throw new Error('rpc down')
      return registryMode === 'all'
        ? ['0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 8, 18, 3600n, true]
        : ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false]
    },
  }),
  _clearClientCache: vi.fn(),
}))

const WALLET = '0x1111111111111111111111111111111111111111'
const TOKEN_IN = '0x2222222222222222222222222222222222222222'
const TOKEN_OUT = '0x5555555555555555555555555555555555555555'
const ROUTER = '0x4444444444444444444444444444444444444444'
const SIG = '0x' + 'cc'.repeat(65)
const ZERO_HASH = '0x' + '00'.repeat(32)
const NOW_MS = Date.UTC(2026, 9, 11, 0, 0, 0)
const NOW_S = Math.floor(NOW_MS / 1000)

// Price sources: per-address. `outPriced` toggles whether TOKEN_OUT has any price.
let outPriced = true
const mockFetchDefiLlamaPrice = vi.fn(async (addr: string) => {
  if (addr.toLowerCase() === TOKEN_OUT && !outPriced) return null
  return { price: 1, symbol: 'X', timestamp: 0, confidence: 1 }
})
vi.mock('@/lib/defillama', () => ({
  fetchDefiLlamaPrice: (addr: string, ...rest: unknown[]) => mockFetchDefiLlamaPrice(addr, ...(rest as [])),
  HIGH_VALUE_THRESHOLD_USD: 10_000,
  validateSwapPrice: vi.fn(),
}))
vi.mock('@/lib/chainlink', () => ({
  computeTokenAmountUsd: vi.fn(async (addr: string) => (addr.toLowerCase() === TOKEN_OUT ? null : { usd: 100, price: 1, decimals: 18 })),
  fetchErc20Decimals: vi.fn(async () => 18),
}))

import { POST } from './route'

const ENV0 = { ...process.env }
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  readerCalls.length = 0
  registryMode = 'none'
  outPriced = true
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'
  mockRecover.mockResolvedValue(WALLET)
  mockRpc.mockResolvedValue({ data: true })
  mockSingle.mockResolvedValue({ data: { id: 'order-uuid-1' }, error: null })
})
afterEach(() => {
  vi.useRealTimers()
  process.env = { ...ENV0 }
})

function body(overrides: Record<string, unknown> = {}) {
  return {
    wallet: WALLET, chainId: 1, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, router: ROUTER, signature: SIG,
    orderHash: '0x' + 'ab'.repeat(32), amountIn: '1000000000000000000',
    minAmountOut: (100n * 10n ** 18n).toString(), tokenOutDecimals: 18,
    orderType: 'dca', priceCondition: 'above', targetPrice: '0',
    priceFeed: '0x0000000000000000000000000000000000000000',
    expiry: NOW_S + 3600, nonce: 0, routerDataHash: ZERO_HASH, dcaInterval: 3600, dcaTotal: 3, maxSlippageBps: 300,
    ...overrides,
  }
}
async function post(b: unknown) {
  const res = await POST(new NextRequest('http://localhost/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  }))
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}
const ack = (tier: string, at = new Date(NOW_MS - 1000).toISOString()) => ({ floorAck: { tier, acknowledgedAt: at } })
const insertedRow = () => mockInsert.mock.calls[0][0]

describe('POST /api/orders — DCA floor-tier consent [FEAT-DCA-FLOOR-TIERS]', () => {
  it('onchain-feed (both legs registered) without an ack is accepted and records no tier', async () => {
    registryMode = 'all'
    const { status } = await post(body())
    expect(status).toBe(201)
    expect(insertedRow()).not.toHaveProperty('floor_tier')
    expect(insertedRow()).not.toHaveProperty('floor_ack_at')
    // The question was asked of the CHAIN's executor, for both signed legs.
    expect(readerCalls.map(c => c.address)).toEqual([V3_MAINNET, V3_MAINNET])
  })

  it('offchain-price without an ack is rejected (409) and the 4xx names the required tier', async () => {
    const { status, json } = await post(body())
    expect(status).toBe(409)
    expect(json.requiredTier).toBe('offchain-price')
    expect(String(json.error)).toMatch(/offchain-price/)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('a tier MISMATCH is rejected: an offchain-price ack cannot cover an unpriced pair', async () => {
    outPriced = false
    const { status, json } = await post(body(ack('offchain-price')))
    expect(status).toBe(409)
    expect(json.requiredTier).toBe('unpriced')
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('an "onchain-feed" ack is not a way around a weaker tier', async () => {
    const { status, json } = await post(body(ack('onchain-feed')))
    expect(status).toBe(409)
    expect(json.requiredTier).toBe('offchain-price')
  })

  it('offchain-price + correct ack is accepted and persisted', async () => {
    const { status } = await post(body(ack('offchain-price')))
    expect(status).toBe(201)
    expect(insertedRow()).toMatchObject({ floor_tier: 'offchain-price', floor_ack_at: new Date(NOW_MS - 1000).toISOString() })
  })

  it('unpriced + correct ack is accepted and persisted', async () => {
    outPriced = false
    // 100 tokens over 3 buys: the INPUT per buy ($33) clears the dust floor the no-feed branch uses.
    const { status } = await post(body({ amountIn: (100n * 10n ** 18n).toString(), ...ack('unpriced') }))
    expect(status).toBe(201)
    expect(insertedRow()).toMatchObject({ floor_tier: 'unpriced', floor_ack_at: new Date(NOW_MS - 1000).toISOString() })
  })

  it('registry DOWN classifies as unpriced: no ack is rejected naming unpriced; the unpriced ack is accepted', async () => {
    registryMode = 'down'
    const none = await post(body())
    expect(none.status).toBe(409)
    expect(none.json.requiredTier).toBe('unpriced')
    const weaker = await post(body(ack('offchain-price')))
    expect(weaker.status).toBe(409)
    const ok = await post(body({ ...ack('unpriced') }))
    expect(ok.status).toBe(201)
    expect(insertedRow()).toMatchObject({ floor_tier: 'unpriced' })
  })

  it('an ack timestamp that is stale, future or malformed is rejected (400)', async () => {
    for (const at of [new Date(NOW_MS - 25 * 3_600_000).toISOString(), new Date(NOW_MS + 3_600_000).toISOString(), 'not-a-date']) {
      const { status } = await post(body(ack('offchain-price', at)))
      expect(status).toBe(400)
    }
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('a v2 DCA (no maxSlippageBps) is untouched: no classification, no ack needed', async () => {
    const b = body() as Record<string, unknown>
    delete b.maxSlippageBps
    const { status } = await post(b)
    expect(status).toBe(201)
    expect(readerCalls).toHaveLength(0)
    expect(insertedRow()).not.toHaveProperty('floor_tier')
  })
})
