// @vitest-environment jsdom
/**
 * [P115/M-01] useChainlinkPrice — price-guard correctness.
 *
 * The hook is the only thing standing between the user and a swap
 * priced against a manipulated pool. Every branch in its decision
 * tree needs a test:
 *
 *   - token has no Chainlink feed  → level='warn', oracleUnavailable
 *   - feed exists but answer ≤ 0    → level='warn'
 *   - feed answeredInRound < roundId (stale) → level='warn'
 *   - feed timestamp > 25h old      → level='warn' with age string
 *   - deviation < 2%                → level='none'
 *   - 2% ≤ deviation < 3%           → level='warn'
 *   - deviation ≥ 3%                → level='danger' (blocks the swap)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock wagmi BEFORE importing the hook — vi.mock factories hoist.
let mockRoundData: unknown = undefined
let mockDecimals: number | undefined = undefined
vi.mock('wagmi', () => ({
  useReadContract: vi.fn((opts: { functionName: string; query?: { enabled?: boolean } }) => {
    if (opts.query?.enabled === false) return { data: undefined }
    if (opts.functionName === 'latestRoundData') return { data: mockRoundData }
    if (opts.functionName === 'decimals') return { data: mockDecimals }
    return { data: undefined }
  }),
}))

// Lock the Chainlink feed lookup so we can control "no feed" vs "feed
// exists" per test. Address picked has a real feed in production, so
// we override here instead of fishing for one. The (addr, chainId) pair
// is forwarded so tests can assert the hook resolves the feed for the
// ACTIVE chain [SPRINT-9E].
const mockGetChainlinkFeed = vi.fn<(address: string, chainId?: number) => `0x${string}` | null>()
vi.mock('@/lib/chainlink', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chainlink')>('@/lib/chainlink')
  return {
    ...actual,
    getChainlinkFeed: (addr: string, chainId?: number) => mockGetChainlinkFeed(addr, chainId),
  }
})

// [SPRINT-9E] Control the active chain id the hook reads from. Defaults to
// mainnet (1) so every pre-existing test keeps its byte-identical behaviour.
let mockChainId = 1
vi.mock('./useChainId', () => ({
  useActiveChainId: () => mockChainId,
}))

import { renderHook } from '@testing-library/react'
import { useReadContract } from 'wagmi'
import { NATIVE_ETH } from '@/lib/constants'
import { useChainlinkPrice } from './useChainlinkPrice'

const TOKEN = '0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const FEED = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419' as `0x${string}`
const BASE_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' as `0x${string}`
const NOW_SECONDS = Math.floor(Date.now() / 1000)

/** Helper: build the tuple Chainlink.latestRoundData() returns. */
function roundData(opts: {
  answer?: bigint
  updatedAt?: number
  roundId?: bigint
  answeredInRound?: bigint
}) {
  const {
    answer = 2_000_00000000n,            // 2000 (8dp) — typical ETH/USD
    updatedAt = NOW_SECONDS,
    roundId = 1n,
    answeredInRound = 1n,
  } = opts
  // tuple: roundId, answer, startedAt, updatedAt, answeredInRound
  return [roundId, answer, BigInt(NOW_SECONDS), BigInt(updatedAt), answeredInRound]
}

describe('useChainlinkPrice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRoundData = undefined
    mockDecimals = undefined
    mockChainId = 1
    mockGetChainlinkFeed.mockReturnValue(null)
  })

  it("flags oracleUnavailable when the token has no Chainlink feed", () => {
    mockGetChainlinkFeed.mockReturnValue(null)
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(true)
    expect(result.current.level).toBe('warn')
    expect(result.current.chainlinkPrice).toBeNull()
  })

  it("returns level='none' when tokenAddress is undefined (no real token to check)", () => {
    mockGetChainlinkFeed.mockReturnValue(null)
    const { result } = renderHook(() => useChainlinkPrice(undefined, null))
    expect(result.current.oracleUnavailable).toBe(false)
    expect(result.current.level).toBe('none')
  })

  it("returns level='none' when execution price is within 2% of Chainlink", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ answer: 2_000_00000000n }) // $2000
    mockDecimals = 8
    // executionPrice 1.5% off → below WARN
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2030))
    expect(result.current.level).toBe('none')
    expect(result.current.deviation).toBeCloseTo(0.015, 2)
  })

  it("returns level='warn' when deviation is between 2% and 3%", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8
    // executionPrice 2.5% off → WARN band
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2050))
    expect(result.current.level).toBe('warn')
    expect(result.current.deviation).toBeCloseTo(0.025, 2)
  })

  it("returns level='danger' when deviation is at or above 3% (blocks swap)", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8
    // executionPrice 5% off → DANGER
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2100))
    expect(result.current.level).toBe('danger')
    expect(result.current.deviation).toBeGreaterThanOrEqual(0.03)
  })

  it("flags stale Chainlink data when updatedAt is older than 25 hours", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    // 26h old
    mockRoundData = roundData({
      answer: 2_000_00000000n,
      updatedAt: NOW_SECONDS - 26 * 3600,
    })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.level).toBe('warn')
    expect(result.current.message).toMatch(/outdated/i)
  })

  it("flags answeredInRound < roundId as stale-round data", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ roundId: 5n, answeredInRound: 3n })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.level).toBe('warn')
    expect(result.current.message).toMatch(/stale/i)
  })

  it("rejects zero / negative Chainlink answers as invalid price", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ answer: 0n })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.level).toBe('warn')
    expect(result.current.chainlinkPrice).toBeNull()
    expect(result.current.message).toMatch(/invalid/i)
  })

  it("returns the Chainlink price with deviation=0 when no execution price is given", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, null))
    expect(result.current.level).toBe('none')
    expect(result.current.chainlinkPrice).toBe(2000)
    expect(result.current.deviation).toBe(0)
  })

  // [SPRINT-9J J1] oracleIntegrityFailed discriminator. Integrity failures
  // (stale / invalid round) are a genuine oracle-safety event → hard block;
  // a deviation on a HEALTHY oracle is price impact → informed consent.
  it("tags answeredInRound<roundId as an oracle-integrity failure", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ roundId: 5n, answeredInRound: 3n })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })

  it("tags >25h-old data as an oracle-integrity failure", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ answer: 2_000_00000000n, updatedAt: NOW_SECONDS - 26 * 3600 })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })

  it("tags a zero/invalid answer as an oracle-integrity failure", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ answer: 0n })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })

  it("does NOT tag a healthy-oracle price-impact deviation as an integrity failure", () => {
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8
    // 2.5% deviation → WARN band, but the oracle is fresh & valid → price impact.
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2050))
    expect(result.current.level).toBe('warn')
    expect(result.current.oracleIntegrityFailed).toBeFalsy()
  })
})

describe('useChainlinkPrice — chain-aware feed resolution [SPRINT-9E]', () => {
  // The platform-fee USD in QuoteBreakdown reads priceCheck.chainlinkPrice.
  // On Base it was null (mainnet feed resolved + read on the wrong chain) so
  // no ($) showed next to the fee. The hook must resolve AND read the feed on
  // the ACTIVE chain — exactly like useEthGasCost does for the gas USD.
  beforeEach(() => {
    vi.clearAllMocks()
    mockRoundData = undefined
    mockDecimals = undefined
    mockChainId = 1
    mockGetChainlinkFeed.mockReturnValue(null)
  })

  it('resolves the ETH/USD feed for the ACTIVE chain (Base 8453) and reads on that chain', () => {
    mockChainId = 8453
    mockGetChainlinkFeed.mockReturnValue(BASE_ETH_USD)
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8

    const { result } = renderHook(() => useChainlinkPrice(NATIVE_ETH, null))

    // Base ETH/USD price is surfaced → QuoteBreakdown can render the fee ($).
    expect(result.current.chainlinkPrice).toBe(2000)
    // Feed resolved for the active chain, not mainnet.
    expect(mockGetChainlinkFeed).toHaveBeenCalledWith(NATIVE_ETH, 8453)
    // Contract read pinned to the active chain (else it reads a mainnet
    // address on Base → no contract → null price).
    expect(vi.mocked(useReadContract)).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 8453, functionName: 'latestRoundData' }),
    )
    expect(vi.mocked(useReadContract)).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 8453, functionName: 'decimals' }),
    )
  })

  it('resolves + reads on chainId 1 for mainnet (byte-identical behaviour)', () => {
    mockChainId = 1
    mockGetChainlinkFeed.mockReturnValue(FEED)
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8

    const { result } = renderHook(() => useChainlinkPrice(TOKEN, null))

    expect(result.current.chainlinkPrice).toBe(2000)
    expect(mockGetChainlinkFeed).toHaveBeenCalledWith(TOKEN, 1)
    expect(vi.mocked(useReadContract)).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 1, functionName: 'latestRoundData' }),
    )
  })
})
