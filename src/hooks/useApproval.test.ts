// @vitest-environment jsdom
/**
 * [P115/M-01] useApproval — approval planning + execution gate.
 *
 * The hook decides whether the user needs to approve the swap router
 * before executing, and surfaces a plan to the UI. Tests pin the
 * security-relevant decision tree:
 *
 *   - Native ETH                              → no approval needed
 *   - ERC-20 with sufficient existing allowance → no approval needed
 *   - ERC-20 without allowance                → on-chain approve required
 *   - Token absent or amount = 0              → no plan
 *
 * Permit2 education-modal branches (status='awaiting_permit2_education')
 * are dormant in production — the hook always selects `method: 'exact'`
 * (see useApproval.ts:100-108). They're left here as a smoke check for
 * the helper exports; pinning end-to-end Permit2 flow needs a wallet
 * sandbox we don't have in the unit layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock wagmi BEFORE the hook import. Each useReadContract caller in
// the hook is distinguished by its `functionName`, so the factory
// branches on that.
let permit2TokenAllowance: bigint | undefined = undefined
let directAllowance: bigint | undefined = undefined
let noncesData: bigint | undefined = undefined
let noncesError = false

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: '0x1111111111111111111111111111111111111111' })),
  useReadContract: vi.fn((opts: { functionName: string; args?: unknown[]; query?: { enabled?: boolean } }) => {
    if (opts.query?.enabled === false) return { data: undefined, isError: false, refetch: vi.fn() }
    if (opts.functionName === 'nonces') {
      return { data: noncesData, isError: noncesError, refetch: vi.fn() }
    }
    if (opts.functionName === 'allowance') {
      // The hook calls allowance() twice: once with PERMIT2 as spender,
      // once with the actual spender. Branch on args[1].
      const spender = opts.args?.[1] as string | undefined
      const isPermit2 = spender?.toLowerCase() === '0x000000000022d473030f116ddee9f6b43ac78ba3'
      return {
        data: isPermit2 ? permit2TokenAllowance : directAllowance,
        isError: false,
        refetch: vi.fn(),
      }
    }
    return { data: undefined, isError: false, refetch: vi.fn() }
  }),
  useWriteContract: vi.fn(() => ({
    writeContract: vi.fn(),
    data: undefined,
    error: null,
    reset: vi.fn(),
  })),
  useWaitForTransactionReceipt: vi.fn(() => ({
    isSuccess: false,
    isError: false,
  })),
  useSignTypedData: vi.fn(() => ({
    signTypedDataAsync: vi.fn(),
  })),
}))

vi.mock('@/lib/wallet-activity-tracker', () => ({
  trackWalletActivity: vi.fn(),
}))

vi.mock('@/components/Permit2EducationModal', () => ({
  isPermit2Educated: vi.fn(() => false),
}))

import { renderHook } from '@testing-library/react'
import { useApproval } from './useApproval'
import { isNativeETH, type Token } from '@/lib/tokens'

const ETH: Token = {
  address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`,
  symbol: 'ETH',
  name: 'Ethereum',
  decimals: 18,
} as unknown as Token

const USDC: Token = {
  address: '0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
} as unknown as Token

const SPENDER = '0x111111125421ca6dc452d289314280a0f8842a65' as `0x${string}`

beforeEach(() => {
  vi.clearAllMocks()
  permit2TokenAllowance = undefined
  directAllowance = undefined
  noncesData = undefined
  noncesError = false
})

describe('useApproval', () => {
  it('returns a no-op plan for native ETH (no on-chain approval needed)', () => {
    // Sanity check the helper our hook relies on.
    expect(isNativeETH(ETH)).toBe(true)

    const { result } = renderHook(() => useApproval(ETH, '1', SPENDER))
    expect(result.current.plan).not.toBeNull()
    expect(result.current.plan?.needsOnChainApprove).toBe(false)
    expect(result.current.plan?.label).toMatch(/no approval/i)
    expect(result.current.isReady).toBe(true)
  })

  it('returns plan=null when no token is selected', () => {
    const { result } = renderHook(() => useApproval(null, '1', SPENDER))
    expect(result.current.plan).toBeNull()
  })

  it('returns plan=null for zero-amount input', () => {
    const { result } = renderHook(() => useApproval(USDC, '0', SPENDER))
    expect(result.current.plan).toBeNull()
  })

  it('returns plan=null for empty-string amount', () => {
    const { result } = renderHook(() => useApproval(USDC, '', SPENDER))
    expect(result.current.plan).toBeNull()
  })

  it('treats invalid amount (NaN, bad decimals) as zero — no plan', () => {
    const { result } = renderHook(() => useApproval(USDC, '1.2.3', SPENDER))
    expect(result.current.plan).toBeNull()
  })

  it('skips approval when the user already has sufficient direct allowance', () => {
    // 1000 USDC = 10^9 (USDC has 6 decimals). User has 10^10 allowed.
    directAllowance = 10n ** 10n
    const { result } = renderHook(() => useApproval(USDC, '1000', SPENDER))
    expect(result.current.plan?.needsOnChainApprove).toBe(false)
    expect(result.current.plan?.label).toMatch(/existing approval/i)
    expect(result.current.isReady).toBe(true)
  })

  it('requires an exact on-chain approval when allowance is insufficient', () => {
    directAllowance = 0n
    const { result } = renderHook(() => useApproval(USDC, '1000', SPENDER))
    expect(result.current.plan?.needsOnChainApprove).toBe(true)
    expect(result.current.plan?.method).toBe('exact')
    expect(result.current.plan?.label).toMatch(/exact approval/i)
    expect(result.current.isReady).toBe(false)
  })

  it('still requires approval when allowance exists but is below the requested amount', () => {
    // Half what we're trying to swap.
    directAllowance = 500n * 10n ** 6n
    const { result } = renderHook(() => useApproval(USDC, '1000', SPENDER))
    expect(result.current.plan?.needsOnChainApprove).toBe(true)
  })

  it('does not throw when spenderAddress is undefined (allowance check disabled)', () => {
    expect(() =>
      renderHook(() => useApproval(USDC, '1000', undefined)),
    ).not.toThrow()
  })

  it('starts in `idle` status when on-chain approval is required', () => {
    directAllowance = 0n
    const { result } = renderHook(() => useApproval(USDC, '1000', SPENDER))
    expect(result.current.status).toBe('idle')
    expect(result.current.needsPermit2Education).toBe(false)
  })

  it('detects EIP-2612 support: nonces() succeeds → token supports permit', () => {
    noncesData = 0n
    noncesError = false
    // The hook still chooses `method: 'exact'` for safety, but
    // nonces support is wired through in case Permit2 ever lights up.
    directAllowance = 0n
    const { result } = renderHook(() => useApproval(USDC, '1000', SPENDER))
    expect(result.current.plan?.method).toBe('exact')
  })

  it('detects no EIP-2612 support: nonces() errors → falls back to exact', () => {
    noncesData = undefined
    noncesError = true
    directAllowance = 0n
    const { result } = renderHook(() => useApproval(USDC, '1000', SPENDER))
    expect(result.current.plan?.method).toBe('exact')
    expect(result.current.plan?.needsOnChainApprove).toBe(true)
  })
})
