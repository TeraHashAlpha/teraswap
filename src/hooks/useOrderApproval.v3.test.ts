// @vitest-environment jsdom
/**
 * [BUG-DCA-APPROVE-SPENDER-V3] useOrderApproval — v3 spender resolution.
 *
 * Separate file from useOrderApproval.test.ts because it needs getOrderExecutorV3 to return a
 * NON-null address (v3 "deployed" on Base) to exercise the v3 branch — every other test in the
 * suite relies on v3 staying null (fail-closed default). Mirrors the useOrderEngine.v3.test.ts
 * mocking pattern.
 *
 * Pins the fix for the on-chain proven bug: a v3-signed DCA order (order.maxSlippageBps defined,
 * keeper resolves executor=v3) never filled because the approve() flow resolved the v2 executor
 * as spender (ETHFI.allowance(owner→OE_V3)=0, allowance(owner→OE_V2)=100e18). The spender MUST now
 * come from the exact same v2/v3 branch the signing path uses (resolveSigningExecutor), driven by
 * the caller-supplied isV3Order flag — never re-derived independently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockWriteContractAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockRefetchAllowance = vi.fn<() => Promise<unknown>>()
const mockReadContractImpl =
  vi.fn<(opts: { functionName: string }) => { data: unknown; refetch: () => Promise<unknown> }>()
const mockReceiptImpl =
  vi.fn<(opts?: { hash?: string; chainId?: number }) => { isSuccess: boolean; isError?: boolean }>()

const V3_ADDRESS = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0' as `0x${string}` // OE_V3 (Base, from the on-chain proof)

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: '0x1111111111111111111111111111111111111111' })),
  useReadContract: (opts: { functionName: string }) => mockReadContractImpl(opts),
  useWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
  useWaitForTransactionReceipt: (opts: { hash?: string; chainId?: number }) => mockReceiptImpl(opts),
}))

// [BUG-DCA-APPROVE-SPENDER-V3] Simulate v3 deployed on Base (8453) for this file only — mirrors
// useOrderEngine.v3.test.ts. Both getOrderExecutorV3 AND resolveSigningExecutor must be overridden:
// the real config.ts resolveSigningExecutor calls its OWN internal getOrderExecutorV3 (config's
// real env-driven lookup), not this module's re-export, so mocking only the re-export would leave
// resolveSigningExecutor resolving against the real (null) env-driven value.
vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return {
    ...actual,
    getOrderExecutorV3: (chainId: number) => (chainId === 8453 ? V3_ADDRESS : null),
    resolveSigningExecutor: (chainId: number, isV3Order: boolean) =>
      isV3Order ? (chainId === 8453 ? V3_ADDRESS : null) : actual.getOrderExecutor(chainId),
  }
})

import { renderHook, act } from '@testing-library/react'
import { useOrderApproval } from './useOrderApproval'
import { getOrderExecutor } from '@/lib/order-engine'

const ETHFI = '0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0b' as `0x${string}`
const TOTAL = 100_000_000_000_000_000_000n // 100e18, matching the on-chain repro amount

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteContractAsync.mockResolvedValue('0x' + 'ab'.repeat(32))
  mockRefetchAllowance.mockResolvedValue({ data: TOTAL })
  mockReceiptImpl.mockReturnValue({ isSuccess: false })
  mockReadContractImpl.mockImplementation(() => ({ data: 0n, refetch: mockRefetchAllowance }))
})

describe('useOrderApproval — v3 spender resolution [BUG-DCA-APPROVE-SPENDER-V3]', () => {
  it('resolves spender == getOrderExecutorV3(8453) for a v3 order (isV3Order=true), NOT the v2 executor', () => {
    const { result } = renderHook(() => useOrderApproval(ETHFI, TOTAL, 8453, true))
    expect(result.current.spender).toBe(V3_ADDRESS)
    expect(result.current.spender).not.toBe(getOrderExecutor(8453))
  })

  it('approve() sends approve(v3 executor, EXACT total) for a v3 order', async () => {
    const { result } = renderHook(() => useOrderApproval(ETHFI, TOTAL, 8453, true))
    await act(async () => { await result.current.approve() })
    const call = mockWriteContractAsync.mock.calls[0][0] as { args: [string, bigint]; chainId: number }
    expect(call.args[0]).toBe(V3_ADDRESS)
    expect(call.args[1]).toBe(TOTAL)
    expect(call.chainId).toBe(8453)
  })

  it('a v2 order (isV3Order=false, default) still resolves the v2 executor on the SAME chain (dark = byte-identical)', () => {
    const { result } = renderHook(() => useOrderApproval(ETHFI, TOTAL, 8453))
    expect(result.current.spender).toBe(getOrderExecutor(8453))
    expect(result.current.spender).not.toBe(V3_ADDRESS)
  })

  it('INVARIANT: approveSpender === signingExecutor for v3 mode (Base) and v2 mode, same chain', () => {
    const v3 = renderHook(() => useOrderApproval(ETHFI, TOTAL, 8453, true))
    const v2 = renderHook(() => useOrderApproval(ETHFI, TOTAL, 8453, false))
    // The signing path's own branch: isV3Order ? getOrderExecutorV3(chainId) : getOrderExecutor(chainId).
    expect(v3.result.current.spender).toBe(V3_ADDRESS)
    expect(v2.result.current.spender).toBe(getOrderExecutor(8453))
    expect(v3.result.current.spender).not.toBe(v2.result.current.spender)
  })

  it('mainnet (chainId 1) is unaffected by a v3-Base deployment — isV3Order=true resolves null there (fail-closed)', () => {
    const { result } = renderHook(() => useOrderApproval(ETHFI, TOTAL, 1, true))
    expect(result.current.spender).toBeNull()
    expect(result.current.needsApproval).toBe(false)
  })
})

// [BUG-DCA-APPROVE-SPENDER-V3] "Spender allowlist" requirement, resolved: the order-engine
// approval flow's trust boundary is NOT the Sprint-40 TRUSTED_SPENDER_ADDRESSES allowlist (that
// guard is scoped to /api/spender-fed instant-swap approvals — useOrderApproval's own docstring
// says so and useApproval.ts's isTrustedSpender() is never imported here). The order-engine
// spender is only ever a value resolveSigningExecutor(chainId, isV3Order) returns — itself only
// ever ORDER_EXECUTOR_BY_CHAIN[chainId] or ORDER_EXECUTOR_V3_BY_CHAIN[chainId] (registry/env
// constants), or null. There is no code path through which useOrderApproval's spender could ever
// be an arbitrary/attacker-controlled address, so no allowlist extension is needed — this pins
// that invariant so a future refactor that lets the spender come from user/API input would fail it.
describe('useOrderApproval — spender trust boundary [BUG-DCA-APPROVE-SPENDER-V3]', () => {
  it('never approves via the instant-swap allowlist module — the registry resolution IS the trust boundary', async () => {
    expect(useOrderApproval.toString()).not.toMatch(/isTrustedSpender/)
  })

  it('the resolved spender is always the registry v2 or v3 executor for the chain — never anything else', () => {
    const cases: Array<[number, boolean]> = [[1, false], [8453, false], [8453, true], [42161, false], [42161, true]]
    for (const [chainId, isV3Order] of cases) {
      const { result } = renderHook(() => useOrderApproval(ETHFI, TOTAL, chainId, isV3Order))
      const expected = isV3Order
        ? (chainId === 8453 ? V3_ADDRESS : null)
        : getOrderExecutor(chainId)
      expect(result.current.spender).toBe(expected)
    }
  })
})
