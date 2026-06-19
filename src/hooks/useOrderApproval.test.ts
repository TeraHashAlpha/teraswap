// @vitest-environment jsdom
/**
 * [CHORE-DCA-APPROVAL-FLOW] useOrderApproval — one-time EXACT ERC-20 approval gate for the
 * TeraSwapOrderExecutor.
 *
 * Pins the security invariants the chore requires:
 *   - the gate is CLOSED (needsApproval) when allowance < the FULL signed total;
 *   - approve() writes approve(executor, EXACT total) — NEVER max-uint, spender = the executor
 *     resolved per chainId (mainnet vs Base), never hardcoded;
 *   - the gate OPENS (isApproved) once allowance >= the full total;
 *   - DCA approves the TOTAL (not the per-chunk amountIn/dcaTotal);
 *   - fail-closed on an unwired chain (no executor → no spender, no approve).
 *
 * Mirrors the useOrderEngine.test harness: vi.mock('wagmi') with useReadContract dispatching on
 * functionName, useWriteContract → mockWriteContractAsync, useWaitForTransactionReceipt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockWriteContractAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockRefetchAllowance = vi.fn<() => Promise<unknown>>()
const mockReadContractImpl =
  vi.fn<(opts: { functionName: string }) => { data: unknown; refetch: () => Promise<unknown> }>()
const mockReceiptImpl = vi.fn<() => { isSuccess: boolean }>()

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: '0x1111111111111111111111111111111111111111' })),
  useReadContract: (opts: { functionName: string }) => mockReadContractImpl(opts),
  useWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
  useWaitForTransactionReceipt: () => mockReceiptImpl(),
}))

import { renderHook, act } from '@testing-library/react'
import { useOrderApproval } from './useOrderApproval'
import { getOrderExecutor } from '@/lib/order-engine'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`
const TOTAL = 1_000_000_000_000_000_000n // 1 WETH — the FULL signed total
const MAX_UINT256 = 2n ** 256n - 1n

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteContractAsync.mockResolvedValue('0x' + 'ab'.repeat(32))
  mockRefetchAllowance.mockResolvedValue({ data: TOTAL })
  mockReceiptImpl.mockReturnValue({ isSuccess: false })
  // Default: zero allowance → gate closed.
  mockReadContractImpl.mockImplementation(() => ({ data: 0n, refetch: mockRefetchAllowance }))
})

describe('useOrderApproval — allowance gate', () => {
  it('needs approval when allowance < the full signed total', () => {
    mockReadContractImpl.mockImplementation(() => ({ data: 0n, refetch: mockRefetchAllowance }))
    const { result } = renderHook(() => useOrderApproval(WETH, TOTAL, 1))
    expect(result.current.needsApproval).toBe(true)
    expect(result.current.isApproved).toBe(false)
    expect(result.current.spender).toBe(getOrderExecutor(1))
  })

  it('is approved (gate open) when allowance >= the full total', () => {
    mockReadContractImpl.mockImplementation(() => ({ data: TOTAL, refetch: mockRefetchAllowance }))
    const { result } = renderHook(() => useOrderApproval(WETH, TOTAL, 1))
    expect(result.current.isApproved).toBe(true)
    expect(result.current.needsApproval).toBe(false)
  })

  it('a per-CHUNK allowance does NOT satisfy the gate — the full TOTAL is required (DCA)', () => {
    // DCA total split into 10 buys; approving only one chunk must NOT open the gate.
    const perChunk = TOTAL / 10n
    mockReadContractImpl.mockImplementation(() => ({ data: perChunk, refetch: mockRefetchAllowance }))
    const { result } = renderHook(() => useOrderApproval(WETH, TOTAL, 1))
    expect(result.current.isApproved).toBe(false)
    expect(result.current.needsApproval).toBe(true)
  })

  it('treats an unresolved allowance as not-yet-approved (fail-closed)', () => {
    mockReadContractImpl.mockImplementation(() => ({ data: undefined, refetch: mockRefetchAllowance }))
    const { result } = renderHook(() => useOrderApproval(WETH, TOTAL, 1))
    expect(result.current.isApproved).toBe(false)
    expect(result.current.needsApproval).toBe(true)
  })
})

describe('useOrderApproval — exact approve (no max-uint, chain-aware spender)', () => {
  it('approve() calls writeContract with approve(executor, EXACT total) and NEVER max-uint (mainnet)', async () => {
    const { result } = renderHook(() => useOrderApproval(WETH, TOTAL, 1))
    await act(async () => { await result.current.approve() })
    expect(mockWriteContractAsync).toHaveBeenCalledTimes(1)
    const call = mockWriteContractAsync.mock.calls[0][0] as {
      address: string; functionName: string; args: [string, bigint]; chainId: number
    }
    expect(call.functionName).toBe('approve')
    expect(call.address).toBe(WETH)
    expect(call.args[0]).toBe(getOrderExecutor(1)) // spender = mainnet executor (resolved, not hardcoded)
    expect(call.args[1]).toBe(TOTAL)                // EXACT total
    expect(call.args[1]).not.toBe(MAX_UINT256)      // never infinite
    expect(call.chainId).toBe(1)
  })

  it('resolves the spender per chainId — Base (8453) approves the Base executor, not mainnet', async () => {
    const { result } = renderHook(() => useOrderApproval(WETH, TOTAL, 8453))
    expect(result.current.spender).toBe(getOrderExecutor(8453))
    expect(result.current.spender).not.toBe(getOrderExecutor(1))
    await act(async () => { await result.current.approve() })
    const call = mockWriteContractAsync.mock.calls[0][0] as { args: [string, bigint]; chainId: number }
    expect(call.args[0]).toBe(getOrderExecutor(8453))
    expect(call.chainId).toBe(8453)
  })

  it('fail-closed on an unwired chain — no spender, no approve tx', async () => {
    const { result } = renderHook(() => useOrderApproval(WETH, TOTAL, 42161)) // Arbitrum — no executor
    expect(result.current.spender).toBeNull()
    expect(result.current.needsApproval).toBe(false)
    await act(async () => { await result.current.approve() })
    expect(mockWriteContractAsync).not.toHaveBeenCalled()
  })

  it('never approves max-uint even when amountIn is large', async () => {
    const big = MAX_UINT256 - 1n
    mockReadContractImpl.mockImplementation(() => ({ data: 0n, refetch: mockRefetchAllowance }))
    const { result } = renderHook(() => useOrderApproval(WETH, big, 1))
    await act(async () => { await result.current.approve() })
    const call = mockWriteContractAsync.mock.calls[0][0] as { args: [string, bigint] }
    expect(call.args[1]).toBe(big)
    expect(call.args[1]).not.toBe(MAX_UINT256)
  })
})

describe('useOrderApproval — gate opens after approve confirms', () => {
  it('re-reads allowance and reports ready once the approve tx receipt is successful', async () => {
    mockReceiptImpl.mockReturnValue({ isSuccess: true })
    const { result } = renderHook(() => useOrderApproval(WETH, TOTAL, 1))
    // The confirm effect re-fetches the allowance so the gate can open.
    expect(mockRefetchAllowance).toHaveBeenCalled()
    expect(result.current.status).toBe('ready')
  })
})
