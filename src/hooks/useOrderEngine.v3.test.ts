// @vitest-environment jsdom
/**
 * [SPRINT-V3-P2] useOrderEngine — v3 signing branch.
 *
 * Separate file from useOrderEngine.test.ts because it needs getOrderExecutorV3 to return a
 * NON-null address (v3 "deployed" on chain 1) to exercise the branch — every other test in the
 * suite relies on v3 staying null (fail-closed default). Mocking it here keeps that isolation.
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

const V3_ADDRESS = '0x3333333333333333333333333333333333333333'

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: '0x1111111111111111111111111111111111111111' })),
  useChainId: vi.fn(() => 1),
  useSignTypedData: vi.fn(() => ({ signTypedDataAsync: mockSignTypedDataAsync })),
  useWriteContract: vi.fn(() => ({ writeContractAsync: mockWriteContractAsync })),
  useReadContract: vi.fn((opts: { functionName: string }) => mockReadContractImpl(opts)),
}))

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
    // [SPRINT-V3-P2] simulate v3 deployed on chain 1 for this file only. Both getOrderExecutorV3
    // AND getOrderExecutorV3Domain must be overridden — the real config.ts domain fn calls its
    // OWN internal getOrderExecutorV3 (config's real env-driven lookup), not this module's
    // re-export, so mocking only the re-export leaves the domain fn throwing "not deployed".
    getOrderExecutorV3: (chainId: number) => (chainId === 1 ? V3_ADDRESS : null),
    getOrderExecutorV3Domain: (chainId: number) => {
      if (chainId !== 1) throw new Error(`No OrderExecutorV3 deployed on chain ${chainId}`)
      return { name: 'TeraSwapOrderExecutor' as const, version: '3' as const, chainId, verifyingContract: V3_ADDRESS }
    },
  }
})

import { renderHook, act } from '@testing-library/react'
import { useOrderEngine } from './useOrderEngine'
import { OrderType, PriceCondition, getOrderExecutor, type CreateOrderConfig, type OrderRow } from '@/lib/order-engine'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = ('0x' + 'cc'.repeat(65))

function makeConfig(overrides: Partial<CreateOrderConfig> = {}): CreateOrderConfig {
  return {
    tokenIn: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    tokenOut: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    amountIn: '1000000000000000000',
    minAmountOut: '2900000000',
    orderType: OrderType.DCA,
    condition: PriceCondition.ABOVE,
    targetPrice: '0',
    priceFeed: '0x0000000000000000000000000000000000000000',
    expirySeconds: 24 * 60 * 60,
    router: '0x111111125421ca6dc452d289314280a0f8842a65',
    routerDataHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
    dcaInterval: 3600,
    dcaTotal: 3,
    ...overrides,
  }
}

function makeRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'row-' + Math.random().toString(36).slice(2),
    wallet: ADDRESS,
    order_hash: ('0x' + 'aa'.repeat(32)) as string,
    order_type: 'dca',
    status: 'active',
    token_in: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    token_out: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amount_in: '1000000000000000000',
    min_amount_out: '2900000000',
    target_price: '0',
    price_feed: '0x0000000000000000000000000000000000000000',
    price_condition: 'above',
    expiry: '0',
    nonce: 0,
    router: '0x111111125421ca6dc452d289314280a0f8842a65',
    dca_interval: 3600,
    dca_total: 3,
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

async function createAndConfirm(
  result: { current: { createOrder: (c: CreateOrderConfig) => Promise<void>; confirmOrder: () => Promise<void> } },
  config: CreateOrderConfig,
) {
  await act(async () => { await result.current.createOrder(config) })
  await act(async () => { await result.current.confirmOrder() })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
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

describe('useOrderEngine — v3 signing branch [SPRINT-V3-P2]', () => {
  it('config.maxSlippageBps set + v3 configured ⇒ signs with the v3 domain (version "3")', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig({ maxSlippageBps: 300 }))

    const callArg = mockSignTypedDataAsync.mock.calls[0][0] as {
      domain: { name: string; version: string; chainId: number; verifyingContract: string }
      primaryType: string
      types: { Order: Array<{ name: string; type: string }> }
      message: Record<string, unknown>
    }
    expect(callArg.domain.name).toBe('TeraSwapOrderExecutor')
    expect(callArg.domain.version).toBe('3')
    expect(callArg.domain.verifyingContract).toBe(V3_ADDRESS)
    expect(callArg.types.Order.some((f) => f.name === 'maxSlippageBps' && f.type === 'uint16')).toBe(true)
    expect(callArg.message.maxSlippageBps).toBe(300)
  })

  it('config WITHOUT maxSlippageBps still signs v2, even though v3 is configured on this chain', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig()) // no maxSlippageBps

    const callArg = mockSignTypedDataAsync.mock.calls[0][0] as {
      domain: { version: string; verifyingContract: string }
      message: Record<string, unknown>
    }
    expect(callArg.domain.version).toBe('2')
    expect(callArg.domain.verifyingContract).toBe(getOrderExecutor(1))
    expect(callArg.message.maxSlippageBps).toBeUndefined()
  })

  it('persists maxSlippageBps into the Supabase order_data blob for a v3 order', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig({ maxSlippageBps: 500 }))

    const insertArg = mockCreateOrderInSupabase.mock.calls[0][0] as {
      orderData: { maxSlippageBps?: number }
    }
    expect(insertArg.orderData.maxSlippageBps).toBe(500)
  })

  it('a v2 order (no maxSlippageBps) has no maxSlippageBps key in order_data at all', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig())

    const insertArg = mockCreateOrderInSupabase.mock.calls[0][0] as {
      orderData: Record<string, unknown>
    }
    expect('maxSlippageBps' in insertArg.orderData).toBe(false)
  })

  // [SPRINT-V3-P3] v3 cancel is now wired — a v3 order on a chain WHERE v3 IS configured
  // freezes for review (and confirms) exactly like a v2 order, targeting the v3 executor+ABI.
  // The full order_data shape mirrors what useOrderEngine.confirmOrder actually persists for a
  // v3 order (see the "persists maxSlippageBps..." test above).
  const V3_ORDER_DATA = {
    owner: ADDRESS,
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountIn: '1000000000000000000',
    minAmountOut: '2900000000',
    maxSlippageBps: 300,
    orderType: 2, // DCA
    condition: 0,
    targetPrice: '0',
    priceFeed: '0x0000000000000000000000000000000000000000',
    expiry: '9999999999',
    nonce: '0',
    router: '0x111111125421ca6dc452d289314280a0f8842a65',
    routerDataHash: '0x' + '00'.repeat(32),
    dcaInterval: '3600',
    dcaTotal: '3',
  }

  it('cancelOrder freezes a v3 order for review when v3 IS configured on this chain', async () => {
    mockFetchUserOrders.mockResolvedValue([makeRow({ order_data: V3_ORDER_DATA })])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    const order = result.current.orders[0]
    expect(order).toBeDefined()
    await act(async () => { await result.current.cancelOrder(order.id) })

    expect(mockWriteContractAsync).not.toHaveBeenCalled() // Phase A only freezes, no tx yet
    expect(result.current.pendingCancel).not.toBeNull()
    if (result.current.pendingCancel?.action === 'cancel') {
      expect(result.current.pendingCancel.isV3).toBe(true)
      expect(result.current.pendingCancel.orderStruct.maxSlippageBps).toBe(300)
    } else {
      throw new Error('expected a cancel review')
    }
  })

  it('confirmCancel sends a v3 cancel to the V3 executor + ABI, never v2', async () => {
    mockFetchUserOrders.mockResolvedValue([makeRow({ order_data: V3_ORDER_DATA })])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    const order = result.current.orders[0]
    await act(async () => { await result.current.cancelOrder(order.id) })
    await act(async () => { await result.current.confirmCancel() })

    expect(mockWriteContractAsync).toHaveBeenCalledTimes(1)
    const callArg = mockWriteContractAsync.mock.calls[0][0] as { address: string; functionName: string }
    expect(callArg.address).toBe(V3_ADDRESS)
    expect(callArg.functionName).toBe('cancelOrder')
  })

  it('cancelAllOrders excludes v3 orders from the affected set (v2-only invalidateNonces)', async () => {
    mockFetchUserOrders.mockResolvedValue([
      makeRow({ id: 'r-v2', order_hash: '0x' + '01'.repeat(32), order_data: {} }),
      makeRow({ id: 'r-v3', order_hash: '0x' + '02'.repeat(32), order_data: { maxSlippageBps: 300 } }),
    ])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(result.current.orders).toHaveLength(2)

    await act(async () => { await result.current.cancelAllOrders() })

    expect(result.current.pendingCancel).not.toBeNull()
    if (result.current.pendingCancel?.action === 'invalidate') {
      const ids = result.current.pendingCancel.affectedOrders.map((o) => o.id)
      expect(ids).toContain('r-v2')
      expect(ids).not.toContain('r-v3')
    } else {
      throw new Error('expected an invalidate review')
    }
  })
})
