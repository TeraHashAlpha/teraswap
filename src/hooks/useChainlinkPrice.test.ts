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
// we override here instead of fishing for one.
const mockGetChainlinkFeed = vi.fn<(address: string) => `0x${string}` | null>()
vi.mock('@/lib/chainlink', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chainlink')>('@/lib/chainlink')
  return {
    ...actual,
    getChainlinkFeed: (addr: string) => mockGetChainlinkFeed(addr),
  }
})

import { renderHook } from '@testing-library/react'
import { useChainlinkPrice } from './useChainlinkPrice'

const TOKEN = '0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const FEED = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419' as `0x${string}`
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
})
