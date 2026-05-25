// @vitest-environment jsdom
/**
 * [P83/M-01 Phase 2] useEthGasCost — ETH price + gas estimate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockReadContract = vi.fn<(opts: { functionName: string }) => { data: unknown }>()
const mockEstimateFeesPerGas = vi.fn<() => { data?: { maxFeePerGas?: bigint } }>()

vi.mock('wagmi', () => ({
  useReadContract: vi.fn((opts: { functionName: string }) => mockReadContract(opts)),
  useEstimateFeesPerGas: vi.fn(() => mockEstimateFeesPerGas()),
}))

import { renderHook } from '@testing-library/react'
import { useEthGasCost } from './useEthGasCost'

beforeEach(() => {
  vi.clearAllMocks()
  mockReadContract.mockImplementation(({ functionName }) => {
    if (functionName === 'latestRoundData') {
      // [roundId, answer, startedAt, updatedAt, answeredInRound]
      // 8 decimals: 2500_00000000 → $2500
      return { data: [0n, 2500_00000000n, 0n, 1716000000n, 0n] }
    }
    if (functionName === 'decimals') return { data: 8 }
    return { data: undefined }
  })
  mockEstimateFeesPerGas.mockReturnValue({ data: { maxFeePerGas: 20_000_000_000n } })
})

describe('useEthGasCost', () => {
  it('computes ethPrice from the Chainlink round data and decimals', () => {
    const { result } = renderHook(() => useEthGasCost())
    // 2500_00000000 / 10^8 = 2500
    expect(result.current.ethPrice).toBe(2500)
  })

  it('computes gasPriceGwei from maxFeePerGas (20 gwei)', () => {
    const { result } = renderHook(() => useEthGasCost())
    expect(result.current.gasPriceGwei).toBe(20)
  })

  it('estimate(gasUnits) returns { eth, usd } for a known input', () => {
    const { result } = renderHook(() => useEthGasCost())
    // 200_000 * 20e9 / 1e18 = 0.004 ETH; * 2500 = $10
    const r = result.current.estimate(200_000)
    expect(r).not.toBeNull()
    expect(r!.eth).toBeCloseTo(0.004, 6)
    expect(r!.usd).toBeCloseTo(10, 2)
  })

  it('returns null ethPrice when roundData is undefined', () => {
    mockReadContract.mockImplementation(({ functionName }) => {
      if (functionName === 'decimals') return { data: 8 }
      return { data: undefined }
    })
    const { result } = renderHook(() => useEthGasCost())
    expect(result.current.ethPrice).toBeNull()
    // estimate also returns null when ethPrice is missing.
    expect(result.current.estimate(200_000)).toBeNull()
  })

  it('returns null gasPriceGwei when maxFeePerGas is missing', () => {
    mockEstimateFeesPerGas.mockReturnValue({ data: {} })
    const { result } = renderHook(() => useEthGasCost())
    expect(result.current.gasPriceGwei).toBeNull()
    expect(result.current.estimate(200_000)).toBeNull()
  })
})
