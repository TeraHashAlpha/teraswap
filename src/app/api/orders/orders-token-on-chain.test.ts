// @vitest-environment node
/**
 * [fix/dca-chain-switch] POST /api/orders — a v3 DCA may only name tokens that exist on the order's
 * chain. Uses the REAL checkTokenOnChain (known-map → eth_getCode → cache) over a scripted RPC
 * client, and the real chain token maps for every address (none hand-typed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockRecover = vi.fn()
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return { ...actual, recoverTypedDataAddress: (...args: unknown[]) => mockRecover(...args) }
})
const mockSingle = vi.fn()
const mockInsert = vi.fn((_row: Record<string, unknown>) => ({ select: () => ({ single: () => mockSingle() }) }))
const mockRpc = vi.fn()
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a), from: () => ({ insert: mockInsert }) }),
}))
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  return { ...actual, checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })) }
})

const V3 = '0x3333333333333333333333333333333333333333'
vi.mock('@/lib/order-engine/config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine/config')>('@/lib/order-engine/config')
  return {
    ...actual,
    getOrderExecutorV3: (c: number) => (c === 8453 || c === 42161 ? V3 : null),
    isWhitelistedRouter: () => true,
    getOrderExecutorV3Domain: (chainId: number) => ({ name: 'TeraSwapOrderExecutor' as const, version: '3' as const, chainId, verifyingContract: V3 }),
  }
})

// RPC: registry reads say "no feed"; getCode answers from `codeAt` (address → bytecode).
const codeAt = new Map<string, string>()
let getCodeFails = false
const getCodeCalls: Array<{ address: string }> = []
vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: () => ({
    readContract: async () => ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false],
    getCode: async ({ address }: { address: string }) => {
      getCodeCalls.push({ address })
      if (getCodeFails) throw new Error('rpc down')
      return codeAt.get(address.toLowerCase())
    },
  }),
  _clearClientCache: vi.fn(),
}))
vi.mock('@/lib/defillama', () => ({ fetchDefiLlamaPrice: vi.fn(async () => null), HIGH_VALUE_THRESHOLD_USD: 10_000, validateSwapPrice: vi.fn() }))
vi.mock('@/lib/order-engine/dca-price-quorum', async () => ({
  ...(await vi.importActual<typeof import('@/lib/order-engine/dca-price-quorum')>('@/lib/order-engine/dca-price-quorum')),
  quorumPriceUsd: async () => null,
}))
vi.mock('@/lib/chainlink', async () => {
  const { getWrappedNative } = await import('@/lib/chains/registry')
  return {
  // the spend leg (WETH) prices; the no-feed buy leg does not — the input-value dust path, as in orders-floor-consent
  computeTokenAmountUsd: vi.fn(async (addr: string) => (addr.toLowerCase() === getWrappedNative(8453).toLowerCase() ? { usd: 100, price: 1, decimals: 18 } : null)),
  fetchErc20Decimals: vi.fn(async () => 18),
  }
})

import { POST } from './route'
import { _clearTokenOnChainCache } from '@/lib/order-engine/token-on-chain'
import { getChainTokenList } from '@/lib/chains/tokens'
import { getWrappedNative } from '@/lib/chains/registry'
import { NATIVE_ETH } from '@/lib/constants'

const WALLET = '0x1111111111111111111111111111111111111111'
const ROUTER = '0x4444444444444444444444444444444444444444'
const SIG = '0x' + 'cc'.repeat(65)
const NOW_MS = Date.UTC(2026, 9, 14, 0, 0, 0)
const NOW_S = Math.floor(NOW_MS / 1000)

const baseTokens = getChainTokenList(8453)
const arbTokens = getChainTokenList(42161)
const BASE_WETH = getWrappedNative(8453)
const ARB_WETH = getWrappedNative(42161)
const ARB_ARB = arbTokens.find(t => t.symbol === 'ARB')!.address
// A Base catalog token that is not on Arbitrum — "valid Base token without a feed".
const BASE_ONLY = baseTokens.find(t => t.symbol === 'AERO')!.address

const ENV0 = { ...process.env }
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  codeAt.clear(); getCodeCalls.length = 0; getCodeFails = false
  _clearTokenOnChainCache()
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'
  mockRecover.mockResolvedValue(WALLET)
  mockRpc.mockResolvedValue({ data: true })
  mockSingle.mockResolvedValue({ data: { id: 'order-uuid-1' }, error: null })
})
afterEach(() => { vi.useRealTimers(); process.env = { ...ENV0 } })

const body = (o: Record<string, unknown> = {}) => ({
  wallet: WALLET, chainId: 8453, tokenIn: BASE_WETH, tokenOut: BASE_ONLY, router: ROUTER, signature: SIG,
  orderHash: '0x' + 'ab'.repeat(32), amountIn: (100n * 10n ** 18n).toString(),
  minAmountOut: (100n * 10n ** 18n).toString(), tokenOutDecimals: 18,
  orderType: 'dca', priceCondition: 'above', targetPrice: '0',
  priceFeed: '0x0000000000000000000000000000000000000000',
  expiry: NOW_S + 3600, nonce: 0, routerDataHash: '0x' + '00'.repeat(32), dcaInterval: 3600, dcaTotal: 3, maxSlippageBps: 300,
  floorAck: { tier: 'unpriced', acknowledgedAt: new Date(NOW_MS - 1000).toISOString() },
  ...o,
})
async function post(b: unknown) {
  const res = await POST(new NextRequest('http://localhost/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  }))
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('POST /api/orders — DCA tokens must exist on the order chain [fix/dca-chain-switch]', () => {
  it('fixtures: the foreign addresses really are not in the Base map', () => {
    const base = new Set(baseTokens.map(t => t.address.toLowerCase()))
    expect(base.has(ARB_ARB.toLowerCase())).toBe(false)
    expect(base.has(ARB_WETH.toLowerCase())).toBe(false)
    expect(base.has(BASE_ONLY.toLowerCase())).toBe(true)
  })

  it('Arbitrum ARB as tokenOut with chainId 8453 → 400 token_not_on_chain; signature recovery and insert never run', async () => {
    const { status, json } = await post(body({ tokenOut: ARB_ARB }))
    expect(status).toBe(400)
    expect(json).toMatchObject({ code: 'token_not_on_chain', leg: 'tokenOut' })
    expect(mockRecover).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(getCodeCalls).toEqual([{ address: ARB_ARB }]) // eth_getCode asked on the order's chain
  })

  it("Arbitrum's WETH as tokenIn with chainId 8453 → 400 naming tokenIn; mocks not called", async () => {
    const { status, json } = await post(body({ tokenIn: ARB_WETH }))
    expect(status).toBe(400)
    expect(json).toMatchObject({ code: 'token_not_on_chain', leg: 'tokenIn' })
    expect(mockRecover).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('the verdict is cached per (chainId, address): a repeat does not hit the RPC again', async () => {
    await post(body({ tokenOut: ARB_ARB }))
    await post(body({ tokenOut: ARB_ARB }))
    expect(getCodeCalls).toHaveLength(1)
    vi.setSystemTime(NOW_MS + 11 * 60_000) // past the 10 min TTL
    await post(body({ tokenOut: ARB_ARB, expiry: NOW_S + 11 * 60 + 3600 }))
    expect(getCodeCalls).toHaveLength(2)
  })

  it('an unknown address WITH bytecode on the order chain is accepted (long-tail token)', async () => {
    const LONG_TAIL = '0x9999999999999999999999999999999999999999'
    codeAt.set(LONG_TAIL, '0x6080604052')
    const { status } = await post(body({ tokenOut: LONG_TAIL }))
    expect(status).toBe(201)
    expect(getCodeCalls).toHaveLength(1)
  })

  it('a valid Base token with no feed still works (known map: no RPC, ack path unchanged)', async () => {
    const { status } = await post(body())
    expect(status).toBe(201)
    expect(getCodeCalls).toHaveLength(0)
  })

  it('getCode failing is NOT a pass: 503 token_check_unavailable, nothing signed or inserted, and not cached', async () => {
    getCodeFails = true
    const LONG_TAIL = '0x9999999999999999999999999999999999999999'
    const first = await post(body({ tokenOut: LONG_TAIL }))
    expect(first.status).toBe(503)
    expect(first.json).toMatchObject({ code: 'token_check_unavailable' })
    expect(mockRecover).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    getCodeFails = false
    codeAt.set(LONG_TAIL, '0x6080')
    expect((await post(body({ tokenOut: LONG_TAIL }))).status).toBe(201)
  })

  it('native-sentinel rules unchanged: tokenOut native is still "Use WETH", tokenIn native still rejected; no getCode', async () => {
    const out = await post(body({ tokenOut: NATIVE_ETH }))
    expect(out.status).toBe(400)
    expect(String(out.json.error)).toMatch(/Use WETH/)
    const inn = await post(body({ tokenIn: NATIVE_ETH }))
    expect(inn.status).toBe(400)
    expect(getCodeCalls).toHaveLength(0)
  })
})
