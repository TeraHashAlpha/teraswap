// @vitest-environment jsdom
/**
 * [P83/M-01 Phase 2] useEthGasCost — ETH price + gas estimate.
 * [SPRINT-9E] + chain-aware ETH/USD feed (mainnet byte-identical; Base reads the
 * Base feed so gas/fee USD render instead of raw gas units).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let mockChainId = 1
let readCalls: Array<{ address?: string; functionName?: string; chainId?: number }> = []
const mockReadData = vi.fn<(fn: string) => unknown>()
const mockEstimateFeesPerGas = vi.fn<() => { data?: { maxFeePerGas?: bigint } }>()

vi.mock('wagmi', () => ({
  useReadContract: vi.fn((opts: { address?: string; functionName?: string; chainId?: number; query?: { enabled?: boolean } }) => {
    readCalls.push({ address: opts.address, functionName: opts.functionName, chainId: opts.chainId })
    if (opts.query?.enabled === false) return { data: undefined }
    return { data: mockReadData(opts.functionName ?? '') }
  }),
  useEstimateFeesPerGas: vi.fn(() => mockEstimateFeesPerGas()),
}))

// Default mock: useActiveChainId returns the per-test mockChainId (1 unless set).
vi.mock('./useChainId', () => ({ useActiveChainId: () => mockChainId }))

import { renderHook } from '@testing-library/react'
import { useEthGasCost } from './useEthGasCost'
import { CHAINLINK_ETH_USD } from '@/lib/constants'

const BASE_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'

beforeEach(() => {
  vi.clearAllMocks()
  mockChainId = 1
  readCalls = []
  mockReadData.mockImplementation((fn) => {
    if (fn === 'latestRoundData') return [0n, 2500_00000000n, 0n, 1716000000n, 0n] // $2500 (8dp)
    if (fn === 'decimals') return 8
    return undefined
  })
  mockEstimateFeesPerGas.mockReturnValue({ data: { maxFeePerGas: 20_000_000_000n } }) // 20 gwei
})

const feedRead = () => readCalls.find((c) => c.functionName === 'latestRoundData')

describe('useEthGasCost', () => {
  it('computes ethPrice from the Chainlink round data and decimals', () => {
    const { result } = renderHook(() => useEthGasCost())
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
    mockReadData.mockImplementation((fn) => (fn === 'decimals' ? 8 : undefined))
    const { result } = renderHook(() => useEthGasCost())
    expect(result.current.ethPrice).toBeNull()
    expect(result.current.estimate(200_000)).toBeNull()
  })

  it('returns null gasPriceGwei when maxFeePerGas is missing', () => {
    mockEstimateFeesPerGas.mockReturnValue({ data: {} })
    const { result } = renderHook(() => useEthGasCost())
    expect(result.current.gasPriceGwei).toBeNull()
    expect(result.current.estimate(200_000)).toBeNull()
  })

  // ── [SPRINT-9E] chain-aware feed ──
  it('mainnet (chainId 1) reads CHAINLINK_ETH_USD on chain 1 — byte-identical', () => {
    mockChainId = 1
    renderHook(() => useEthGasCost())
    expect(feedRead()?.address?.toLowerCase()).toBe(CHAINLINK_ETH_USD.toLowerCase())
    expect(feedRead()?.chainId).toBe(1)
  })

  it('Base (chainId 8453) reads the BASE ETH/USD feed on chain 8453, not the mainnet feed', () => {
    mockChainId = 8453
    renderHook(() => useEthGasCost())
    expect(feedRead()?.address?.toLowerCase()).toBe(BASE_ETH_USD.toLowerCase())
    expect(feedRead()?.address?.toLowerCase()).not.toBe(CHAINLINK_ETH_USD.toLowerCase())
    expect(feedRead()?.chainId).toBe(8453)
  })

  it('computes gas cost in ETH + USD on Base (no null → no raw-units fallback)', () => {
    mockChainId = 8453
    const { result } = renderHook(() => useEthGasCost())
    expect(result.current.ethPrice).toBe(2500)
    const est = result.current.estimate(200_000)
    expect(est).not.toBeNull()
    expect(est!.usd).toBeCloseTo(10, 2)
  })
})
