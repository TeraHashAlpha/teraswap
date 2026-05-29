// @vitest-environment jsdom
/**
 * [P115/M-01] useSwap — the security validators that protect users
 * from a misbehaving aggregator. We don't drive the wagmi-heavy happy
 * path here (that's PR-level coverage); we exercise the failure
 * branches that block a swap.
 *
 * The validator pipeline inside useSwap.execute() runs in this order:
 *   1. tx.data shape (length 10–200000)
 *   2. validateRouterAddress (whitelist)
 *   3. KNOWN_SWAP_SELECTORS (function-selector allowlist)
 *   4. validateCallDataRecipient (R1 — recipient must be msg.sender)
 *   5. validateFeeIntegrity (M-01 — output not implausibly high)
 *   6. PriceGuardError surfaced from /api/swap → priceGuardBlocked=true
 *
 * Tests pin each gate by feeding a tailored /api/swap response and
 * asserting the resulting `errorMessage` / `priceGuardBlocked` state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mocks (hoisted) ───
const mockSendTransaction = vi.fn()
const mockSignTypedData = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({
    address: '0x1111111111111111111111111111111111111111',
  })),
  useChainId: vi.fn(() => 1),
  useSendTransaction: vi.fn(() => ({
    sendTransaction: mockSendTransaction,
    data: undefined,
    error: null,
    reset: vi.fn(),
  })),
  useWaitForTransactionReceipt: vi.fn(() => ({
    data: undefined,
    isSuccess: false,
    isError: false,
  })),
  useSignTypedData: vi.fn(() => ({
    signTypedDataAsync: mockSignTypedData,
  })),
}))

// RPC client used by simulateSwapTx. Stub call() to a no-op so the
// simulation step doesn't crash before the validators run.
vi.mock('@/lib/rpc', () => ({
  getPrivateClient: vi.fn(() => ({
    call: vi.fn(async () => '0x'),
  })),
}))

// Default validators pass — individual tests override per case.
// Mocks return `{ valid, reason? }` shapes; we widen via type assertion
// so per-test mockReturnValueOnce() with a `reason` field doesn't fail
// TS narrowing on the default returns.
type ValidatorResult = { valid: boolean; reason?: string }
type RecipientResult = {
  valid: boolean
  extracted: string | null
  implicitRecipient: boolean
  reason?: string
}

const mockValidateRouterAddress = vi.fn<(...a: unknown[]) => ValidatorResult>(() => ({ valid: true }))
const mockValidateFeeIntegrity = vi.fn<(...a: unknown[]) => ValidatorResult>(() => ({ valid: true }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    validateRouterAddress: (...args: unknown[]) => mockValidateRouterAddress(...args),
    validateFeeIntegrity: (...args: unknown[]) => mockValidateFeeIntegrity(...args),
    usesFeeCollector: vi.fn(() => false), // skip FeeCollector wrapping for direct path
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

// Allow the real KNOWN_SWAP_SELECTORS set so we can construct a known
// selector for happy-path-ish cases.
vi.mock('@/lib/swap-selectors', async () => {
  const actual = await vi.importActual<typeof import('@/lib/swap-selectors')>('@/lib/swap-selectors')
  return actual
})

vi.mock('@/lib/analytics', () => ({
  logSwapToSupabase: vi.fn(),
  updateSwapStatus: vi.fn(),
}))

vi.mock('@/lib/wallet-activity-tracker', () => ({
  trackWalletActivity: vi.fn(),
}))

// [P156] The M-01 fee-integrity validator only runs when the source is in
// FEE_NATIVE_SOURCES (partner-fee mode). The live constant is currently
// empty, so without this mock the validator gate would skip the call and
// the "blocks the swap when validateFeeIntegrity fails" test below would
// never fire. We patch '1inch' into the list here so we can still verify
// the validator wiring; the empty-array invariant itself is pinned by
// src/hooks/__tests__/swap-validations.test.ts (A4b).
vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants')
  return {
    ...actual,
    FEE_NATIVE_SOURCES: ['1inch'],
  }
})

import { renderHook, act, waitFor } from '@testing-library/react'
import { useAccount } from 'wagmi'
import { useSwap } from './useSwap'
import { KNOWN_SWAP_SELECTORS } from '@/lib/swap-selectors'

// ─── Fixtures ───
import type { Token } from '@/lib/tokens'

const TOKEN_IN: Token = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  name: 'Wrapped Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native',
}

const TOKEN_OUT: Token = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '',
  category: 'Stablecoin',
}

// Pick a real selector from the allowlist so the selector-gate passes.
// We need a "known" 4-byte hex so the calldata-length + selector gates
// both let the validator under test fire.
const KNOWN_SELECTOR = Array.from(KNOWN_SWAP_SELECTORS)[0]
const ROUTER = '0x111111125421ca6dc452d289314280a0f8842a65'

/** Build a /api/swap response. Defaults pass all earlier gates so the
 *  caller can inject failure at the layer they want. */
function swapResponse(
  overrides: Partial<{ to: string; data: string; toAmount: string; value: string; gas: number; priceGuard: boolean; error: string; deviation: number }> = {},
) {
  return {
    source: '1inch',
    toAmount: '2950000000',
    estimatedGas: 150_000,
    gasUsd: 5,
    routes: [],
    tx: {
      to: overrides.to ?? ROUTER,
      data: overrides.data ?? `${KNOWN_SELECTOR}${'0'.repeat(128)}`,
      value: overrides.value ?? '0',
      gas: overrides.gas ?? 200_000,
    },
    ...(overrides.priceGuard ? { priceGuard: true, deviation: overrides.deviation ?? -0.15, error: overrides.error ?? 'price-guard block' } : {}),
  }
}

function mockSwapFetch(body: unknown, status = 200) {
  return vi.spyOn(global, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateRouterAddress.mockReturnValue({ valid: true })
  mockValidateFeeIntegrity.mockReturnValue({ valid: true })
  mockValidateCallDataRecipient.mockReturnValue({
    valid: true,
    extracted: '0x1111111111111111111111111111111111111111',
    implicitRecipient: false,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────
describe('useSwap — initialisation', () => {
  it('starts in idle state with no error', () => {
    const { result } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))
    expect(result.current.status).toBe('idle')
    expect(result.current.errorMessage).toBeNull()
    expect(result.current.priceGuardBlocked).toBe(false)
  })
})

describe('useSwap — security validators block bad /api/swap responses', () => {
  it('rejects truncated calldata (<10 chars) with a clear error', async () => {
    mockSwapFetch(swapResponse({ data: '0x' }))
    const { result } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))
    await act(async () => {
      await result.current.execute('1inch')
    })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMessage).toMatch(/empty|too short/i)
  })

  it('rejects oversized calldata (>100 KB hex) as a possible overflow attack', async () => {
    // 200_001 chars of payload — just over the limit.
    const huge = `${KNOWN_SELECTOR}${'0'.repeat(200_001)}`
    mockSwapFetch(swapResponse({ data: huge }))
    const { result } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))
    await act(async () => {
      await result.current.execute('1inch')
    })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMessage).toMatch(/abnormally large|rejected/i)
  })

  it('rejects an unknown swap function selector', async () => {
    // 0xdeadbeef is not in KNOWN_SWAP_SELECTORS.
    mockSwapFetch(swapResponse({ data: `0xdeadbeef${'0'.repeat(128)}` }))
    const { result } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))
    await act(async () => {
      await result.current.execute('1inch')
    })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMessage).toMatch(/unrecognized|selector/i)
  })

  it('blocks the swap when validateRouterAddress rejects the target', async () => {
    mockSwapFetch(swapResponse())
    mockValidateRouterAddress.mockReturnValueOnce({
      valid: false,
      reason: 'Router not whitelisted',
    })
    const { result } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))
    await act(async () => {
      await result.current.execute('1inch')
    })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMessage).toMatch(/not whitelisted/i)
    expect(mockValidateRouterAddress).toHaveBeenCalled()
  })

  it('blocks the swap when validateCallDataRecipient detects a recipient mismatch', async () => {
    mockSwapFetch(swapResponse())
    mockValidateCallDataRecipient.mockReturnValueOnce({
      valid: false,
      extracted: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      implicitRecipient: false,
      reason: 'recipient mismatch',
    })
    const { result } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))
    await act(async () => {
      await result.current.execute('1inch')
    })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMessage).toMatch(/recipient mismatch/i)
  })

  it('blocks the swap when validateFeeIntegrity fails (output implausibly high)', async () => {
    mockSwapFetch(swapResponse())
    mockValidateFeeIntegrity.mockReturnValueOnce({
      valid: false,
      reason: 'output exceeds quote by 2%',
    })
    // useSwap only calls validateFeeIntegrity when quoteToAmount is set.
    const { result } = renderHook(() =>
      useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5, '2900000000'),
    )
    await act(async () => {
      await result.current.execute('1inch')
    })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMessage).toMatch(/fee verification failed/i)
    expect(mockValidateFeeIntegrity).toHaveBeenCalled()
  })

  it('surfaces a PriceGuardError when /api/swap returns priceGuard:true on a non-200', async () => {
    mockSwapFetch(
      { error: 'Swap output deviates from oracle.', priceGuard: true, deviation: -0.18 },
      422,
    )
    const { result } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))
    await act(async () => {
      await result.current.execute('1inch')
    })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.priceGuardBlocked).toBe(true)
    expect(result.current.priceGuardDeviation).toBeCloseTo(-0.18, 2)
  })

  it('reset() returns the hook to idle and clears errors', async () => {
    mockSwapFetch(swapResponse({ data: '0x' }))
    const { result } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))

    await act(async () => {
      await result.current.execute('1inch')
    })
    expect(result.current.status).toBe('error')

    await act(async () => {
      result.current.reset()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.errorMessage).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
describe('useSwap — [FULL-M-04] swap-state reset on account change', () => {
  const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const DEFAULT_ADDR = '0x1111111111111111111111111111111111111111'

  // Restore the shared useAccount mock so a switched/disconnected address
  // doesn't leak into later suites (a leaked undefined address would make
  // executeStandardSwap early-return and break other tests).
  afterEach(() => {
    vi.mocked(useAccount).mockReturnValue({ address: DEFAULT_ADDR } as unknown as ReturnType<typeof useAccount>)
  })

  /** Drive the hook to a 'confirming' state with a non-null pendingSwap. */
  async function driveToConfirming(result: { current: ReturnType<typeof useSwap> }) {
    mockSwapFetch(swapResponse())
    await act(async () => {
      await result.current.execute('1inch')
    })
    expect(result.current.status).toBe('confirming')
    expect(result.current.pendingSwap).not.toBeNull()
  }

  it('clears pendingSwap and returns to idle when the account switches', async () => {
    vi.mocked(useAccount).mockReturnValue({ address: WALLET_A } as unknown as ReturnType<typeof useAccount>)
    const { result, rerender } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))
    await driveToConfirming(result)

    // Switch to a different wallet — stale pendingSwap must NOT survive.
    vi.mocked(useAccount).mockReturnValue({ address: WALLET_B } as unknown as ReturnType<typeof useAccount>)
    await act(async () => { rerender() })

    expect(result.current.status).toBe('idle')
    expect(result.current.pendingSwap).toBeNull()
  })

  it('clears swap state on disconnect', async () => {
    vi.mocked(useAccount).mockReturnValue({ address: WALLET_A } as unknown as ReturnType<typeof useAccount>)
    const { result, rerender } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))
    await driveToConfirming(result)

    vi.mocked(useAccount).mockReturnValue({ address: undefined } as unknown as ReturnType<typeof useAccount>)
    await act(async () => { rerender() })

    expect(result.current.status).toBe('idle')
    expect(result.current.pendingSwap).toBeNull()
  })

  it('does NOT reset on initial connect (undefined → address)', async () => {
    // prevAddressRef starts undefined; connecting must not wipe a fresh state.
    vi.mocked(useAccount).mockReturnValue({ address: undefined } as unknown as ReturnType<typeof useAccount>)
    const { result, rerender } = renderHook(() => useSwap(TOKEN_IN, TOKEN_OUT, '1', 0.5))

    vi.mocked(useAccount).mockReturnValue({ address: WALLET_A } as unknown as ReturnType<typeof useAccount>)
    await act(async () => { rerender() })

    // No pendingSwap was set, and connecting should leave us idle (not error).
    expect(result.current.status).toBe('idle')
    expect(result.current.pendingSwap).toBeNull()
  })
})
