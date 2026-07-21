// @vitest-environment node
/**
 * [SPRINT-P1B / ADR-014 option (a)] POST /api/orders — pinned-route integrity + Stop-Loss deferral.
 *
 * Two server-side guarantees, both fund-flow relevant:
 *
 *  1. A non-DCA order must arrive with pinned calldata that hashes to the routerDataHash the user
 *     SIGNED. The keeper replays those bytes verbatim and never rebuilds a route, so calldata that
 *     does not match would create an order that can never fill (the contract reverts
 *     RouterDataMismatch at TeraSwapOrderExecutorV3.sol:465). Reject at creation instead.
 *
 *  2. Stop-Loss creation is refused (deferred to the v4 executor, owner decision 2026-07-22).
 *     Because the contract uses OrderType.STOP_LOSS for BOTH SL and Take-Profit, the gate keys on
 *     the CONDITION — 'below' is an SL, 'above' is a TP — so TP must keep working.
 *
 * Mirrors orders-v3.test.ts's mocking conventions (v3 simulated on chain 1 for this file only).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { keccak256 } from 'viem'

const mockRecover = vi.fn()
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return { ...actual, recoverTypedDataAddress: (...args: unknown[]) => mockRecover(...args) }
})

const mockRpc = vi.fn()
const mockSingle = vi.fn()
const mockInsert = vi.fn(() => ({ select: () => ({ single: () => mockSingle() }) }))
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
// The mainnet whitelisted set includes the UniV3 SwapRouter — the pinned-route router.
const SERVED_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564'
const UNSERVED_ROUTER = '0x9999999999999999999999999999999999999999'
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

const mockFetchDefiLlamaPrice = vi.fn()
vi.mock('@/lib/defillama', () => ({
  fetchDefiLlamaPrice: (...args: unknown[]) => mockFetchDefiLlamaPrice(...args),
  HIGH_VALUE_THRESHOLD_USD: 10_000,
  validateSwapPrice: vi.fn(),
}))
const mockComputeTokenAmountUsd = vi.fn()
const mockFetchErc20Decimals = vi.fn()
vi.mock('@/lib/chainlink', () => ({
  computeTokenAmountUsd: (...args: unknown[]) => mockComputeTokenAmountUsd(...args),
  fetchErc20Decimals: (...args: unknown[]) => mockFetchErc20Decimals(...args),
}))

import { POST } from './route'

const WALLET = '0x1111111111111111111111111111111111111111'
const TOKEN_IN = '0x2222222222222222222222222222222222222222'
const TOKEN_OUT = '0x3333333333333333333333333333333333333333'
const SIG = '0x' + 'cc'.repeat(65)
const ZERO_HASH = '0x' + '00'.repeat(32)

// A realistic SwapRouter02 exactInputSingle blob and its true hash.
const PINNED_CALLDATA = ('0x04e45aaf' + '11'.repeat(224)) as `0x${string}`
const PINNED_HASH = keccak256(PINNED_CALLDATA)

const NOW_MS = Date.UTC(2026, 6, 22, 0, 0, 0)
const NOW_S = Math.floor(NOW_MS / 1000)

const ENV0 = { ...process.env }
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'
  mockRecover.mockResolvedValue(WALLET)
  mockRpc.mockResolvedValue({ data: true })
  mockSingle.mockResolvedValue({ data: { id: 'order-uuid-1' }, error: null })
  mockFetchDefiLlamaPrice.mockResolvedValue({ price: 1, symbol: 'USDC', timestamp: 0, confidence: 1 })
  mockComputeTokenAmountUsd.mockResolvedValue(null)
  mockFetchErc20Decimals.mockResolvedValue(18)
})
afterEach(() => {
  vi.useRealTimers()
  process.env = { ...ENV0 }
})

/** A pinned Take-Profit order: non-DCA, real hash, matching stored calldata, served router. */
function tpBody(overrides: Record<string, unknown> = {}) {
  const orderData: Record<string, unknown> = {
    owner: WALLET,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: '1000000000000000000',
    minAmountOut: (100n * 10n ** 18n).toString(),
    maxSlippageBps: 300,
    router: SERVED_ROUTER,
    routerDataHash: PINNED_HASH,
    routerData: PINNED_CALLDATA,
  }
  return {
    wallet: WALLET,
    chainId: 1,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    router: SERVED_ROUTER,
    signature: SIG,
    orderHash: '0x' + 'ab'.repeat(32),
    amountIn: '1000000000000000000',
    minAmountOut: (100n * 10n ** 18n).toString(),
    tokenOutDecimals: 18,
    orderType: 'stop_loss', // the contract enum used for BOTH SL and TP
    priceCondition: 'above', // ABOVE ⇒ Take-Profit (allowed)
    targetPrice: '300000000000',
    priceFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    expiry: NOW_S + 3600,
    nonce: 0,
    routerDataHash: PINNED_HASH,
    dcaInterval: 0,
    dcaTotal: 1,
    maxSlippageBps: 300,
    orderData,
    ...overrides,
  }
}

async function post(body: unknown) {
  const res = await POST(
    new NextRequest('http://localhost/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('POST /api/orders [SPRINT-P1B] — Stop-Loss is deferred to v4', () => {
  it('rejects a stop_loss + BELOW order with the ADR reason', async () => {
    const { status, json } = await post(tpBody({ priceCondition: 'below' }))
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/Stop-Loss ships with the v4 executor/i)
  })

  it('the rejection explains WHY (pinned route cannot be guaranteed to fill in a crash)', async () => {
    const { json } = await post(tpBody({ priceCondition: 'below' }))
    expect(String(json.detail)).toMatch(/pins the route when you sign/i)
  })

  it('ACCEPTS the take-profit shape (same orderType, ABOVE condition) — TP is not blocked', async () => {
    const { status } = await post(tpBody({ priceCondition: 'above' }))
    expect(status).toBe(201)
  })

  it('does not block DCA (which is neither SL nor TP)', async () => {
    const { status } = await post(
      tpBody({
        orderType: 'dca',
        priceCondition: 'below',
        priceFeed: '0x0000000000000000000000000000000000000000',
        routerDataHash: ZERO_HASH,
        dcaInterval: 3600,
        dcaTotal: 3,
        orderData: { ...(tpBody().orderData as object), routerDataHash: ZERO_HASH, routerData: undefined },
      }),
    )
    expect(status).toBe(201)
  })
})

describe('POST /api/orders [SPRINT-P1B] — pinned-route integrity (non-DCA)', () => {
  it('accepts calldata that hashes to the signed routerDataHash', async () => {
    const { status } = await post(tpBody())
    expect(status).toBe(201)
  })

  it('rejects TAMPERED calldata that does not hash to the signed value', async () => {
    const tampered = '0x04e45aaf' + '22'.repeat(224)
    const od = { ...(tpBody().orderData as Record<string, unknown>), routerData: tampered }
    const { status, json } = await post(tpBody({ orderData: od }))
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/does not hash to the signed routerDataHash/i)
  })

  it('rejects a non-DCA order with no pinned calldata at all', async () => {
    const od = { ...(tpBody().orderData as Record<string, unknown>) }
    delete od.routerData
    const { status, json } = await post(tpBody({ orderData: od }))
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/must include the pinned calldata/i)
  })

  it('rejects a non-DCA order carrying ZeroHash (the P1c landmine — could never execute)', async () => {
    const od = { ...(tpBody().orderData as Record<string, unknown>), routerDataHash: ZERO_HASH }
    const { status, json } = await post(tpBody({ routerDataHash: ZERO_HASH, orderData: od }))
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/real routerDataHash|RouterDataRequired/i)
  })

  it('rejects a router that is not in the served set (never widens the whitelist)', async () => {
    const od = { ...(tpBody().orderData as Record<string, unknown>), router: UNSERVED_ROUTER }
    const { status, json } = await post(tpBody({ router: UNSERVED_ROUTER, orderData: od }))
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/not served on chain/i)
  })

  it('rejects order_data whose routerDataHash disagrees with the SIGNED top-level hash (M-07 class)', async () => {
    const otherHash = keccak256('0xdeadbeef')
    const od = { ...(tpBody().orderData as Record<string, unknown>), routerDataHash: otherHash }
    const { status, json } = await post(tpBody({ orderData: od }))
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/order_data mismatch.*routerDataHash/i)
  })

  it('DCA is exempt from the pinned-route requirement (ZeroHash + no calldata is valid)', async () => {
    const { status } = await post(
      tpBody({
        orderType: 'dca',
        priceCondition: 'above',
        priceFeed: '0x0000000000000000000000000000000000000000',
        routerDataHash: ZERO_HASH,
        dcaInterval: 3600,
        dcaTotal: 3,
        orderData: { ...(tpBody().orderData as object), routerDataHash: ZERO_HASH, routerData: undefined },
      }),
    )
    expect(status).toBe(201)
  })

  it('the pinned-route check runs AFTER signature recovery (a bad signature still 400s first)', async () => {
    mockRecover.mockResolvedValue('0x000000000000000000000000000000000000dEaD')
    const { status, json } = await post(tpBody())
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/signature/i)
  })
})
