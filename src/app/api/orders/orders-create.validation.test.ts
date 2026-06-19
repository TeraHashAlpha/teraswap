// @vitest-environment node
/**
 * POST /api/orders — create-order VALIDATION branches + per-chain EIP-712 domain.
 *
 * Complements route.test.ts (which covers the chain-aware fail-closed guard: unwired
 * chain 42161 ⇒ 400, mainnet passes). This file does NOT re-test those; it drives every
 * 400 validation branch plus the per-chain verifyingContract binding (#184) and the
 * happy 201 insert path.
 *
 * Boundaries mocked deterministically:
 *   - @supabase/supabase-js `createClient` → an in-test stub (no network).
 *   - viem `recoverTypedDataAddress` → controllable (default: returns the wallet so the
 *     signature check passes; per-test we assert the domain it was called with).
 *   - `zeroHash` and the rest of viem are preserved via importActual.
 *   - Time is frozen with vi.setSystemTime so expiry math is deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── viem mock — keep everything real except recoverTypedDataAddress ──
const mockRecover = vi.fn()
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return {
    ...actual,
    recoverTypedDataAddress: (...args: unknown[]) => mockRecover(...args),
  }
})

// ── supabase mock — createClient returns a controllable stub ──
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

import { POST } from './route'
import { NATIVE_ETH } from '@/lib/constants'
import { getWrappedNative } from '@/lib/chains/registry'

// Mainnet executor (byte-identical to ORDER_EXECUTOR_BY_CHAIN[1]).
const MAINNET_EXECUTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'

const WALLET = '0x1111111111111111111111111111111111111111'
const TOKEN_IN = '0x2222222222222222222222222222222222222222'
const TOKEN_OUT = '0x3333333333333333333333333333333333333333'
const ROUTER = '0x4444444444444444444444444444444444444444'
const PRICE_FEED = '0x5555555555555555555555555555555555555555'
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const SIG = '0x' + 'cc'.repeat(65) // 130 hex chars

// Frozen clock: 2026-06-17T00:00:00Z. Used for all expiry math.
const NOW_MS = Date.UTC(2026, 5, 17, 0, 0, 0)
const NOW_S = Math.floor(NOW_MS / 1000)

const ENV0 = { ...process.env }
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  // getSupabase() must resolve to a client so requests reach validation, not the 503.
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'
  process.env.CHAIN_ID = '1' // mainnet — byte-identical behaviour
  // Default: signature recovers to the wallet (passes) and DB returns a row.
  mockRecover.mockResolvedValue(WALLET)
  mockRpc.mockResolvedValue({ data: true })
  mockSingle.mockResolvedValue({ data: { id: 'order-uuid-1' }, error: null })
})
afterEach(() => {
  vi.useRealTimers()
  process.env = { ...ENV0 }
})

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    wallet: WALLET,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    router: ROUTER,
    signature: SIG,
    orderHash: '0x' + 'ab'.repeat(32),
    amountIn: '1000000000000000000',
    minAmountOut: '0',
    orderType: 'limit',
    priceCondition: 'above',
    targetPrice: '1000',
    priceFeed: PRICE_FEED,
    expiry: NOW_S + 3600, // 1h in the future
    nonce: 0,
    routerDataHash: '0x' + '00'.repeat(32),
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

// ── Address validation ──────────────────────────────────────
describe('POST /api/orders — address validation', () => {
  for (const field of ['wallet', 'tokenIn', 'tokenOut', 'router'] as const) {
    it(`invalid ${field} address → 400 "Invalid ${field} address"`, async () => {
      const { status, json } = await post(validBody({ [field]: '0xnot-an-address' }))
      expect(status).toBe(400)
      expect(json.error).toBe(`Invalid ${field} address`)
    })
    it(`missing ${field} → 400 "Invalid ${field} address"`, async () => {
      const body = validBody()
      delete (body as Record<string, unknown>)[field]
      const { status, json } = await post(body)
      expect(status).toBe(400)
      expect(json.error).toBe(`Invalid ${field} address`)
    })
  }

  it('checksummed-but-valid-hex address passes the address gate (recover never blocks here)', async () => {
    // 40 hex chars — ADDRESS_RE is case-insensitive, so this must NOT be rejected as invalid.
    const { status } = await post(validBody({ wallet: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' }))
    // recover returns WALLET (mismatch) → 400 "Signature mismatch", NOT an address error.
    expect(status).toBe(400)
  })
})

// ── Signature presence + format ─────────────────────────────
describe('POST /api/orders — signature validation', () => {
  it('missing signature → 400 "Missing signature or orderHash"', async () => {
    const body = validBody()
    delete (body as Record<string, unknown>).signature
    const { status, json } = await post(body)
    expect(status).toBe(400)
    expect(json.error).toBe('Missing signature or orderHash')
  })

  it('missing orderHash → 400 "Missing signature or orderHash"', async () => {
    const body = validBody()
    delete (body as Record<string, unknown>).orderHash
    const { status, json } = await post(body)
    expect(status).toBe(400)
    expect(json.error).toBe('Missing signature or orderHash')
  })

  it('signature wrong length (too short) → 400 "Invalid signature format"', async () => {
    const { status, json } = await post(validBody({ signature: '0x' + 'cc'.repeat(64) }))
    expect(status).toBe(400)
    expect(json.error).toBe('Invalid signature format')
  })

  it('signature with non-hex chars → 400 "Invalid signature format"', async () => {
    const { status, json } = await post(validBody({ signature: '0x' + 'zz'.repeat(65) }))
    expect(status).toBe(400)
    expect(json.error).toBe('Invalid signature format')
  })
})

// ── amountIn validation ─────────────────────────────────────
describe('POST /api/orders — amountIn validation', () => {
  it("amountIn '0' → 400 \"amountIn must be positive\"", async () => {
    const { status, json } = await post(validBody({ amountIn: '0' }))
    expect(status).toBe(400)
    expect(json.error).toBe('amountIn must be positive')
  })

  it('missing amountIn → 400 "amountIn must be positive"', async () => {
    const body = validBody()
    delete (body as Record<string, unknown>).amountIn
    const { status, json } = await post(body)
    expect(status).toBe(400)
    expect(json.error).toBe('amountIn must be positive')
  })

  it('amountIn below MIN_ORDER_AMOUNT (9999) → 400 with minimum "10000"', async () => {
    const { status, json } = await post(validBody({ amountIn: '9999' }))
    expect(status).toBe(400)
    expect(json.error).toMatch(/below minimum/i)
    expect(json.minimum).toBe('10000')
  })

  it('amountIn exactly MIN_ORDER_AMOUNT (10000) passes the minimum gate', async () => {
    // 10000 == MIN, not < MIN. Should proceed past this branch (and reach signature/insert).
    const { status } = await post(validBody({ amountIn: '10000' }))
    expect(status).toBe(201) // recover→WALLET passes, insert returns a row
  })

  it('non-numeric amountIn ("abc") → 400 "Invalid amountIn: must be a numeric string"', async () => {
    const { status, json } = await post(validBody({ amountIn: 'abc' }))
    expect(status).toBe(400)
    expect(json.error).toBe('Invalid amountIn: must be a numeric string')
  })
})

// ── expiry validation ───────────────────────────────────────
describe('POST /api/orders — expiry validation (frozen clock)', () => {
  it('expiry in the past → 400 "Expiry must be in the future"', async () => {
    const { status, json } = await post(validBody({ expiry: NOW_S - 1 }))
    expect(status).toBe(400)
    expect(json.error).toBe('Expiry must be in the future')
  })

  it('expiry == now → 400 (must be strictly in the future)', async () => {
    const { status, json } = await post(validBody({ expiry: NOW_S }))
    expect(status).toBe(400)
    expect(json.error).toBe('Expiry must be in the future')
  })

  it('expiry beyond 90 days → 400 "Expiry cannot exceed 90 days"', async () => {
    const beyond = NOW_S + 90 * 86400 + 10
    const { status, json } = await post(validBody({ expiry: beyond }))
    expect(status).toBe(400)
    expect(json.error).toBe('Expiry cannot exceed 90 days')
  })
})

// ── DCA validation ──────────────────────────────────────────
describe('POST /api/orders — DCA validation', () => {
  function dcaBody(overrides: Record<string, unknown> = {}) {
    return validBody({
      orderType: 'dca',
      priceFeed: ZERO_ADDR, // DCA may skip the price condition
      dcaInterval: 3600,
      dcaTotal: 10,
      amountIn: '1000000', // 1e6 / 10 = 1e5 >= MIN(1e4)
      ...overrides,
    })
  }

  it('dcaInterval < 60 → 400 "DCA interval must be ≥ 60s"', async () => {
    const { status, json } = await post(dcaBody({ dcaInterval: 59 }))
    expect(status).toBe(400)
    expect(json.error).toBe('DCA interval must be ≥ 60s')
  })

  it('dcaTotal < 2 → 400 "DCA must have 2-365 executions"', async () => {
    const { status, json } = await post(dcaBody({ dcaTotal: 1 }))
    expect(status).toBe(400)
    expect(json.error).toBe('DCA must have 2-365 executions')
  })

  it('dcaTotal > 365 → 400 "DCA must have 2-365 executions"', async () => {
    const { status, json } = await post(dcaBody({ dcaTotal: 366 }))
    expect(status).toBe(400)
    expect(json.error).toBe('DCA must have 2-365 executions')
  })

  it('per-chunk amount below MIN (amountIn 100000 / dcaTotal 20 = 5000) → 400 "DCA chunk amount below minimum"', async () => {
    const { status, json } = await post(dcaBody({ amountIn: '100000', dcaTotal: 20 }))
    expect(status).toBe(400)
    expect(json.error).toMatch(/DCA chunk amount below minimum/i)
    expect(json.minimum).toBe('10000')
    expect(json.chunkAmount).toBe('5000')
  })

  it('per-chunk amount exactly at MIN passes the DCA chunk gate', async () => {
    // 200000 / 20 = 10000 == MIN → not below, proceeds to 201.
    const { status } = await post(dcaBody({ amountIn: '200000', dcaTotal: 20 }))
    expect(status).toBe(201)
  })
})

// ── token sameness + price feed ─────────────────────────────
describe('POST /api/orders — token & price-feed validation', () => {
  it('tokenIn === tokenOut → 400 "tokenIn and tokenOut must differ"', async () => {
    const { status, json } = await post(validBody({ tokenOut: TOKEN_IN }))
    expect(status).toBe(400)
    expect(json.error).toBe('tokenIn and tokenOut must differ')
  })

  it('tokenIn === tokenOut differing only by case still rejected (case-insensitive)', async () => {
    const { status, json } = await post(validBody({ tokenOut: TOKEN_IN.toUpperCase().replace('0X', '0x') }))
    expect(status).toBe(400)
    expect(json.error).toBe('tokenIn and tokenOut must differ')
  })

  it('priceFeed wrong length → 400 "Invalid or missing Chainlink price feed address"', async () => {
    const { status, json } = await post(validBody({ priceFeed: '0x1234' }))
    expect(status).toBe(400)
    expect(json.error).toBe('Invalid or missing Chainlink price feed address')
  })

  it('priceFeed missing → 400 "Invalid or missing Chainlink price feed address"', async () => {
    const body = validBody()
    delete (body as Record<string, unknown>).priceFeed
    const { status, json } = await post(body)
    expect(status).toBe(400)
    expect(json.error).toBe('Invalid or missing Chainlink price feed address')
  })

  it('non-DCA order with zero-address priceFeed → 400 "require a Chainlink price feed"', async () => {
    const { status, json } = await post(validBody({ orderType: 'limit', priceFeed: ZERO_ADDR }))
    expect(status).toBe(400)
    expect(json.error).toMatch(/require a Chainlink price feed/i)
  })
})

// ── native-ETH input rejection [CHORE-DCA-WETH-INPUT] ───────
describe('POST /api/orders — native-ETH input rejected (CHORE-DCA-WETH-INPUT)', () => {
  const REJECT_MSG = 'Use WETH (not native ETH) as the order input'

  for (const orderType of ['limit', 'stop_loss', 'dca'] as const) {
    it(`${orderType}: tokenIn === native ETH sentinel → 400 "${REJECT_MSG}"`, async () => {
      const extra =
        orderType === 'dca'
          ? { priceFeed: ZERO_ADDR, dcaInterval: 3600, dcaTotal: 10, amountIn: '1000000' }
          : {}
      const { status, json } = await post(validBody({ orderType, tokenIn: NATIVE_ETH, ...extra }))
      expect(status).toBe(400)
      expect(json.error).toBe(REJECT_MSG)
      // Fail-closed before any DB work.
      expect(mockInsert).not.toHaveBeenCalled()
    })
  }

  it('lowercased native sentinel is still rejected (case-insensitive)', async () => {
    const { status, json } = await post(validBody({ tokenIn: NATIVE_ETH.toLowerCase() }))
    expect(status).toBe(400)
    expect(json.error).toBe(REJECT_MSG)
  })

  it('uppercased native sentinel is still rejected (case-insensitive)', async () => {
    const { status, json } = await post(
      validBody({ tokenIn: ('0x' + NATIVE_ETH.slice(2).toUpperCase()) }),
    )
    expect(status).toBe(400)
    expect(json.error).toBe(REJECT_MSG)
  })

  it('native ETH as tokenOUT is NOT rejected by this gate (output may be native ETH)', async () => {
    // tokenOut native, tokenIn a normal ERC-20 → passes the native-input gate → reaches 201.
    const { status } = await post(validBody({ tokenOut: NATIVE_ETH }))
    expect(status).toBe(201)
  })

  it('WETH tokenIn is NOT rejected by the native gate (proceeds to 201)', async () => {
    const { status } = await post(validBody({ tokenIn: getWrappedNative(1) }))
    expect(status).toBe(201)
  })
})

// ── Per-chain EIP-712 verifyingContract (#184) ──────────────
describe('POST /api/orders — per-chain EIP-712 domain binding (#184)', () => {
  it('CHAIN_ID=1: recoverTypedDataAddress receives mainnet executor as verifyingContract AND chainId 1', async () => {
    process.env.CHAIN_ID = '1'
    await post(validBody())
    expect(mockRecover).toHaveBeenCalledTimes(1)
    const arg = mockRecover.mock.calls[0][0] as {
      domain: { name: string; version: string; chainId: number; verifyingContract: string }
      primaryType: string
    }
    expect(arg.domain.verifyingContract).toBe(MAINNET_EXECUTOR)
    expect(arg.domain.chainId).toBe(1)
    expect(arg.domain.name).toBe('TeraSwapOrderExecutor')
    expect(arg.domain.version).toBe('2')
    expect(arg.primaryType).toBe('Order')
  })

  it('recovered === wallet → proceeds to 201 (happy path)', async () => {
    mockRecover.mockResolvedValue(WALLET)
    const { status, json } = await post(validBody())
    expect(status).toBe(201)
    expect(json.order).toEqual({ id: 'order-uuid-1' })
    // rate-limit RPC consulted, insert performed.
    expect(mockRpc).toHaveBeenCalledWith('check_order_rate_limit', expect.objectContaining({
      p_wallet: WALLET.toLowerCase(),
    }))
    expect(mockInsert).toHaveBeenCalledTimes(1)
  })

  it('recovered is a DIFFERENT address → 400 "Signature mismatch"', async () => {
    mockRecover.mockResolvedValue('0x9999999999999999999999999999999999999999')
    const { status, json } = await post(validBody())
    expect(status).toBe(400)
    expect(json.error).toBe('Signature mismatch')
    // never reached the DB on a mismatch
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('recover throws → 400 "Signature verification failed: <msg>"', async () => {
    mockRecover.mockRejectedValue(new Error('bad sig'))
    const { status, json } = await post(validBody())
    expect(status).toBe(400)
    expect(json.error).toBe('Signature verification failed: bad sig')
  })

  it('orderType enum + condition enum are encoded into the recovered message', async () => {
    await post(validBody({ orderType: 'stop_loss', priceCondition: 'below' }))
    const arg = mockRecover.mock.calls[0][0] as { message: { orderType: number; condition: number } }
    expect(arg.message.orderType).toBe(1) // stop_loss → 1
    expect(arg.message.condition).toBe(1) // below → 1
  })
})

// ── order_data blob cross-validation [M-07] ─────────────────
describe('POST /api/orders — order_data blob mismatch [M-07]', () => {
  function odBody(odOverrides: Record<string, unknown> = {}) {
    return validBody({
      orderData: {
        owner: WALLET,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: '1000000000000000000',
        minAmountOut: '0',
        router: ROUTER,
        ...odOverrides,
      },
    })
  }

  it('order_data.tokenIn differs from top-level → 400 "order_data mismatch"', async () => {
    const { status, json } = await post(
      odBody({ tokenIn: '0x7777777777777777777777777777777777777777' }),
    )
    expect(status).toBe(400)
    expect(json.error).toMatch(/order_data mismatch/i)
    expect(json.error).toMatch(/tokenIn/)
  })

  it('order_data.amountIn differs from top-level → 400 "order_data mismatch"', async () => {
    const { status, json } = await post(odBody({ amountIn: '999' }))
    expect(status).toBe(400)
    expect(json.error).toMatch(/order_data mismatch/i)
    expect(json.error).toMatch(/amountIn/)
  })

  it('order_data matching every field → proceeds to 201', async () => {
    const { status } = await post(odBody())
    expect(status).toBe(201)
  })
})
