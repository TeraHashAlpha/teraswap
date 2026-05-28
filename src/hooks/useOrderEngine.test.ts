// @vitest-environment jsdom
/**
 * [P81/M-01 Phase 2] useOrderEngine — autonomous-order lifecycle.
 *
 * The hook is large (~580 lines): EIP-712 signing, Supabase persistence,
 * localStorage obfuscation, nonce management, on-chain cancellation,
 * real-time subscription. We pin the public API + security invariants
 * (domain, nonce-from-contract, routerDataHash, dcaTotal default).
 * Internal computeOrderHash / obfuscate are exercised indirectly via
 * signTypedDataAsync call inspection and a localStorage round-trip.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSignTypedDataAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockWriteContractAsync = vi.fn<(args: unknown) => Promise<string>>()

const mockReadContractImpl = vi.fn<(opts: { functionName: string }) => { data: unknown; isLoading: boolean }>()

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

// Mock the @/lib/order-engine module — keep enums + constants as real
// values so the hook's runtime checks remain meaningful, but stub the
// I/O surface (createOrderInSupabase, fetchUserOrders, etc.).
vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return {
    ...actual,
    createOrderInSupabase: (...args: unknown[]) => mockCreateOrderInSupabase(...args),
    fetchUserOrders: (...args: unknown[]) => mockFetchUserOrders(...args),
    fetchActiveOrders: (...args: unknown[]) => mockFetchActiveOrders(...args),
    cancelOrderInSupabase: (...args: unknown[]) => mockCancelOrderInSupabase(...args),
    subscribeToOrders: (...args: unknown[]) => mockSubscribeToOrders(...args),
    ORDER_POLL_INTERVAL_MS: 100, // shrink for tests
  }
})

import { renderHook, act, waitFor } from '@testing-library/react'
import { useOrderEngine } from './useOrderEngine'
import {
  OrderType,
  PriceCondition,
  ORDER_EXECUTOR_ADDRESS,
  type CreateOrderConfig,
  type OrderRow,
} from '@/lib/order-engine'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = ('0x' + 'cc'.repeat(65))

function makeConfig(overrides: Partial<CreateOrderConfig> = {}): CreateOrderConfig {
  return {
    tokenIn: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    tokenOut: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    amountIn: '1000000000000000000',
    minAmountOut: '2900000000',
    orderType: OrderType.LIMIT,
    condition: PriceCondition.ABOVE,
    targetPrice: '300000000000', // 3000 USD in 8 decimals
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
    token_in: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    token_out: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
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

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockWriteContractAsync.mockResolvedValue('0x' + 'ff'.repeat(32))
  mockReadContractImpl.mockImplementation(({ functionName }) => {
    if (functionName === 'nonces') return { data: 5n, isLoading: false }
    if (functionName === 'invalidatedNonces') return { data: 0n, isLoading: false }
    return { data: undefined, isLoading: false }
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

describe('useOrderEngine — initial state', () => {
  it('starts loading, then settles to empty after Supabase resolves', async () => {
    const { result } = renderHook(() => useOrderEngine())
    expect(result.current.orders).toEqual([])
    await act(async () => { await Promise.resolve() })
    expect(result.current.isLoading).toBe(false)
    expect(mockFetchUserOrders).toHaveBeenCalledWith(ADDRESS)
  })

  it('hydrates from Supabase when fetchUserOrders returns rows', async () => {
    mockFetchUserOrders.mockResolvedValue([makeRow({ id: 'r1' }), makeRow({ id: 'r2' })])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(result.current.orders).toHaveLength(2)
  })

  it('subscribes to real-time updates on mount and unsubscribes on unmount', async () => {
    const unsubscribe = vi.fn()
    mockSubscribeToOrders.mockReturnValue(unsubscribe)
    const { unmount } = renderHook(() => useOrderEngine())
    expect(mockSubscribeToOrders).toHaveBeenCalledWith(ADDRESS, expect.any(Function))
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})

describe('useOrderEngine — createOrder', () => {
  it('signs with the TeraSwapOrderExecutor v2 EIP-712 domain', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const callArg = mockSignTypedDataAsync.mock.calls[0][0] as {
      domain: { name: string; version: string; chainId: number; verifyingContract: string }
      primaryType: string
    }
    expect(callArg.domain.name).toBe('TeraSwapOrderExecutor')
    expect(callArg.domain.version).toBe('2')
    expect(callArg.domain.chainId).toBe(1)
    expect(callArg.domain.verifyingContract).toBe(ORDER_EXECUTOR_ADDRESS)
    expect(callArg.primaryType).toBe('Order')
  })

  it('uses the contract nonce (not a hardcoded one)', async () => {
    mockReadContractImpl.mockImplementation(({ functionName }) => {
      if (functionName === 'nonces') return { data: 42n, isLoading: false }
      if (functionName === 'invalidatedNonces') return { data: 0n, isLoading: false }
      return { data: undefined, isLoading: false }
    })
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const message = (mockSignTypedDataAsync.mock.calls[0][0] as { message: { nonce: bigint } }).message
    expect(message.nonce).toBe(42n)
  })

  it('signs an Order struct that includes routerDataHash [C-01]', async () => {
    const hash = ('0x' + 'ab'.repeat(32)) as `0x${string}`
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig({ routerDataHash: hash }))
    })
    const message = (mockSignTypedDataAsync.mock.calls[0][0] as {
      message: { routerDataHash: string }
    }).message
    expect(message.routerDataHash).toBe(hash)
  })

  it('defaults dcaTotal to 1 when caller omits it', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const message = (mockSignTypedDataAsync.mock.calls[0][0] as {
      message: { dcaTotal: bigint }
    }).message
    expect(message.dcaTotal).toBe(1n)
  })

  it('marks the order active and writes the signature into Supabase', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    expect(mockCreateOrderInSupabase).toHaveBeenCalledTimes(1)
    const supabaseArg = mockCreateOrderInSupabase.mock.calls[0][0] as { signature: string }
    expect(supabaseArg.signature).toBe(FAKE_SIG)
    expect(result.current.orders[0].status).toBe('active')
  })

  it('falls back to error state when user rejects', async () => {
    mockSignTypedDataAsync.mockRejectedValueOnce(
      Object.assign(new Error('User rejected the request.'), {
        name: 'UserRejectedRequestError',
      }),
    )
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    expect(result.current.orders[0].status).toBe('error')
    expect(result.current.orders[0].error).toMatch(/rejected/i)
    expect(result.current.isSubmitting).toBe(false)
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()
  })
})

describe('useOrderEngine — cancelOrder + cancelAllOrders', () => {
  it('cancelOrder writes on-chain and updates Supabase', async () => {
    mockCreateOrderInSupabase.mockResolvedValue(
      makeRow({ id: 'row-1', order_hash: '0x' + 'aa'.repeat(32) }),
    )
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const orderId = result.current.orders[0].id

    await act(async () => {
      await result.current.cancelOrder(orderId)
    })
    expect(mockWriteContractAsync).toHaveBeenCalled()
    expect(mockCancelOrderInSupabase).toHaveBeenCalledWith(
      ADDRESS,
      expect.any(String),
    )
    expect(result.current.orders[0].status).toBe('cancelled')
  })

  it('cancelAllOrders invalidates nonces and marks all active orders cancelled', async () => {
    mockFetchUserOrders.mockResolvedValue([
      makeRow({ id: 'r1', order_hash: '0x' + 'aa'.repeat(32) }),
      makeRow({ id: 'r2', order_hash: '0x' + 'bb'.repeat(32) }),
    ])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      await result.current.cancelAllOrders()
    })
    const writeCall = mockWriteContractAsync.mock.calls[0][0] as { functionName: string }
    expect(writeCall.functionName).toBe('invalidateNonces')
    expect(result.current.orders.every(o => o.status === 'cancelled')).toBe(true)
  })
})

describe('useOrderEngine — removeOrder', () => {
  // [P197] removeOrder now no-ops on ACTIVE orders (they must be cancelled
  // on-chain first). This test removes a terminal (cancelled) order — the
  // same behaviour it always verified, on a now-dismissible status.
  it('removes a terminal order from local state without calling Supabase', async () => {
    mockCreateOrderInSupabase.mockResolvedValue(
      makeRow({ id: 'row-1', order_hash: '0x' + 'aa'.repeat(32) }),
    )
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const id = result.current.orders[0].id
    await act(async () => {
      await result.current.cancelOrder(id)
    })
    expect(result.current.orders[0].status).toBe('cancelled')
    mockCancelOrderInSupabase.mockClear()
    act(() => {
      result.current.removeOrder(id)
    })
    expect(result.current.orders).toHaveLength(0)
    expect(mockCancelOrderInSupabase).not.toHaveBeenCalled()
  })

  it('does not remove an active order — it must be cancelled on-chain first [P197]', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const id = result.current.orders[0].id
    expect(result.current.orders[0].status).toBe('active')
    act(() => {
      result.current.removeOrder(id)
    })
    expect(result.current.orders).toHaveLength(1)
  })

  it('persists the dismissed order ID to localStorage [P197]', async () => {
    mockFetchUserOrders.mockResolvedValue([
      makeRow({ id: 'cancelled-1', status: 'cancelled' }),
    ])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(result.current.orders).toHaveLength(1)
    act(() => {
      result.current.removeOrder('cancelled-1')
    })
    const dismissed = JSON.parse(localStorage.getItem('teraswap_dismissed_orders') || '[]')
    expect(dismissed).toContain('cancelled-1')
  })

  it('filters dismissed orders out of the Supabase-loaded set [P197]', async () => {
    localStorage.setItem('teraswap_dismissed_orders', JSON.stringify(['gone-1']))
    mockFetchUserOrders.mockResolvedValue([
      makeRow({ id: 'gone-1', status: 'cancelled' }),
      makeRow({ id: 'keep-1', status: 'cancelled' }),
    ])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    const ids = result.current.orders.map(o => o.id)
    expect(ids).not.toContain('gone-1')
    expect(ids).toContain('keep-1')
  })
})

describe('useOrderEngine — token symbols from Supabase row [P196]', () => {
  it('populates tokenInSymbol/tokenOutSymbol from the row data', async () => {
    mockFetchUserOrders.mockResolvedValue([
      makeRow({ id: 'r1', token_in_symbol: 'USDC', token_out_symbol: 'ETH' }),
    ])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(result.current.orders[0].tokenInSymbol).toBe('USDC')
    expect(result.current.orders[0].tokenOutSymbol).toBe('ETH')
  })

  it('falls back to empty string when row symbols are null (legacy orders)', async () => {
    mockFetchUserOrders.mockResolvedValue([
      makeRow({ id: 'r1', token_in_symbol: null, token_out_symbol: null }),
    ])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(result.current.orders[0].tokenInSymbol).toBe('')
    expect(result.current.orders[0].tokenOutSymbol).toBe('')
  })
})

describe('useOrderEngine — derived filters', () => {
  it('separates active vs history orders by status', async () => {
    mockFetchUserOrders.mockResolvedValue([
      makeRow({ id: 'r1', status: 'active' }),
      // DB stores 'executed'; the hook maps it to 'filled'. The OrderRow
      // type only models the UI enum, so we cast through unknown.
      makeRow({ id: 'r2', status: 'executed' as unknown as 'filled' }),
      makeRow({ id: 'r3', status: 'cancelled' }),
    ])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(result.current.activeOrders).toHaveLength(1)
    expect(result.current.historyOrders).toHaveLength(2)
  })

  it('splits orders by type (limit / stop-loss / dca)', async () => {
    mockFetchUserOrders.mockResolvedValue([
      makeRow({ id: 'r1', order_type: 'limit' }),
      makeRow({ id: 'r2', order_type: 'stop_loss' }),
      makeRow({ id: 'r3', order_type: 'dca' }),
    ])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(result.current.limitOrders).toHaveLength(1)
    expect(result.current.stopLossOrders).toHaveLength(1)
    expect(result.current.dcaOrders).toHaveLength(1)
  })

  it('maps DB status "executed" → "filled" and "failed" → "error"', async () => {
    mockFetchUserOrders.mockResolvedValue([
      makeRow({ id: 'r1', status: 'executed' as unknown as 'filled' }),
      makeRow({ id: 'r2', status: 'failed' as unknown as 'error' }),
    ])
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    const statuses = result.current.orders.map(o => o.status).sort()
    expect(statuses).toEqual(['error', 'filled'])
  })
})

describe('useOrderEngine — persistence (encrypted localStorage [P200])', () => {
  it('writes an encrypted (non-plain-JSON) payload to teraswap_orders_v4', async () => {
    // Encryption is real-async (AES-GCM); fake timers can't flush the crypto
    // promise chain, so this test runs on real timers + waitFor.
    vi.useRealTimers()
    const { result } = renderHook(() => useOrderEngine())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    // The save effect encrypts + persists asynchronously.
    await waitFor(() => {
      expect(localStorage.getItem('teraswap_orders_v4')).not.toBeNull()
    })
    const parsed = JSON.parse(localStorage.getItem('teraswap_orders_v4')!)
    // AES-GCM EncryptedPayload shape { v, iv, ct } — never a plain order array.
    expect(Array.isArray(parsed)).toBe(false)
    expect(parsed.v).toBe(1)
    expect(typeof parsed.iv).toBe('string')
    expect(typeof parsed.ct).toBe('string')
    // The legacy v3 key is never written by the encrypted path.
    expect(localStorage.getItem('teraswap_orders_v3')).toBeNull()
  })

  it('survives unmount + remount via localStorage (Supabase yields no rows)', async () => {
    vi.useRealTimers()
    const first = renderHook(() => useOrderEngine())
    await act(async () => {
      await first.result.current.createOrder(makeConfig())
    })
    const firstOrders = first.result.current.orders
    expect(firstOrders).toHaveLength(1)
    // Wait for the encrypted write to land before tearing the hook down.
    await waitFor(() => {
      expect(localStorage.getItem('teraswap_orders_v4')).not.toBeNull()
    })
    first.unmount()

    // Second mount: Supabase returns no rows → encrypted localStorage fallback.
    mockFetchUserOrders.mockResolvedValue([])
    const second = renderHook(() => useOrderEngine())
    await waitFor(() => {
      expect(second.result.current.orders).toHaveLength(1)
    })
    expect(second.result.current.orders[0].orderHash).toBe(firstOrders[0].orderHash)
  })

  it('migrates plain-JSON localStorage (pre-obfuscation) without crashing', async () => {
    // Pre-seed with a plain-JSON order, matching the old format.
    const plain = [
      {
        id: 'old-1',
        orderHash: '0x' + 'aa'.repeat(32),
        order: { owner: ADDRESS },
        signature: FAKE_SIG,
        status: 'active',
        orderType: OrderType.LIMIT,
        tokenInSymbol: 'WETH',
        tokenInDecimals: 18,
        tokenOutSymbol: 'USDC',
        tokenOutDecimals: 6,
        dcaExecuted: 0,
        dcaTotal: 1,
        createdAt: Date.now(),
        executedAt: null,
        expiresAt: Date.now() + 86_400_000,
        error: null,
        amountOut: null,
        txHash: null,
      },
    ]
    localStorage.setItem('teraswap_orders_v3', JSON.stringify(plain))

    const { result } = renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    // The hook either reads the plain JSON or treats it as missing —
    // either way it must not crash.
    expect(Array.isArray(result.current.orders)).toBe(true)
  })
})

describe('useOrderEngine — polling', () => {
  it('does not poll when there are no active orders', async () => {
    mockFetchUserOrders.mockResolvedValue([makeRow({ status: 'filled' })])
    renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    mockFetchActiveOrders.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(mockFetchActiveOrders).not.toHaveBeenCalled()
  })

  it('polls fetchActiveOrders while at least one active order exists', async () => {
    mockFetchUserOrders.mockResolvedValue([makeRow({ status: 'active' })])
    renderHook(() => useOrderEngine())
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    mockFetchActiveOrders.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
      await Promise.resolve()
    })
    expect(mockFetchActiveOrders).toHaveBeenCalled()
  })
})
