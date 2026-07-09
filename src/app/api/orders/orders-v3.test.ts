// @vitest-environment node
/**
 * [SPRINT-V3-P2 / ADR-013 §1] POST /api/orders — v3 order validation branch.
 *
 * Separate from orders-create.validation.test.ts (which proves the v2 path is byte-identical
 * — no test there sets maxSlippageBps). Mocks getOrderExecutorV3/getOrderExecutorV3Domain to
 * simulate v3 "deployed" on mainnet for this file only (real config.ts has it null everywhere).
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
const ROUTER = '0x4444444444444444444444444444444444444444'
const SIG = '0x' + 'cc'.repeat(65)
const ZERO_HASH = '0x' + '00'.repeat(32)

const NOW_MS = Date.UTC(2026, 6, 9, 0, 0, 0)
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
  // Default: the output token prices comfortably above the dust floor via DefiLlama.
  mockFetchDefiLlamaPrice.mockResolvedValue({ price: 1, symbol: 'USDC', timestamp: 0, confidence: 1 })
  mockComputeTokenAmountUsd.mockResolvedValue(null)
  // [SPRINT-V3-P3 / M-01] Default: the on-chain read agrees with v3Body()'s tokenOutDecimals: 18.
  mockFetchErc20Decimals.mockResolvedValue(18)
})
afterEach(() => {
  vi.useRealTimers()
  process.env = { ...ENV0 }
})

function v3Body(overrides: Record<string, unknown> = {}) {
  return {
    wallet: WALLET,
    chainId: 1,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    router: ROUTER,
    signature: SIG,
    orderHash: '0x' + 'ab'.repeat(32),
    amountIn: '1000000000000000000',
    // 100 raw units of an 18dp token @ $1 ⇒ way below $1 — DustFloor default is $5 (see below
    // per-test overrides for the "clears the floor" case).
    minAmountOut: (100n * 10n ** 18n).toString(), // $100 worth at $1/token — clears $5 default
    tokenOutDecimals: 18,
    orderType: 'dca',
    priceCondition: 'above',
    targetPrice: '0',
    priceFeed: '0x0000000000000000000000000000000000000000',
    expiry: NOW_S + 3600,
    nonce: 0,
    routerDataHash: ZERO_HASH,
    dcaInterval: 3600,
    dcaTotal: 3,
    maxSlippageBps: 300,
    ...overrides,
  }
}
function req(body: unknown) {
  return new NextRequest('http://localhost/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
async function post(body: unknown) {
  const res = await POST(req(body))
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('POST /api/orders — v3 maxSlippageBps validation', () => {
  it('maxSlippageBps 0 → 400', async () => {
    const { status, json } = await post(v3Body({ maxSlippageBps: 0 }))
    expect(status).toBe(400)
    expect(json.error).toMatch(/maxSlippageBps/)
  })

  it('maxSlippageBps 501 (> the 500 cap) → 400', async () => {
    const { status, json } = await post(v3Body({ maxSlippageBps: 501 }))
    expect(status).toBe(400)
    expect(json.error).toMatch(/maxSlippageBps/)
  })

  it('maxSlippageBps 500 (exactly the cap) is accepted', async () => {
    const { status } = await post(v3Body({ maxSlippageBps: 500 }))
    expect(status).toBe(201)
  })

  it('a body WITHOUT maxSlippageBps is treated as v2 — unaffected by v3 validation', async () => {
    const body = v3Body()
    delete (body as Record<string, unknown>).maxSlippageBps
    // minAmountOut for this v2-shaped body is huge (100 tokens) — still fine, v2 has no dust check.
    const { status } = await post(body)
    expect(status).toBe(201)
    // Verify it signed under the v2 domain (version "2"), not v3.
    const recoverArg = mockRecover.mock.calls[0][0] as { domain: { version: string } }
    expect(recoverArg.domain.version).toBe('2')
  })
})

describe('POST /api/orders — v3 chain resolution (fail-closed)', () => {
  it('a v3 order on an unconfigured chain (8453) → 400, never falls back to v2', async () => {
    const { status, json } = await post(v3Body({ chainId: 8453 }))
    expect(status).toBe(400)
    expect(json.error).toMatch(/v3 conditional orders are not yet available/i)
  })

  it('signs/recovers under the v3 domain (version "3") + verifyingContract on the configured chain', async () => {
    await post(v3Body())
    const recoverArg = mockRecover.mock.calls[0][0] as { domain: { version: string; verifyingContract: string } }
    expect(recoverArg.domain.version).toBe('3')
    expect(recoverArg.domain.verifyingContract).toBe(V3_MAINNET)
  })

  it('the recovered message includes maxSlippageBps for a v3 order', async () => {
    await post(v3Body({ maxSlippageBps: 250 }))
    const recoverArg = mockRecover.mock.calls[0][0] as { message: { maxSlippageBps?: number } }
    expect(recoverArg.message.maxSlippageBps).toBe(250)
  })
})

describe('POST /api/orders — v3 USD dust floor (I-01/L-01 closure)', () => {
  it('unpriceable on BOTH DefiLlama and Chainlink → 422, fail-closed', async () => {
    mockFetchDefiLlamaPrice.mockResolvedValue(null)
    mockComputeTokenAmountUsd.mockResolvedValue(null)
    const { status, json } = await post(v3Body())
    expect(status).toBe(422)
    expect(json.unpriceable).toBe(true)
  })

  it('priced but below the dust floor ($5 default) → 400', async () => {
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 1, symbol: 'X', timestamp: 0, confidence: 1 })
    // 1 raw unit of an 18dp token @ $1 ≈ $0 (dust).
    const { status, json } = await post(v3Body({ minAmountOut: '1' }))
    expect(status).toBe(400)
    expect(json.error).toMatch(/below the \$5/)
  })

  it('priced comfortably above the dust floor via DefiLlama → passes', async () => {
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 1, symbol: 'X', timestamp: 0, confidence: 1 })
    const { status } = await post(v3Body({ minAmountOut: (100n * 10n ** 18n).toString() }))
    expect(status).toBe(201)
  })

  it('priced above the dust floor via server Chainlink (DefiLlama unavailable) → passes', async () => {
    mockFetchDefiLlamaPrice.mockResolvedValue(null)
    mockComputeTokenAmountUsd.mockResolvedValue({ usd: 100, price: 1, decimals: 18 })
    const { status } = await post(v3Body())
    expect(status).toBe(201)
  })

  it('a v2 order (no maxSlippageBps) is NEVER dust-checked, even with a 1-wei minAmountOut', async () => {
    const body = v3Body({ minAmountOut: '1' })
    delete (body as Record<string, unknown>).maxSlippageBps
    mockFetchDefiLlamaPrice.mockResolvedValue(null)
    mockComputeTokenAmountUsd.mockResolvedValue(null)
    const { status } = await post(body)
    expect(status).toBe(201)
  })
})

describe('POST /api/orders — v3 M-01 fix: on-chain decimals + min-combine [SPRINT-V3-P3]', () => {
  it('the audit exploit: spoofed HIGH tokenOutDecimals on a DefiLlama-priced/no-feed token is REJECTED', async () => {
    // Real on-chain decimals = 18 (a normal ERC-20); no Chainlink feed (no-feed class); DefiLlama
    // prices it at $1. The client claims tokenOutDecimals=30 to manipulate the USD conversion.
    mockFetchErc20Decimals.mockResolvedValue(18)
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 1, symbol: 'X', timestamp: 0, confidence: 1 })
    mockComputeTokenAmountUsd.mockResolvedValue(null)
    const { status, json } = await post(v3Body({ tokenOutDecimals: 30 }))
    expect(status).toBe(422)
    expect(json.error).toMatch(/tokenOutDecimals mismatch/)
    expect(json.error).toMatch(/claimed 30/)
    expect(json.error).toMatch(/on-chain reports 18/)
  })

  it('spoofed LOW tokenOutDecimals (the inflate-value direction) is equally rejected', async () => {
    mockFetchErc20Decimals.mockResolvedValue(18)
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 1, symbol: 'X', timestamp: 0, confidence: 1 })
    mockComputeTokenAmountUsd.mockResolvedValue(null)
    const { status, json } = await post(v3Body({ tokenOutDecimals: 6 }))
    expect(status).toBe(422)
    expect(json.error).toMatch(/tokenOutDecimals mismatch/)
  })

  it('a correct (non-spoofed) tokenOutDecimals passes the decimals check', async () => {
    mockFetchErc20Decimals.mockResolvedValue(18)
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 1, symbol: 'X', timestamp: 0, confidence: 1 })
    mockComputeTokenAmountUsd.mockResolvedValue(null)
    const { status } = await post(v3Body({ tokenOutDecimals: 18 }))
    expect(status).toBe(201)
  })

  it('on-chain decimals cannot be read at all → 422 fail-closed (never falls back to the client value)', async () => {
    mockFetchErc20Decimals.mockResolvedValue(null)
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 1, symbol: 'X', timestamp: 0, confidence: 1 })
    const { status, json } = await post(v3Body())
    expect(status).toBe(422)
    expect(json.unpriceable).toBe(true)
  })

  it('min-combine: a generous DefiLlama estimate cannot rescue a dust order when Chainlink prices it low', async () => {
    mockFetchErc20Decimals.mockResolvedValue(18)
    // DefiLlama optimistic: $100 (well above the $5 floor).
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 100, symbol: 'X', timestamp: 0, confidence: 1 })
    // Server Chainlink: the SAME raw amount is worth only $0.001 (genuinely dust).
    mockComputeTokenAmountUsd.mockResolvedValue({ usd: 0.001, price: 0.00001, decimals: 18 })
    const { status, json } = await post(v3Body({ minAmountOut: (1n * 10n ** 18n).toString() }))
    expect(status).toBe(400)
    expect(json.error).toMatch(/below the \$5/)
  })

  it('min-combine: BOTH legs must clear the floor — the lower of the two decides, not the higher', async () => {
    mockFetchErc20Decimals.mockResolvedValue(18)
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 6, symbol: 'X', timestamp: 0, confidence: 1 })  // $6/unit
    mockComputeTokenAmountUsd.mockResolvedValue({ usd: 6, price: 6, decimals: 18 })  // also $6
    const { status } = await post(v3Body({ minAmountOut: (1n * 10n ** 18n).toString() }))
    expect(status).toBe(201) // both legs clear $5
  })
})

describe('POST /api/orders — v3 order_data cross-validation (M-07 extension)', () => {
  it('orderData.maxSlippageBps mismatching the top-level field → 400', async () => {
    const body = v3Body({
      orderData: {
        owner: WALLET, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, router: ROUTER,
        amountIn: '1000000000000000000', minAmountOut: (100n * 10n ** 18n).toString(),
        maxSlippageBps: 999, // mismatch vs top-level 300
      },
    })
    const { status, json } = await post(body)
    expect(status).toBe(400)
    expect(json.error).toMatch(/maxSlippageBps/)
  })

  it('orderData.maxSlippageBps matching the top-level field passes', async () => {
    const body = v3Body({
      orderData: {
        owner: WALLET, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, router: ROUTER,
        amountIn: '1000000000000000000', minAmountOut: (100n * 10n ** 18n).toString(),
        maxSlippageBps: 300,
      },
    })
    const { status } = await post(body)
    expect(status).toBe(201)
  })
})
