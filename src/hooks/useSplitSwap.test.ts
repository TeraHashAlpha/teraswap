// @vitest-environment jsdom
/**
 * [P79/M-01 Phase 2] useSplitSwap — multi-leg execution + per-leg security validators.
 *
 * The hook walks `splitRoute.legs` and, for each leg, fetches calldata
 * from /api/swap, validates router/selector/recipient/fee-integrity, and
 * sends a transaction (direct or via FeeCollector). We pin the
 * security gates and the leg state machine; the wagmi-heavy receipt
 * flow is exercised by mocking the private RPC client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mocks (hoisted) ───
const mockSendTransactionAsync = vi.fn()
const mockGetTransactionReceipt = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({
    address: '0x1111111111111111111111111111111111111111',
  })),
  useChainId: vi.fn(() => 1),
  useSendTransaction: vi.fn(() => ({
    sendTransactionAsync: mockSendTransactionAsync,
    data: undefined,
    error: null,
    reset: vi.fn(),
  })),
  useSignTypedData: vi.fn(() => ({
    signTypedDataAsync: vi.fn(),
  })),
}))

// [SPRINT-9Q] useSplitSwap now resolves its receipt client via the chain-aware
// getPublicClientForChain (was the mainnet-pinned getPrivateClient). Mock that.
vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: vi.fn(() => ({
    getTransactionReceipt: mockGetTransactionReceipt,
  })),
}))

type ValidatorResult = { valid: boolean; reason?: string }
type RecipientResult = {
  valid: boolean
  extracted: string | null
  implicitRecipient: boolean
  reason?: string
}

const mockValidateFeeIntegrity = vi.fn<(...a: unknown[]) => ValidatorResult>(() => ({ valid: true }))
const mockValidateRouterAddress = vi.fn<(...a: unknown[]) => ValidatorResult>(() => ({ valid: true }))
const mockUsesFeeCollector = vi.fn<(...a: unknown[]) => boolean>(() => true)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    validateFeeIntegrity: (...args: unknown[]) => mockValidateFeeIntegrity(...args),
    validateRouterAddress: (...args: unknown[]) => mockValidateRouterAddress(...args),
    usesFeeCollector: (...args: unknown[]) => mockUsesFeeCollector(...args),
    submitCowOrder: vi.fn(),
    pollCowOrderStatus: vi.fn(),
  }
})

const mockValidateCallDataRecipient = vi.fn<(...a: unknown[]) => RecipientResult>(() => ({
  valid: true,
  extracted: '0x1111111111111111111111111111111111111111',
  implicitRecipient: false,
}))
vi.mock('@/lib/calldata-recipient', () => ({
  validateCallDataRecipient: (...args: unknown[]) => mockValidateCallDataRecipient(...args),
}))

vi.mock('@/lib/analytics', () => ({
  logSwapToSupabase: vi.fn(),
  updateSwapStatus: vi.fn(),
}))

// Keep the real selector allowlist — the hook reads it for selector
// validation and we construct calldata that passes / fails it.
vi.mock('@/lib/swap-selectors', async () => {
  const actual = await vi.importActual<typeof import('@/lib/swap-selectors')>('@/lib/swap-selectors')
  return actual
})

// [P210] Stub the per-leg pre-swap simulation (P207). buildSimulationTx is
// left real (pure calldata construction); only simulateSwapTx — the eth_call
// — is controlled so we can assert simulate→broadcast vs simulate→skip.
const mockSimulateSwapTx = vi.fn<(...a: unknown[]) => Promise<{ success: boolean; error?: string; simulated?: boolean }>>(
  async () => ({ success: true, simulated: true }),
)
vi.mock('@/lib/swap-simulation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/swap-simulation')>('@/lib/swap-simulation')
  return {
    ...actual,
    simulateSwapTx: (...args: unknown[]) => mockSimulateSwapTx(...args),
  }
})

import { renderHook, act, waitFor } from '@testing-library/react'
import { useAccount } from 'wagmi'
import { useSplitSwap } from './useSplitSwap'
import { KNOWN_SWAP_SELECTORS } from '@/lib/swap-selectors'
import type { Token } from '@/lib/tokens'
import type { SplitRoute, SplitLeg } from '@/lib/split-routing-types'
import type { NormalizedQuote } from '@/lib/api'
import { NATIVE_ETH } from '@/lib/constants'

const KNOWN_SELECTOR = Array.from(KNOWN_SWAP_SELECTORS)[0]
const ROUTER = '0x111111125421ca6dc452d289314280a0f8842a65'

const ETH: Token = {
  address: NATIVE_ETH,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native',
}

const WETH: Token = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  name: 'Wrapped Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native',
}

const USDC: Token = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '',
  category: 'Stablecoin',
}

function makeQuote(overrides: Partial<NormalizedQuote['tx']> & { toAmount?: string } = {}): NormalizedQuote {
  return {
    source: '1inch',
    toAmount: overrides.toAmount ?? '500000000', // 500 USDC
    estimatedGas: 150_000,
    gasUsd: 5,
    routes: [],
    tx: {
      to: overrides.to ?? ROUTER,
      data: overrides.data ?? `${KNOWN_SELECTOR}${'0'.repeat(128)}`,
      value: overrides.value ?? '0',
      gas: overrides.gas ?? 200_000,
    },
  } as unknown as NormalizedQuote
}

function makeLeg(source: '1inch' | '0x' | 'paraswap', percent: number, toAmount = '500000000'): SplitLeg {
  return {
    source: source as SplitLeg['source'],
    percent,
    inputAmount: '500000000000000000',
    outputAmount: toAmount,
    gasUsd: 3,
    quote: makeQuote({ toAmount }),
  }
}

function makeSplitRoute(...legs: SplitLeg[]): SplitRoute {
  // Force isSplit=true regardless of leg count — the hook short-circuits
  // when isSplit=false, but we want to exercise the per-leg validators
  // and state machine even with a single-leg fixture.
  return {
    legs,
    totalOutput: '0',
    totalGasUsd: legs.reduce((s, l) => s + l.gasUsd, 0),
    isSplit: true,
    improvementBps: 25,
  }
}

/** Mock /api/swap so the per-leg fetch resolves to a passing quote. */
function mockSwapFetch(
  responder: (body: { source: string; amount: string }) => unknown,
  status = 200,
) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (_url, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}')
    const payload = responder(body)
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // [SPRINT-9G G6] The active chain now derives from useAccount().chain (via
  // useActiveChainId). Reset to the default (mainnet, no explicit chain) each
  // test so a per-test override can't leak — clearAllMocks keeps implementations.
  vi.mocked(useAccount).mockReturnValue({
    address: '0x1111111111111111111111111111111111111111',
  } as unknown as ReturnType<typeof useAccount>)
  mockValidateFeeIntegrity.mockReturnValue({ valid: true })
  mockValidateRouterAddress.mockReturnValue({ valid: true })
  mockUsesFeeCollector.mockReturnValue(true)
  mockValidateCallDataRecipient.mockReturnValue({
    valid: true,
    extracted: '0x1111111111111111111111111111111111111111',
    implicitRecipient: false,
  })
  mockSendTransactionAsync.mockResolvedValue('0xabc' + '0'.repeat(61) as `0x${string}`)
  mockGetTransactionReceipt.mockResolvedValue({ status: 'success' })
  mockSimulateSwapTx.mockResolvedValue({ success: true, simulated: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// [SPRINT-9R R1] Drive the two-phase flow: execute() builds + freezes the plan (Phase A, no
// signing), then confirmPlan() signs it (Phase B). Confirms ONLY when a plan is awaiting review,
// so guard/error paths (which resolve before review) behave exactly as a bare execute() did.
async function runSplit(
  result: { current: { status: string; execute: (r: SplitRoute) => Promise<void>; confirmPlan: () => Promise<void> } },
  route: SplitRoute,
) {
  await act(async () => { await result.current.execute(route) })
  if (result.current.status === 'awaiting-review') {
    await act(async () => { await result.current.confirmPlan() })
  }
}

describe('useSplitSwap — initial state', () => {
  it('starts in idle state with no legs or error', () => {
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    expect(result.current.status).toBe('idle')
    expect(result.current.legs).toEqual([])
    expect(result.current.errorMessage).toBeNull()
    expect(result.current.completedLegs).toBe(0)
    expect(result.current.totalLegs).toBe(0)
  })
})

describe('useSplitSwap — guards', () => {
  it('does nothing when tokenIn is missing', async () => {
    const { result } = renderHook(() => useSplitSwap(null, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    expect(result.current.status).toBe('idle')
  })

  it('does nothing when tokenOut is missing', async () => {
    const { result } = renderHook(() => useSplitSwap(ETH, null, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    expect(result.current.status).toBe('idle')
  })

  it('does nothing when wallet is disconnected (address undefined)', async () => {
    const wagmi = await import('wagmi')
    ;(wagmi.useAccount as ReturnType<typeof vi.fn>).mockReturnValueOnce({ address: undefined })
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    expect(result.current.status).toBe('idle')
  })

  it('rejects an invalid amountIn (parseUnits throws) with an error status', async () => {
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, 'not-a-number', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    expect(result.current.status).toBe('error')
    expect(result.current.errorMessage).toMatch(/invalid input amount/i)
  })
})

describe('useSplitSwap — happy path', () => {
  it('completes a 2-leg FeeCollector swap and runs each per-leg validator twice', async () => {
    mockSwapFetch(() => makeQuote())
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.completedLegs).toBe(2)
    expect(mockValidateFeeIntegrity).toHaveBeenCalledTimes(2)
    expect(mockValidateRouterAddress).toHaveBeenCalledTimes(2)
    expect(mockValidateCallDataRecipient).toHaveBeenCalledTimes(2)
  })

  it('splits the input amount per leg: leg.amount = (totalRaw * percent) / 100', async () => {
    // totalRaw = parseUnits('1', 18) = 10^18. 60/40 split → 6e17, 4e17.
    // FeeCollector wrapping subtracts FEE_BPS (default 10) → 10^17 * 6 * (1 - 10/10_000).
    const calls: string[] = []
    mockSwapFetch((body) => {
      calls.push(body.amount)
      return makeQuote()
    })
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(calls).toHaveLength(2)
    // 6e17 * (10_000 - 10) / 10_000 = 599400000000000000
    expect(calls[0]).toBe('599400000000000000')
    // 4e17 * (10_000 - 10) / 10_000 = 399600000000000000
    expect(calls[1]).toBe('399600000000000000')
  })

  it('routes ETH → token via swapETHWithFee (FeeCollector path)', async () => {
    mockSwapFetch(() => makeQuote())
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('success'))
    // swapETHWithFee selector = first 4 bytes of keccak256("swapETHWithFee(address,bytes,address,uint256)").
    // Easier check: the call has a non-zero `value` (we sent ETH).
    const txArg = mockSendTransactionAsync.mock.calls[0][0]
    expect(txArg.value).toBeGreaterThan(0n)
  })

  it('routes token → token via swapTokenWithFee (FeeCollector path, no ETH value)', async () => {
    mockSwapFetch(() => makeQuote())
    const { result } = renderHook(() => useSplitSwap(WETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('success'))
    const txArg = mockSendTransactionAsync.mock.calls[0][0]
    expect(txArg.value).toBe(0n)
  })
})

describe('useSplitSwap — security validator failures', () => {
  it('rejects truncated calldata (<10 chars)', async () => {
    mockSwapFetch(() => makeQuote({ data: '0x' }))
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.legs[0].error).toMatch(/calldata|short/i)
  })

  it('rejects oversized calldata (>200k chars)', async () => {
    const huge = `${KNOWN_SELECTOR}${'0'.repeat(200_001)}` as `0x${string}`
    mockSwapFetch(() => makeQuote({ data: huge }))
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.legs[0].error).toMatch(/abnormally large|injection/i)
  })

  it('rejects an unknown swap selector', async () => {
    mockSwapFetch(() => makeQuote({ data: `0xdeadbeef${'0'.repeat(128)}` }))
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.legs[0].error?.toLowerCase()).toContain('unknown swap selector')
  })

  it('rejects when validateCallDataRecipient fails', async () => {
    mockSwapFetch(() => makeQuote())
    mockValidateCallDataRecipient.mockReturnValueOnce({
      valid: false,
      extracted: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      implicitRecipient: false,
      reason: 'recipient mismatch',
    })
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.legs[0].error).toMatch(/recipient/i)
  })

  it('rejects when validateFeeIntegrity returns false', async () => {
    mockSwapFetch(() => makeQuote())
    mockValidateFeeIntegrity.mockReturnValueOnce({ valid: false, reason: 'too high' })
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.legs[0].error).toMatch(/fee integrity/i)
  })

  it('rejects when validateRouterAddress fails', async () => {
    mockSwapFetch(() => makeQuote())
    mockValidateRouterAddress.mockReturnValueOnce({ valid: false, reason: 'Router not whitelisted' })
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.legs[0].error).toMatch(/not whitelisted|router/i)
  })
})

describe('useSplitSwap — partial / mixed outcomes', () => {
  it('marks status=partial when first leg succeeds but second fails', async () => {
    let call = 0
    mockSwapFetch(() => {
      call++
      // Second leg returns an unknown selector → fails inside the loop.
      if (call === 2) return makeQuote({ data: `0xdeadbeef${'0'.repeat(128)}` })
      return makeQuote()
    })
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('partial'))
    expect(result.current.completedLegs).toBe(1)
    expect(result.current.errorMessage).toMatch(/1\/2.*failed/i)
  })

  it('aborts remaining legs when user rejects the first', async () => {
    mockSwapFetch(() => makeQuote())
    const rejected = Object.assign(new Error('User rejected the request.'), {
      name: 'UserRejectedRequestError',
    })
    mockSendTransactionAsync.mockRejectedValueOnce(rejected)
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('error'))
    // The leg-local error is the canonical signal; the global errorMessage
    // is overwritten by the final status block (stale-closure on the
    // freshly-set state), so we pin behavior at the leg level.
    expect(result.current.legs[0].error).toMatch(/rejected/i)
    // Only one sendTransactionAsync call (the second leg was aborted).
    expect(mockSendTransactionAsync).toHaveBeenCalledTimes(1)
  })

  it('marks the leg as error when receipt is reverted', async () => {
    mockSwapFetch(() => makeQuote())
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' })
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.legs[0].error).toMatch(/reverted/i)
  })
})

describe('useSplitSwap — [P207] per-leg pre-swap simulation', () => {
  it('simulates each leg before broadcast', async () => {
    mockSwapFetch(() => makeQuote())
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('success'))
    // One simulation + one broadcast per leg.
    expect(mockSimulateSwapTx).toHaveBeenCalledTimes(2)
    expect(mockSendTransactionAsync).toHaveBeenCalledTimes(2)
    // Simulation runs BEFORE the wallet prompt for the first leg.
    expect(mockSimulateSwapTx.mock.invocationCallOrder[0])
      .toBeLessThan(mockSendTransactionAsync.mock.invocationCallOrder[0])
  })

  it('skips leg on simulation failure', async () => {
    mockSwapFetch(() => makeQuote())
    // Leg 1 simulation reverts, leg 2 passes.
    mockSimulateSwapTx
      .mockResolvedValueOnce({ success: false, error: 'Swap output below minimum — leg would revert' })
      .mockResolvedValue({ success: true, simulated: true })
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('partial'))
    // Leg 1 was skipped before broadcast; leg 2 proceeded.
    expect(result.current.legs[0].status).toBe('error')
    expect(result.current.legs[0].error).toMatch(/revert/i)
    expect(result.current.legs[1].status).toBe('success')
    expect(mockSendTransactionAsync).toHaveBeenCalledTimes(1)
  })

  it('aborts all legs if all simulations fail', async () => {
    mockSwapFetch(() => makeQuote())
    mockSimulateSwapTx.mockResolvedValue({ success: false, error: 'Simulation reverted' })
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.legs.every(l => l.status === 'error')).toBe(true)
    expect(mockSendTransactionAsync).not.toHaveBeenCalled()
  })

  // [P209 / P210 review] Fail-open: an inconclusive sim (simulated:false) must
  // NOT skip the leg — it broadcasts and is flagged. Mirrors the single-swap
  // simulationSkipped test in useSwap.test.ts.
  it('flags a leg whose simulation is inconclusive (simulated:false) but still broadcasts it', async () => {
    mockSwapFetch(() => makeQuote())
    mockSimulateSwapTx
      .mockResolvedValueOnce({ success: true, simulated: false }) // leg 1: RPC hiccup, fail-open
      .mockResolvedValue({ success: true, simulated: true })       // leg 2: conclusive pass
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('success'))
    // Fail-open, not fail-closed: both legs broadcast.
    expect(mockSendTransactionAsync).toHaveBeenCalledTimes(2)
    // The inconclusive leg is flagged; the conclusive one is not.
    expect(result.current.legs[0].simulated).toBe(false)
    expect(result.current.legs[0].status).toBe('success')
    expect(result.current.legs[1].simulated).not.toBe(false)
  })
})

describe('useSplitSwap — [P221] chainId threading', () => {
  it('forwards the active chainId to each per-leg swap API call', async () => {
    // [SPRINT-9G G6] The active chain is now useActiveChainId() (the wallet
    // chain), not wagmi useChainId() — so set it via useAccount().chain.
    vi.mocked(useAccount).mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      chain: { id: 8453 },
    } as unknown as ReturnType<typeof useAccount>)
    // [P225] Use a DIRECT (non-FeeCollector) leg: Base has no FeeCollector
    // deployed yet, so a fee-routed leg would (correctly) throw. We only assert
    // that chainId reaches the per-leg API body — which happens before routing.
    mockUsesFeeCollector.mockReturnValue(false)

    const bodies: Array<Record<string, unknown>> = []
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init?: RequestInit) => {
      bodies.push(JSON.parse((init?.body as string) ?? '{}'))
      return new Response(JSON.stringify(makeQuote()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('success'))

    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies[0]).toHaveProperty('chainId', 8453)
  })
})

describe('useSplitSwap — reset()', () => {
  it('returns to idle and clears legs after an error', async () => {
    mockSwapFetch(() => makeQuote({ data: '0x' }))
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('error'))

    act(() => {
      result.current.reset()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.legs).toEqual([])
    expect(result.current.errorMessage).toBeNull()
  })
})

describe('useSplitSwap — safeBigInt guard [10-L-01]', () => {
  it('defaults legMinOutput to 0 when toAmount is malformed', async () => {
    // A toAmount that can't be parsed as bigint — the hook should
    // still execute without throwing and the FeeCollector args should
    // encode 0 as the minimumOutput.
    mockSwapFetch(() => makeQuote({ toAmount: 'not-a-number' }))
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100, 'not-a-number'))
    await runSplit(result, route)
    await waitFor(() => expect(result.current.status).toBe('success'))
    // sendTransactionAsync was called — meaning encoding didn't throw
    // and legMinOutput defaulted to 0n.
    expect(mockSendTransactionAsync).toHaveBeenCalledOnce()
  })
})

// [SPRINT-9G G6] One chain-id source of truth: useSplitSwap must build each leg
// for useActiveChainId() (same as the quote pipeline), not a divergent wagmi
// useChainId().
describe('useSplitSwap — chain-id source of truth [SPRINT-9G G6]', () => {
  it('builds each leg on the ACTIVE (wallet) chain, not a divergent wagmi useChainId', async () => {
    // Wallet on Base (8453) while wagmi useChainId() still reports mainnet (1).
    vi.mocked(useAccount).mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      chain: { id: 8453 },
    } as unknown as ReturnType<typeof useAccount>)
    mockUsesFeeCollector.mockReturnValue(false) // skip FeeCollector path → reach the router check
    mockSwapFetch(() => makeQuote())

    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await runSplit(result, route)

    expect(mockValidateRouterAddress).toHaveBeenCalled()
    expect(mockValidateRouterAddress.mock.calls[0][2]).toBe(8453)
  })
})

describe('useSplitSwap — [SPRINT-9R R1] review gate (no signature without review)', () => {
  it('execute() freezes the plan and NEVER signs — confirmPlan is required to broadcast', async () => {
    mockSwapFetch(() => makeQuote())
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await act(async () => { await result.current.execute(route) })
    // Phase A complete: plan frozen, awaiting review, NOT a single wallet prompt yet.
    expect(result.current.status).toBe('awaiting-review')
    expect(mockSendTransactionAsync).not.toHaveBeenCalled()
    // The plan lists EVERY leg, all reviewed, with per-leg validation already run in Phase A.
    expect(result.current.plannedLegs).toHaveLength(2)
    expect(result.current.plannedLegs.every(p => p.status === 'reviewed')).toBe(true)
    expect(mockValidateRouterAddress).toHaveBeenCalledTimes(2)
    expect(mockValidateCallDataRecipient).toHaveBeenCalledTimes(2)
    // Confirm → exactly one wallet prompt per reviewed leg.
    await act(async () => { await result.current.confirmPlan() })
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(mockSendTransactionAsync).toHaveBeenCalledTimes(2)
  })

  it('confirmPlan() is a no-op unless status is awaiting-review (no stale/unreviewed signature)', async () => {
    mockSwapFetch(() => makeQuote())
    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    // No plan was built → confirmPlan must not sign anything.
    await act(async () => { await result.current.confirmPlan() })
    expect(mockSendTransactionAsync).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('a rebuild re-reviews: re-running execute() refreshes the frozen plan; confirmPlan signs the REBUILT calldata, never the stale one', async () => {
    mockUsesFeeCollector.mockReturnValue(false) // direct route → txData === router calldata, easy to assert
    const CALLDATA_A = `${KNOWN_SELECTOR}${'a'.repeat(128)}` as `0x${string}`
    const CALLDATA_B = `${KNOWN_SELECTOR}${'b'.repeat(128)}` as `0x${string}`
    let data: `0x${string}` = CALLDATA_A
    mockSwapFetch(() => makeQuote({ data }))
    const { result } = renderHook(() => useSplitSwap(WETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))

    // Build plan v1 (calldata A) — frozen, awaiting review.
    await act(async () => { await result.current.execute(route) })
    expect(result.current.status).toBe('awaiting-review')
    expect(result.current.plannedLegs[0].txData).toBe(CALLDATA_A)

    // REBUILD before signing (e.g. a retry / quote refresh produced new calldata) → re-review.
    data = CALLDATA_B
    await act(async () => { await result.current.execute(route) })
    expect(result.current.status).toBe('awaiting-review')
    expect(result.current.plannedLegs[0].txData).toBe(CALLDATA_B)

    // Confirm signs the REVIEWED (rebuilt) calldata, never the stale A.
    await act(async () => { await result.current.confirmPlan() })
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(mockSendTransactionAsync).toHaveBeenCalledTimes(1)
    expect(mockSendTransactionAsync.mock.calls[0][0].data).toBe(CALLDATA_B)
  })
})

// [SPRINT-9R audit] The two-phase review-pause holds a frozen plan in 'awaiting-review' for an
// indefinite, human-paced wait. These guard the conditions that must INVALIDATE that frozen plan —
// the parity gaps the auditor flagged (the single-swap useSwap already does all three).
describe('useSplitSwap — [SPRINT-9R audit] frozen-plan invalidation', () => {
  it('discards the frozen plan on an account switch (FULL-M-04 parity) — confirmPlan cannot sign wallet-A calldata under wallet B', async () => {
    mockSwapFetch(() => makeQuote())
    const { result, rerender } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await act(async () => { await result.current.execute(route) })
    expect(result.current.status).toBe('awaiting-review')
    expect(result.current.plannedLegs).toHaveLength(1)

    // Wallet switches account while the Review Split Plan modal would be open.
    vi.mocked(useAccount).mockReturnValue({
      address: '0x2222222222222222222222222222222222222222',
    } as unknown as ReturnType<typeof useAccount>)
    await act(async () => { rerender() })

    // The frozen plan is discarded → modal closes, nothing to confirm.
    expect(result.current.status).toBe('idle')
    expect(result.current.plannedLegs).toEqual([])
    // A late confirm cannot broadcast wallet-A calldata under wallet B.
    await act(async () => { await result.current.confirmPlan() })
    expect(mockSendTransactionAsync).not.toHaveBeenCalled()
  })

  it('discards the frozen plan on a chain switch (P219 parity) — never broadcasts a chain-A plan onto chain B', async () => {
    mockSwapFetch(() => makeQuote())
    const { result, rerender } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 100))
    await act(async () => { await result.current.execute(route) })
    expect(result.current.status).toBe('awaiting-review')

    // Wallet switches chain (mainnet → Base) while the plan sits frozen.
    vi.mocked(useAccount).mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      chain: { id: 8453 },
    } as unknown as ReturnType<typeof useAccount>)
    await act(async () => { rerender() })

    expect(result.current.status).toBe('idle')
    expect(result.current.plannedLegs).toEqual([])
    await act(async () => { await result.current.confirmPlan() })
    expect(mockSendTransactionAsync).not.toHaveBeenCalled()
  })

  it('refuses to rebuild while Phase B is broadcasting — a swap-button re-click cannot double-broadcast in-flight legs', async () => {
    mockSwapFetch(() => makeQuote())
    // Hang the FIRST signature so the hook stays in 'executing' across the re-entry attempt.
    let release!: (v: `0x${string}`) => void
    const pending = new Promise<`0x${string}`>(r => { release = r })
    mockSendTransactionAsync.mockReturnValueOnce(pending)

    const { result } = renderHook(() => useSplitSwap(ETH, USDC, '1', 0.5))
    const route = makeSplitRoute(makeLeg('1inch', 60), makeLeg('0x', 40))
    await act(async () => { await result.current.execute(route) })
    expect(result.current.status).toBe('awaiting-review')

    // Start Phase B but DON'T await — the first leg's signature is pending.
    let confirmDone!: Promise<void>
    await act(async () => { confirmDone = result.current.confirmPlan() })
    expect(result.current.status).toBe('executing')
    const callsDuringHang = mockSendTransactionAsync.mock.calls.length

    // A concurrent rebuild attempt (button still clickable — it reads the single-swap status) is a no-op.
    await act(async () => { await result.current.execute(route) })
    expect(result.current.status).toBe('executing')        // not reset back to 'planning'
    expect(mockSendTransactionAsync.mock.calls.length).toBe(callsDuringHang) // no extra broadcast

    // Release the in-flight signature; the ORIGINAL Phase B run completes normally (2 legs, no dup).
    release('0xabc' + '0'.repeat(61) as `0x${string}`)
    await act(async () => { await confirmDone })
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(mockSendTransactionAsync).toHaveBeenCalledTimes(2)
  })
})
