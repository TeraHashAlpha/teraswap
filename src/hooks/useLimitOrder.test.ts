// @vitest-environment jsdom
/**
 * [P80/M-01 Phase 2] useLimitOrder — sign + submit + poll CoW limit orders.
 *
 * Pins the EIP-712 domain (Gnosis Protocol, v2, COW_SETTLEMENT),
 * receiver=msg.sender, localStorage persistence, polling-on-open
 * lifecycle, and the user-rejection branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSignTypedDataAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockBuildLimitOrderParams = vi.fn()
const mockSubmitLimitOrder = vi.fn<(...a: unknown[]) => Promise<string>>()
const mockFetchLimitOrderStatus = vi.fn()

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

import { renderHook, act, waitFor } from '@testing-library/react'
import { useLimitOrder } from './useLimitOrder'
import type { LimitOrder, LimitOrderConfig } from '@/lib/limit-order-types'
import { LIMIT_STORAGE_KEY, LIMIT_POLL_INTERVAL_MS } from '@/lib/limit-order-types'
import { COW_SETTLEMENT } from '@/lib/constants'

const USDC = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '',
  category: 'Stablecoin' as const,
}

const WETH = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`,
  symbol: 'WETH',
  name: 'Wrapped Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native' as const,
}

const FAKE_SIG = ('0x' + 'de'.repeat(65)) // 65-byte ECDSA-shaped signature
const FAKE_UID = '0xfeedfeedfeed'

function makeConfig(overrides: Partial<LimitOrderConfig> = {}): LimitOrderConfig {
  return {
    tokenIn: WETH,
    tokenOut: USDC,
    sellAmount: '1000000000000000000', // 1 WETH
    targetPrice: 3000,
    kind: 'sell',
    expirySeconds: 24 * 60 * 60,
    partiallyFillable: false,
    slippage: 0,
    ...overrides,
  }
}

function makeParams() {
  return {
    sellToken: WETH.address,
    buyToken: USDC.address,
    receiver: '0x1111111111111111111111111111111111111111',
    sellAmount: '1000000000000000000',
    buyAmount: '3000000000',
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

function makeStoredOrder(id: string, status: LimitOrder['status'] = 'open'): LimitOrder {
  return {
    id,
    orderUid: id === 'open-1' ? FAKE_UID : '',
    config: makeConfig(),
    buyAmount: '3000000000',
    validTo: Math.floor(Date.now() / 1000) + 86_400,
    status,
    filledAmount: '0',
    filledPercent: 0,
    txHash: null,
    executedAt: null,
    createdAt: Date.now(),
    error: null,
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockSubmitLimitOrder.mockResolvedValue(FAKE_UID)
  mockBuildLimitOrderParams.mockReturnValue(makeParams())
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

describe('useLimitOrder — initial state', () => {
  it('starts with empty orders / not submitting', () => {
    const { result } = renderHook(() => useLimitOrder())
    expect(result.current.orders).toEqual([])
    expect(result.current.activeOrders).toEqual([])
    expect(result.current.historyOrders).toEqual([])
    expect(result.current.isSubmitting).toBe(false)
  })
})

describe('useLimitOrder — localStorage load', () => {
  it('hydrates orders from localStorage on mount (migrating v1 → encrypted v2)', async () => {
    localStorage.setItem(LIMIT_STORAGE_KEY, JSON.stringify([
      makeStoredOrder('a'),
      makeStoredOrder('b'),
    ]))
    // Legacy → encrypted migration runs through real-async AES-GCM, so this
    // test uses real timers + waitFor rather than fake-timer microtask flushes.
    vi.useRealTimers()
    const { result } = renderHook(() => useLimitOrder())
    await waitFor(() => expect(result.current.orders).toHaveLength(2))
  })

  it('returns an empty list when localStorage contents are invalid JSON', () => {
    localStorage.setItem(LIMIT_STORAGE_KEY, '{not json}')
    const { result } = renderHook(() => useLimitOrder())
    expect(result.current.orders).toEqual([])
  })
})

describe('useLimitOrder — createOrder', () => {
  it('builds params, signs EIP-712, and submits to CoW (happy path)', async () => {
    const { result } = renderHook(() => useLimitOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    expect(result.current.orders).toHaveLength(1)
    expect(result.current.orders[0].status).toBe('open')
    expect(result.current.orders[0].orderUid).toBe(FAKE_UID)
    expect(mockBuildLimitOrderParams).toHaveBeenCalledTimes(1)
    expect(mockSubmitLimitOrder).toHaveBeenCalledTimes(1)
  })

  it('passes the canonical CoW EIP-712 domain to signTypedDataAsync', async () => {
    const { result } = renderHook(() => useLimitOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const callArg = mockSignTypedDataAsync.mock.calls[0][0] as {
      domain: { name: string; version: string; verifyingContract: string; chainId: number }
      primaryType: string
    }
    expect(callArg.domain.name).toBe('Gnosis Protocol')
    expect(callArg.domain.version).toBe('v2')
    expect(callArg.domain.chainId).toBe(1)
    expect(callArg.domain.verifyingContract).toBe(COW_SETTLEMENT)
    expect(callArg.primaryType).toBe('Order')
  })

  it('sets receiver to the connected wallet (never a third party)', async () => {
    const { result } = renderHook(() => useLimitOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const callArg = mockSignTypedDataAsync.mock.calls[0][0] as {
      message: { receiver: string }
    }
    expect(callArg.message.receiver.toLowerCase()).toBe(
      '0x1111111111111111111111111111111111111111',
    )
  })

  it('marks the order as error when user rejects the signature', async () => {
    mockSignTypedDataAsync.mockRejectedValueOnce(
      Object.assign(new Error('User rejected the request.'), {
        name: 'UserRejectedRequestError',
      }),
    )
    const { result } = renderHook(() => useLimitOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    expect(result.current.orders[0].status).toBe('error')
    expect(result.current.orders[0].error).toMatch(/rejected/i)
    expect(result.current.isSubmitting).toBe(false)
    // submitLimitOrder must never run after a rejected signature.
    expect(mockSubmitLimitOrder).not.toHaveBeenCalled()
  })

  it('marks the order as error when submitLimitOrder rejects', async () => {
    mockSubmitLimitOrder.mockRejectedValueOnce(new Error('CoW 503: unavailable'))
    const { result } = renderHook(() => useLimitOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    expect(result.current.orders[0].status).toBe('error')
    expect(result.current.orders[0].error).toMatch(/cow|unavailable/i)
  })

  it('throws when wallet is disconnected', async () => {
    const wagmi = await import('wagmi')
    ;(wagmi.useAccount as ReturnType<typeof vi.fn>).mockReturnValue({ address: undefined })
    const { result } = renderHook(() => useLimitOrder())
    await expect(result.current.createOrder(makeConfig())).rejects.toThrow(/wallet not connected/i)
    // Restore default for subsequent tests in this file.
    ;(wagmi.useAccount as ReturnType<typeof vi.fn>).mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
    })
  })
})

describe('useLimitOrder — polling', () => {
  it('does NOT poll when there are no open orders', async () => {
    renderHook(() => useLimitOrder())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIMIT_POLL_INTERVAL_MS * 2)
    })
    expect(mockFetchLimitOrderStatus).not.toHaveBeenCalled()
  })

  it('polls open orders and transitions to fulfilled', async () => {
    mockFetchLimitOrderStatus.mockResolvedValue({
      status: 'fulfilled',
      executedBuyAmount: '3000000000',
      executedSellAmount: '1000000000000000000',
      txHash: '0xabc',
      filledPercent: 100,
    })
    const { result } = renderHook(() => useLimitOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    // The polling effect fires `pollAll()` immediately on mount (not
    // just on interval), so after the microtasks drain the order has
    // already transitioned.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIMIT_POLL_INTERVAL_MS)
      await Promise.resolve()
    })
    expect(result.current.orders[0].status).toBe('fulfilled')
    expect(result.current.latestEvent?.type).toBe('order_filled')
    expect(mockFetchLimitOrderStatus).toHaveBeenCalled()
  })

  it('transitions to expired when CoW reports expired', async () => {
    mockFetchLimitOrderStatus.mockResolvedValue({
      status: 'expired',
      executedBuyAmount: '0',
      executedSellAmount: '0',
      filledPercent: 0,
    })
    const { result } = renderHook(() => useLimitOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIMIT_POLL_INTERVAL_MS)
    })
    expect(result.current.orders[0].status).toBe('expired')
  })

  it('marks the order as partiallyFilled when fill is between 0 and 100', async () => {
    mockFetchLimitOrderStatus.mockResolvedValue({
      status: 'open',
      executedBuyAmount: '1500000000',
      executedSellAmount: '500000000000000000',
      filledPercent: 50,
    })
    const { result } = renderHook(() => useLimitOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIMIT_POLL_INTERVAL_MS)
    })
    expect(result.current.orders[0].status).toBe('partiallyFilled')
    expect(result.current.activeOrders).toHaveLength(1)
  })
})

describe('useLimitOrder — cancel + remove', () => {
  it('cancelOrder marks the order as cancelled locally', async () => {
    const { result } = renderHook(() => useLimitOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const orderId = result.current.orders[0].id
    await act(async () => {
      await result.current.cancelOrder(orderId)
    })
    expect(result.current.orders[0].status).toBe('cancelled')
  })

  it('removeOrder drops the order and persists the new list', async () => {
    const { result } = renderHook(() => useLimitOrder())
    await act(async () => {
      await result.current.createOrder(makeConfig())
    })
    const orderId = result.current.orders[0].id
    act(() => {
      result.current.removeOrder(orderId)
    })
    expect(result.current.orders).toHaveLength(0)
    const stored = JSON.parse(localStorage.getItem(LIMIT_STORAGE_KEY) || '[]')
    expect(stored).toHaveLength(0)
  })
})

describe('useLimitOrder — persistence', () => {
  it('reloading the hook (unmount + remount) restores orders from localStorage', async () => {
    vi.useRealTimers()
    const first = renderHook(() => useLimitOrder())
    await act(async () => {
      await first.result.current.createOrder(makeConfig())
    })
    expect(first.result.current.orders).toHaveLength(1)
    // Wait for the encrypted write (AES-GCM, real-async) before unmounting.
    await waitFor(() => {
      expect(localStorage.getItem(`${LIMIT_STORAGE_KEY}:v2`)).not.toBeNull()
    })
    first.unmount()

    const second = renderHook(() => useLimitOrder())
    await waitFor(() => expect(second.result.current.orders).toHaveLength(1))
    expect(second.result.current.orders[0].orderUid).toBe(FAKE_UID)
  })
})
