// @vitest-environment jsdom
/**
 * [SPRINT-ORDER-ENGINE-TESTS #5] useOrderEngine — conditional-order / DCA param,
 * price-condition, and expiry BUILD logic (client side).
 *
 * NOTE ON SCOPE: the spec named `src/hooks/useConditionalOrder.ts`, which does
 * NOT exist in this repo. The conditional-order / DCA param-building logic
 * actually lives inside `useOrderEngine.ts` — specifically Phase A `createOrder`,
 * which builds + FREEZES the `OnChainOrder` struct from a `CreateOrderConfig`,
 * and the Supabase mapping in Phase B `confirmOrder`. We cover it here.
 *
 * The hook exposes NO standalone pure helpers for this (computeOrderHash,
 * expiry math, condition/DCA mapping are all closed over inside the hook), so
 * the only honest way to exercise the specific branches is via renderHook ->
 * createOrder (freeze) -> inspect `pendingOrder.order` and -> confirmOrder
 * (sign + submit) -> inspect the signed EIP-712 message + the Supabase args.
 *
 * This file intentionally targets the branches the existing
 * `useOrderEngine.test.ts` does NOT cover:
 *   - PriceCondition.BELOW (existing suite only ever uses ABOVE), both in the
 *     signed `condition` uint8 AND the Supabase `priceCondition: 'above'|'below'`.
 *   - STOP_LOSS condition encoding.
 *   - DCA: dcaInterval default (0) + custom values flowing into the signed
 *     struct, routerDataHash ZeroHash default for DCA, and the
 *     struct(0n/1n) vs Supabase-arg(null) asymmetry for omitted DCA params.
 *   - expiry math: floor(Date.now()/1000) + expirySeconds, pinned with fake
 *     timers (deterministic), plus the Supabase `expiry` Date round-trip.
 *
 * See the bottom of the file + discoveredBugs for the MIN_ORDER_AMOUNT note:
 * the 10000-wei floor is a CONTRACT-only constant — there is NO client-side
 * floor validation in the hook, so a "just-below rejected" client assertion is
 * not applicable here (documented, not faked).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSignTypedDataAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockWriteContractAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockRefetchNonce = vi.fn<() => Promise<unknown>>()
const mockReadContractImpl = vi.fn<(opts: { functionName: string }) => { data: unknown; isLoading: boolean; refetch: () => Promise<unknown> }>()

const mockCreateOrderInSupabase = vi.fn()
const mockFetchUserOrders = vi.fn()
const mockFetchActiveOrders = vi.fn()
const mockCancelOrderInSupabase = vi.fn()
const mockSubscribeToOrders = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({
    address: '0x1111111111111111111111111111111111111111',
  })),
  useChainId: vi.fn(() => 1),
  useSignTypedData: vi.fn(() => ({
    signTypedDataAsync: mockSignTypedDataAsync,
  })),
  useWriteContract: vi.fn(() => ({
    writeContractAsync: mockWriteContractAsync,
  })),
  useReadContract: vi.fn((opts: { functionName: string }) => mockReadContractImpl(opts)),
}))

// Mock the @/lib/order-engine I/O surface, but keep the REAL enums/constants
// (OrderType, PriceCondition, domain resolvers) so the runtime checks the hook
// performs remain meaningful and byte-identical to mainnet behaviour.
vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return {
    ...actual,
    createOrderInSupabase: (...args: unknown[]) => mockCreateOrderInSupabase(...args),
    fetchUserOrders: (...args: unknown[]) => mockFetchUserOrders(...args),
    fetchActiveOrders: (...args: unknown[]) => mockFetchActiveOrders(...args),
    cancelOrderInSupabase: (...args: unknown[]) => mockCancelOrderInSupabase(...args),
    subscribeToOrders: (...args: unknown[]) => mockSubscribeToOrders(...args),
    ORDER_POLL_INTERVAL_MS: 100,
  }
})

import { renderHook, act } from '@testing-library/react'
import { useOrderEngine } from './useOrderEngine'
import {
  OrderType,
  PriceCondition,
  type CreateOrderConfig,
  type OrderRow,
} from '@/lib/order-engine'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'

// A fixed wall-clock instant so expiry math is fully deterministic.
// 2026-06-17T00:00:00.000Z -> 1781481600 seconds.
const FIXED_NOW_MS = Date.UTC(2026, 5, 17, 0, 0, 0)
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000)

function makeConfig(overrides: Partial<CreateOrderConfig> = {}): CreateOrderConfig {
  return {
    tokenIn: { address: '0x2222222222222222222222222222222222222222', symbol: 'WETH', decimals: 18 },
    tokenOut: { address: '0x3333333333333333333333333333333333333333', symbol: 'USDC', decimals: 6 },
    amountIn: '1000000000000000000',
    minAmountOut: '2900000000',
    orderType: OrderType.LIMIT,
    condition: PriceCondition.ABOVE,
    targetPrice: '300000000000',
    priceFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    expirySeconds: 24 * 60 * 60,
    router: '0x111111125421ca6dc452d289314280a0f8842a65',
    routerDataHash: ('0x' + '11'.repeat(32)) as `0x${string}`,
    ...overrides,
  }
}

function makeRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'row-' + Math.random().toString(36).slice(2),
    wallet: ADDRESS,
    order_hash: ('0x' + 'aa'.repeat(32)) as string,
    order_type: 'limit',
    status: 'active',
    token_in: '0x2222222222222222222222222222222222222222',
    token_out: '0x3333333333333333333333333333333333333333',
    amount_in: '1000000000000000000',
    min_amount_out: '2900000000',
    target_price: '300000000000',
    price_feed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    price_condition: 'above',
    expiry: '0',
    nonce: 0,
    router: '0x111111125421ca6dc452d289314280a0f8842a65',
    dca_interval: null,
    dca_total: null,
    dca_executed: 0,
    signature: FAKE_SIG,
    order_data: {},
    token_in_symbol: 'WETH',
    token_out_symbol: 'USDC',
    token_in_decimals: 18,
    token_out_decimals: 6,
    created_at: new Date().toISOString(),
    executed_at: null,
    amount_out: null,
    tx_hash: null,
    error: null,
    ...overrides,
  } as OrderRow
}

// Two-phase: createOrder FREEZES, confirmOrder SIGNS + SUBMITS. Separate act()
// blocks so the confirmOrder closure sees the freshly-set pendingOrder.
async function createAndConfirm(
  result: { current: { createOrder: (c: CreateOrderConfig) => Promise<void>; confirmOrder: () => Promise<void> } },
  config: CreateOrderConfig = makeConfig(),
) {
  await act(async () => { await result.current.createOrder(config) })
  await act(async () => { await result.current.confirmOrder() })
}

// Helper: last signed EIP-712 message.
function lastSignedMessage() {
  const calls = mockSignTypedDataAsync.mock.calls
  return (calls[calls.length - 1][0] as { message: Record<string, unknown> }).message
}

// Helper: last Supabase create-order arg object.
function lastSupabaseArg() {
  const calls = mockCreateOrderInSupabase.mock.calls
  return calls[calls.length - 1][0] as Record<string, unknown>
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW_MS)
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockWriteContractAsync.mockResolvedValue('0x' + 'ff'.repeat(32))
  mockRefetchNonce.mockResolvedValue({ data: 5n })
  mockReadContractImpl.mockImplementation(({ functionName }) => {
    if (functionName === 'nonces') return { data: 5n, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'invalidatedNonces') return { data: 0n, isLoading: false, refetch: mockRefetchNonce }
    return { data: undefined, isLoading: false, refetch: mockRefetchNonce }
  })
  mockFetchUserOrders.mockResolvedValue([])
  mockFetchActiveOrders.mockResolvedValue([])
  mockCreateOrderInSupabase.mockResolvedValue(makeRow())
  mockCancelOrderInSupabase.mockResolvedValue(undefined)
  mockSubscribeToOrders.mockReturnValue(vi.fn())
})

afterEach(() => {
  vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────
// Price condition mapping: enum uint8 (0/1) + Supabase 'above'/'below' string.
// The existing suite ONLY ever uses ABOVE — these pin BOTH directions and the
// derived string, which is the field the executor reads to decide trigger side.
// ─────────────────────────────────────────────────────────────
describe('useOrderEngine — price-condition mapping (ABOVE/BELOW)', () => {
  it('encodes ABOVE as condition uint8 0 in the FROZEN struct, signed message, and Supabase "above"', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await result.current.createOrder(makeConfig({ condition: PriceCondition.ABOVE })) })
    // Frozen struct carries the raw enum (0).
    expect(result.current.pendingOrder!.order.condition).toBe(PriceCondition.ABOVE)
    expect(Number(result.current.pendingOrder!.order.condition)).toBe(0)

    await act(async () => { await result.current.confirmOrder() })
    // Signed uint8 is the enum value 0.
    expect(Number(lastSignedMessage().condition)).toBe(0)
    // Supabase derived string mirrors the enum.
    expect(lastSupabaseArg().priceCondition).toBe('above')
  })

  it('encodes BELOW as condition uint8 1 in the FROZEN struct, signed message, and Supabase "below"', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await result.current.createOrder(makeConfig({ condition: PriceCondition.BELOW })) })
    expect(result.current.pendingOrder!.order.condition).toBe(PriceCondition.BELOW)
    expect(Number(result.current.pendingOrder!.order.condition)).toBe(1)

    await act(async () => { await result.current.confirmOrder() })
    expect(Number(lastSignedMessage().condition)).toBe(1)
    // The mapping is `=== PriceCondition.ABOVE ? 'above' : 'below'` — BELOW must
    // become 'below', never silently default to 'above'.
    expect(lastSupabaseArg().priceCondition).toBe('below')
  })

  it('a STOP_LOSS BELOW order encodes orderType=1 + condition=1 and keeps the chosen priceFeed', async () => {
    const feed = '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' // BTC/USD
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(
      result,
      makeConfig({ orderType: OrderType.STOP_LOSS, condition: PriceCondition.BELOW, priceFeed: feed }),
    )
    const msg = lastSignedMessage()
    expect(Number(msg.orderType)).toBe(1) // STOP_LOSS
    expect(Number(msg.condition)).toBe(1) // BELOW
    expect(msg.priceFeed).toBe(feed)
    // Supabase orderType label for STOP_LOSS is 'stop_loss' (not 'limit'/'dca').
    expect(lastSupabaseArg().orderType).toBe('stop_loss')
    expect(lastSupabaseArg().priceCondition).toBe('below')
  })
})

// ─────────────────────────────────────────────────────────────
// Expiry handling: expiry = floor(Date.now()/1000) + expirySeconds.
// Pinned to a fixed clock so the exact bigint is asserted deterministically.
// ─────────────────────────────────────────────────────────────
describe('useOrderEngine — expiry math (preset seconds -> absolute unix expiry)', () => {
  it('computes expiry as floor(now/1000) + expirySeconds (24h preset)', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await result.current.createOrder(makeConfig({ expirySeconds: 86_400 })) })
    const expiry = result.current.pendingOrder!.order.expiry
    expect(expiry).toBe(BigInt(FIXED_NOW_SEC + 86_400))
    // The frozen review exposes the absolute deadline; it must be strictly in
    // the future relative to the pinned clock (otherwise confirmOrder rejects).
    expect(expiry).toBeGreaterThan(BigInt(FIXED_NOW_SEC))
  })

  it('1h vs 90d presets produce expiries that differ by exactly the preset delta', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await result.current.createOrder(makeConfig({ expirySeconds: 3_600 })) })
    const oneHour = result.current.pendingOrder!.order.expiry
    await act(async () => { await result.current.createOrder(makeConfig({ expirySeconds: 7_776_000 })) })
    const ninetyDays = result.current.pendingOrder!.order.expiry
    expect(oneHour).toBe(BigInt(FIXED_NOW_SEC + 3_600))
    expect(ninetyDays).toBe(BigInt(FIXED_NOW_SEC + 7_776_000))
    expect(ninetyDays - oneHour).toBe(7_776_000n - 3_600n)
  })

  it('confirmOrder maps the unix expiry back to a Date (expiry*1000) for the Supabase row', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig({ expirySeconds: 86_400 }))
    const expiryArg = lastSupabaseArg().expiry as Date
    expect(expiryArg).toBeInstanceOf(Date)
    // expiry seconds -> ms; byte-identical to Number(order.expiry) * 1000.
    expect(expiryArg.getTime()).toBe((FIXED_NOW_SEC + 86_400) * 1000)
    // expiresAt on the UI order also derives from the same unix value.
    expect(result.current.orders[0].expiresAt).toBe((FIXED_NOW_SEC + 86_400) * 1000)
  })

  it('confirmOrder fail-safes (no signature) when the frozen expiry already passed', async () => {
    // Freshness guard: a review that sat open past its expiry must never be
    // signed (it could never trigger). This complements the existing
    // negative-expirySeconds test with an expiry that lapses AFTER freezing,
    // driven purely by advancing the fake clock — no wall-clock dependence.
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await result.current.createOrder(makeConfig({ expirySeconds: 10 })) })
    expect(result.current.pendingOrder).toBeTruthy()
    // Advance past the 10s expiry while the review sits open.
    vi.setSystemTime(FIXED_NOW_MS + 11_000)
    await act(async () => { await result.current.confirmOrder() })
    expect(mockSignTypedDataAsync).not.toHaveBeenCalled()
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()
    expect(result.current.pendingOrder).toBeNull()
    expect(result.current.latestEvent?.type).toBe('order_error')
  })
})

// ─────────────────────────────────────────────────────────────
// DCA param building: interval default 0, total default 1, routerDataHash
// ZeroHash default, custom values, and the struct(bigint) vs Supabase-arg(null)
// asymmetry for OMITTED params. The existing suite covers ONLY dcaTotal=1.
// ─────────────────────────────────────────────────────────────
describe('useOrderEngine — DCA param building', () => {
  it('defaults dcaInterval to 0n in the frozen struct when omitted', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await result.current.createOrder(makeConfig()) }) // no dcaInterval
    expect(result.current.pendingOrder!.order.dcaInterval).toBe(0n)
    expect(result.current.pendingOrder!.order.dcaTotal).toBe(1n) // existing-suite parity, asserted on the frozen struct
  })

  it('carries custom dcaInterval + dcaTotal as bigints into the frozen struct AND the signed message', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(
      result,
      makeConfig({ orderType: OrderType.DCA, dcaInterval: 86_400, dcaTotal: 7, routerDataHash: undefined }),
    )
    const msg = lastSignedMessage()
    expect(msg.dcaInterval).toBe(86_400n)
    expect(msg.dcaTotal).toBe(7n)
    expect(Number(msg.orderType)).toBe(2) // DCA
  })

  it('defaults routerDataHash to ZeroHash for a DCA order that omits it (calldata varies per execution) [C-01]', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(
        makeConfig({ orderType: OrderType.DCA, dcaInterval: 3_600, dcaTotal: 5, routerDataHash: undefined }),
      )
    })
    // ZeroHash is the explicit default in the struct builder.
    expect(result.current.pendingOrder!.order.routerDataHash).toBe(ZERO_HASH)
    await act(async () => { await result.current.confirmOrder() })
    expect(lastSignedMessage().routerDataHash).toBe(ZERO_HASH)
  })

  it('preserves a caller-supplied routerDataHash (does NOT zero it out)', async () => {
    const hash = ('0x' + '7e'.repeat(32)) as `0x${string}`
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await result.current.createOrder(makeConfig({ routerDataHash: hash })) })
    expect(result.current.pendingOrder!.order.routerDataHash).toBe(hash)
  })

  it('serialises DCA bigints to strings in the Supabase orderData snapshot', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(
      result,
      makeConfig({ orderType: OrderType.DCA, dcaInterval: 43_200, dcaTotal: 10, routerDataHash: undefined }),
    )
    const orderData = lastSupabaseArg().orderData as Record<string, unknown>
    // orderData mirrors the SIGNED struct but BigInt -> string (JSON-safe).
    expect(orderData.dcaInterval).toBe('43200')
    expect(orderData.dcaTotal).toBe('10')
    expect(typeof orderData.dcaInterval).toBe('string')
  })

  it('[Fix 2] persists OMITTED DCA params matching the SIGNED struct (0 / 1), not null', async () => {
    // The signed struct is canonical (the orderHash binds it). The persisted
    // top-level dca fields must equal exactly what was signed — no second,
    // different default on the write path. For an omitted-DCA (LIMIT) order the
    // struct defaults to dcaInterval 0n / dcaTotal 1n.
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig()) // LIMIT, no DCA fields
    const arg = lastSupabaseArg()
    const orderData = arg.orderData as Record<string, unknown>
    // top-level Supabase args === signed struct (0 / 1) === the orderData snapshot.
    expect(arg.dcaInterval).toBe(0)
    expect(arg.dcaTotal).toBe(1)
    expect(String(arg.dcaInterval)).toBe(orderData.dcaInterval)
    expect(String(arg.dcaTotal)).toBe(orderData.dcaTotal)
  })

  it('[Fix 2] persists a real DCA order’s params matching the signed struct', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(
      result,
      makeConfig({ orderType: OrderType.DCA, dcaInterval: 43_200, dcaTotal: 10, amountIn: '1000000', routerDataHash: undefined }),
    )
    const arg = lastSupabaseArg()
    const orderData = arg.orderData as Record<string, unknown>
    expect(arg.dcaInterval).toBe(43_200)
    expect(arg.dcaTotal).toBe(10)
    expect(String(arg.dcaInterval)).toBe(orderData.dcaInterval)
    expect(String(arg.dcaTotal)).toBe(orderData.dcaTotal)
  })
})

// ─────────────────────────────────────────────────────────────
// [CHORE-DCA-PRELAUNCH-FIXES Fix 1] client-side MIN_ORDER_AMOUNT floor guard.
//
// createOrder rejects BEFORE freezing/signing/persisting when the per-execution
// amount is below the contract floor (DCA: floor(amountIn/dcaTotal); non-DCA:
// amountIn), surfaced via an `order_error` event (DCAPanel toasts it) — so the
// user is never asked to sign an order the contract will revert
// (DCAChunkTooSmall / OrderTooSmall). MIN_ORDER_AMOUNT is the single shared
// constant from order-engine/config.ts, mirroring the on-chain 10_000.
// ─────────────────────────────────────────────────────────────
describe('useOrderEngine — MIN_ORDER_AMOUNT pre-sign floor guard [Fix 1]', () => {
  it('builds amountIn/minAmountOut as exact bigints from the wei strings', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig({ amountIn: '1000000000000000000', minAmountOut: '2900000000' }))
    })
    expect(result.current.pendingOrder!.order.amountIn).toBe(1_000_000_000_000_000_000n)
    expect(result.current.pendingOrder!.order.minAmountOut).toBe(2_900_000_000n)
  })

  it('REJECTS a sub-floor amount client-side (9999 < 10000) before freezing/signing/persisting', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig({ amountIn: '9999', minAmountOut: '1' }))
    })
    // Not frozen for review; an order_error surfaced for the UI to toast.
    expect(result.current.pendingOrder).toBeNull()
    expect(result.current.latestEvent?.type).toBe('order_error')
    expect((result.current.latestEvent as { error: string }).error).toMatch(/minimum|too small|10,000/i)
    // confirmOrder is a no-op (nothing frozen) → never signs or persists.
    await act(async () => { await result.current.confirmOrder() })
    expect(mockSignTypedDataAsync).not.toHaveBeenCalled()
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()
  })

  it('ALLOWS a just-at-floor amount (10000) — frozen for review, no error', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig({ amountIn: '10000', minAmountOut: '1' }))
    })
    expect(result.current.pendingOrder!.order.amountIn).toBe(10_000n)
    expect(result.current.latestEvent?.type).not.toBe('order_error')
  })

  it('REJECTS a DCA order whose per-chunk amount is sub-floor (floor(15000/2)=7500 < 10000)', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig({ orderType: OrderType.DCA, amountIn: '15000', dcaInterval: 3_600, dcaTotal: 2, minAmountOut: '1' }))
    })
    expect(result.current.pendingOrder).toBeNull()
    expect(result.current.latestEvent?.type).toBe('order_error')
  })

  it('ALLOWS a DCA order whose per-chunk amount is exactly at floor (20000/2=10000)', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig({ orderType: OrderType.DCA, amountIn: '20000', dcaInterval: 3_600, dcaTotal: 2, minAmountOut: '1' }))
    })
    expect(result.current.pendingOrder!.order.amountIn).toBe(20_000n)
  })
})
