// @vitest-environment jsdom
/**
 * [P80/M-01 Phase 2] useConditionalOrder — Stop Loss / Take Profit.
 *
 * Tests the price-monitoring loop (Chainlink → trigger), auto-submission
 * via signTypedDataAsync + submitLimitOrder, double-trigger prevention,
 * and the submitted-order polling state machine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSignTypedDataAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockBuildLimitOrderParams = vi.fn()
const mockSubmitLimitOrder = vi.fn<(...a: unknown[]) => Promise<string>>()
const mockFetchLimitOrderStatus = vi.fn()
const mockGetTokenPriceUSD = vi.fn<(addr: string) => Promise<number>>()
const mockIsTriggerMet = vi.fn<(...a: unknown[]) => boolean>()

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({
    address: '0x1111111111111111111111111111111111111111',
  })),
  useChainId: vi.fn(() => 1),
  useSignTypedData: vi.fn(() => ({
    signTypedDataAsync: mockSignTypedDataAsync,
  })),
}))

vi.mock('@/lib/limit-order-api', () => ({
  buildLimitOrderParams: (...args: unknown[]) => mockBuildLimitOrderParams(...args),
  submitLimitOrder: (...args: unknown[]) => mockSubmitLimitOrder(...args),
  fetchLimitOrderStatus: (...args: unknown[]) => mockFetchLimitOrderStatus(...args),
}))

vi.mock('@/lib/price-monitor', () => ({
  getTokenPriceUSD: (...args: unknown[]) => mockGetTokenPriceUSD(args[0] as string),
  isTriggerMet: (...args: unknown[]) => mockIsTriggerMet(...args),
}))

import { renderHook, act } from '@testing-library/react'
import { useConditionalOrder } from './useConditionalOrder'
import type { ConditionalOrderConfig } from '@/lib/conditional-order-types'
import {
  CONDITIONAL_STORAGE_KEY,
  PRICE_POLL_INTERVAL_MS,
  ORDER_POLL_INTERVAL_MS,
} from '@/lib/conditional-order-types'

const WETH = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`,
  symbol: 'WETH',
  name: 'Wrapped Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native' as const,
}

const USDC = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '',
  category: 'Stablecoin' as const,
}

const WBTC = {
  address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as `0x${string}`,
  symbol: 'WBTC',
  name: 'Wrapped BTC',
  decimals: 8,
  logoURI: '',
  category: 'Wrapped BTC' as const,
}

const FAKE_SIG = ('0x' + 'aa'.repeat(65))
const FAKE_UID = '0xcafecafecafe'

function makeConfig(overrides: Partial<ConditionalOrderConfig> = {}): ConditionalOrderConfig {
  return {
    type: 'stop_loss',
    tokenIn: WETH,
    tokenOut: USDC,
    sellAmount: '1000000000000000000',
    triggerPrice: 2900,
    triggerDirection: 'below',
    limitPrice: 2850,
    expirySeconds: 24 * 60 * 60,
    partiallyFillable: false,
    ...overrides,
  }
}

function makeParams() {
  return {
    sellToken: WETH.address,
    buyToken: USDC.address,
    receiver: '0x1111111111111111111111111111111111111111',
    sellAmount: '1000000000000000000',
    buyAmount: '2850000000',
    validTo: Math.floor(Date.now() / 1000) + 86_400,
    appData: '{}',
    appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    feeAmount: '0',
    kind: 'sell' as const,
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    from: '0x1111111111111111111111111111111111111111',
    signingScheme: 'eip712',
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockSubmitLimitOrder.mockResolvedValue(FAKE_UID)
  mockBuildLimitOrderParams.mockReturnValue(makeParams())
  mockGetTokenPriceUSD.mockResolvedValue(3000)
  mockIsTriggerMet.mockReturnValue(false)
  mockFetchLimitOrderStatus.mockResolvedValue({
    status: 'open',
    executedBuyAmount: '0',
    executedSellAmount: '0',
    filledPercent: 0,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useConditionalOrder — initial state', () => {
  it('starts with empty orders / no events', () => {
    const { result } = renderHook(() => useConditionalOrder())
    expect(result.current.orders).toEqual([])
    expect(result.current.latestEvent).toBeNull()
  })
})

describe('useConditionalOrder — createOrder', () => {
  it('records a monitoring order and persists to localStorage', async () => {
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    expect(result.current.orders).toHaveLength(1)
    expect(result.current.orders[0].status).toBe('monitoring')

    const stored = JSON.parse(localStorage.getItem(CONDITIONAL_STORAGE_KEY) || '[]')
    expect(stored).toHaveLength(1)
  })

  it('throws when wallet is disconnected', async () => {
    const wagmi = await import('wagmi')
    ;(wagmi.useAccount as ReturnType<typeof vi.fn>).mockReturnValue({ address: undefined })
    const { result } = renderHook(() => useConditionalOrder())
    await expect(result.current.createOrder(makeConfig())).rejects.toThrow(/wallet not connected/i)
    ;(wagmi.useAccount as ReturnType<typeof vi.fn>).mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
    })
  })
})

describe('useConditionalOrder — price monitoring loop', () => {
  it('polls getTokenPriceUSD with the input token address on the monitoring interval', async () => {
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    // Initial price fetch ran during createOrder; clear and advance.
    mockGetTokenPriceUSD.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRICE_POLL_INTERVAL_MS)
    })
    expect(mockGetTokenPriceUSD).toHaveBeenCalled()
    const calledAddrs = mockGetTokenPriceUSD.mock.calls.map(c => c[0])
    expect(calledAddrs).toContain(WETH.address)
  })

  it('fires a trigger when isTriggerMet returns true → status transitions to submitted', async () => {
    mockIsTriggerMet.mockReturnValue(true)
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRICE_POLL_INTERVAL_MS)
      // Drain microtasks for the async handleTrigger chain.
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.orders[0].status).toBe('submitted')
    expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1)
    expect(mockSubmitLimitOrder).toHaveBeenCalledTimes(1)
  })

  it('does NOT double-trigger when isTriggerMet returns true on two consecutive polls', async () => {
    mockIsTriggerMet.mockReturnValue(true)
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRICE_POLL_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })
    // A second tick should not re-sign — the order is no longer in
    // 'monitoring' state, and triggeringRef guards the in-flight case.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRICE_POLL_INTERVAL_MS)
      await Promise.resolve()
    })
    expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1)
  })

  it('marks the order as error when user rejects the trigger signature', async () => {
    mockIsTriggerMet.mockReturnValue(true)
    mockSignTypedDataAsync.mockRejectedValueOnce(
      Object.assign(new Error('User rejected the request.'), {
        name: 'UserRejectedRequestError',
      }),
    )
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRICE_POLL_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.orders[0].status).toBe('error')
    expect(result.current.orders[0].error).toMatch(/rejected|signature/i)
  })

  it('polls prices for each unique token across multiple monitoring orders', async () => {
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig({ tokenIn: WETH }))
      await result.current.createOrder(makeConfig({ tokenIn: WBTC }))
    })
    mockGetTokenPriceUSD.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRICE_POLL_INTERVAL_MS)
      await Promise.resolve()
    })
    const addrs = mockGetTokenPriceUSD.mock.calls.map(c => c[0])
    expect(addrs).toContain(WETH.address)
    expect(addrs).toContain(WBTC.address)
  })
})

describe('useConditionalOrder — submitted order polling', () => {
  it('transitions submitted → filled when CoW reports fulfilled', async () => {
    mockIsTriggerMet.mockReturnValue(true)
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRICE_POLL_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.orders[0].status).toBe('submitted')

    // Now the order-polling loop should kick in.
    mockFetchLimitOrderStatus.mockResolvedValue({
      status: 'fulfilled',
      executedBuyAmount: '2850000000',
      executedSellAmount: '1000000000000000000',
      txHash: '0xfeed',
      filledPercent: 100,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ORDER_POLL_INTERVAL_MS)
      await Promise.resolve()
    })
    expect(result.current.orders[0].status).toBe('filled')
  })
})

describe('useConditionalOrder — cancel + remove', () => {
  it('cancelOrder marks the order as cancelled', async () => {
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const id = result.current.orders[0].id
    act(() => {
      result.current.cancelOrder(id)
    })
    expect(result.current.orders[0].status).toBe('cancelled')
  })

  it('removeOrder drops the order from the list', async () => {
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const id = result.current.orders[0].id
    act(() => {
      result.current.removeOrder(id)
    })
    expect(result.current.orders).toHaveLength(0)
  })
})

describe('useConditionalOrder — [P214] trigger direction validation', () => {
  it('rejects an ABOVE trigger when the current price is already above it', async () => {
    mockGetTokenPriceUSD.mockResolvedValue(2000)
    const { result } = renderHook(() => useConditionalOrder())
    await expect(
      result.current.createOrder(
        makeConfig({ type: 'take_profit', triggerDirection: 'above', triggerPrice: 1900 }),
      ),
    ).rejects.toThrow(/must be above the current price/i)
    expect(result.current.orders).toHaveLength(0)
  })

  it('rejects a BELOW trigger when the current price is already below it', async () => {
    mockGetTokenPriceUSD.mockResolvedValue(1800)
    const { result } = renderHook(() => useConditionalOrder())
    await expect(
      result.current.createOrder(
        makeConfig({ type: 'stop_loss', triggerDirection: 'below', triggerPrice: 1900 }),
      ),
    ).rejects.toThrow(/must be below the current price/i)
    expect(result.current.orders).toHaveLength(0)
  })

  it('allows a valid trigger configuration (ABOVE above current price)', async () => {
    mockGetTokenPriceUSD.mockResolvedValue(2000)
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(
        makeConfig({ type: 'take_profit', triggerDirection: 'above', triggerPrice: 2100 }),
      )
    })
    expect(result.current.orders).toHaveLength(1)
    expect(result.current.orders[0].status).toBe('monitoring')
  })

  it('skips trigger validation for DCA orders', async () => {
    // Current 2000 with an ABOVE/1900 trigger would normally reject, but a DCA
    // order has no meaningful trigger price and must be accepted regardless.
    mockGetTokenPriceUSD.mockResolvedValue(2000)
    const { result } = renderHook(() => useConditionalOrder())
    await act(async () => {
      await result.current.createOrder(
        makeConfig({
          type: 'DCA' as unknown as ConditionalOrderConfig['type'],
          triggerDirection: 'above',
          triggerPrice: 1900,
        }),
      )
    })
    expect(result.current.orders).toHaveLength(1)
  })
})

describe('useConditionalOrder — [P212] submitted-order poll reads fresh ordersRef', () => {
  it('polls a newly-submitted order on a later tick (fresh ref read, not a setup snapshot)', async () => {
    mockIsTriggerMet.mockReturnValue(true)
    mockSubmitLimitOrder.mockResolvedValueOnce('uid-A').mockResolvedValueOnce('uid-B')
    const { result } = renderHook(() => useConditionalOrder())

    // First order → triggers → submitted (uid-A); the order-poll interval starts.
    await act(async () => {
      await result.current.createOrder(makeConfig({ triggerPrice: 2900 }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRICE_POLL_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.orders.some(o => o.status === 'submitted')).toBe(true)

    // Second order created + triggered AFTER the interval was established.
    await act(async () => {
      await result.current.createOrder(makeConfig({ triggerPrice: 2800 }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRICE_POLL_INTERVAL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })

    // The poll callback re-reads ordersRef.current each tick, so the order-status
    // poll covers BOTH submitted orders — including uid-B, which became
    // submitted after the interval first started.
    mockFetchLimitOrderStatus.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ORDER_POLL_INTERVAL_MS)
      await Promise.resolve()
    })
    const polledUids = mockFetchLimitOrderStatus.mock.calls.map(c => c[0])
    expect(polledUids).toContain('uid-A')
    expect(polledUids).toContain('uid-B')
  })
})

describe('useConditionalOrder — persistence', () => {
  it('reloading the hook restores monitoring orders from localStorage', async () => {
    const first = renderHook(() => useConditionalOrder())
    await act(async () => {
      await first.result.current.createOrder(makeConfig())
    })
    expect(first.result.current.orders).toHaveLength(1)
    first.unmount()

    const second = renderHook(() => useConditionalOrder())
    await act(async () => { await Promise.resolve() })
    expect(second.result.current.orders).toHaveLength(1)
    expect(second.result.current.orders[0].status).toBe('monitoring')
  })
})
