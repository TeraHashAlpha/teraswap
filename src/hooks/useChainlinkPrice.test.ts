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
//
// [FIX-PRICE-ORACLE-FAIL-CLOSED] The read result is now a full observer shape, not just `data`.
// FAITHFULNESS MATTERS: real wagmi/TanStack v5 RETAINS the last successful `data` when a refetch
// errors, and resets `failureCount` to 0 on every new fetch while leaving `errorUpdateCount`
// monotonic. A mock that drops `data` on error would let the isError guard be deleted with every
// test still green (the M-01 audit's exact finding), so `errored()` below keeps stale-but-present
// data and the poll frames carry a real errorUpdateCount.
type ReadResult = {
  data?: unknown
  isError?: boolean
  isLoading?: boolean
  failureCount?: number
  errorUpdateCount?: number
}
let mockRoundData: unknown = undefined
let mockDecimals: number | undefined = undefined
/** Per-functionName overrides for the full observer shape; falls back to the data-only defaults. */
let mockReadOverride: Record<string, ReadResult> = {}
const EMPTY_READ: ReadResult = {
  data: undefined, isError: false, isLoading: false, failureCount: 0, errorUpdateCount: 0,
}
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: mockIsConnected }),
  useReadContract: vi.fn((opts: { functionName: string; query?: { enabled?: boolean } }) => {
    if (opts.query?.enabled === false) return EMPTY_READ
    const override = mockReadOverride[opts.functionName]
    if (override) return { ...EMPTY_READ, ...override }
    if (opts.functionName === 'latestRoundData') return { ...EMPTY_READ, data: mockRoundData }
    if (opts.functionName === 'decimals') return { ...EMPTY_READ, data: mockDecimals }
    return EMPTY_READ
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
// [FIX-PRICE-ORACLE-FAIL-CLOSED] The hook now uses useResolvedChainId (no mainnet fallback), so
// `undefined` is a representable state here — see the unresolved-chain cases below.
let mockChainId: number | undefined = 1
let mockIsConnected = true
vi.mock('./useChainId', () => ({
  useResolvedChainId: () => mockChainId,
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
    mockReadOverride = {}
    mockChainId = 1
    mockIsConnected = true
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
    mockReadOverride = {}
    mockChainId = 1
    mockIsConnected = true
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// [FIX-PRICE-ORACLE-FAIL-CLOSED] The hook must FAIL CLOSED.
//
// It previously collapsed every failure mode (read error, revert, settled-but-empty) into the same
// `!roundData` branch as "not loaded yet" and returned `level:'none', oracleUnavailable:false` — a
// verdict indistinguishable from a healthy first render, which silently disabled BOTH the deviation
// gate and the >$10k unpriceable gate. Every branch of the new decision tree is pinned here.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('useChainlinkPrice — [FIX-PRICE-ORACLE-FAIL-CLOSED] fail closed on an unreadable feed', () => {
  /** An errored read AS THE REAL LIBRARY REPORTS IT — last-good value retained alongside isError. */
  const errored = (lastGood: unknown = undefined) =>
    ({ data: lastGood, isError: true, failureCount: 4, errorUpdateCount: 1 })

  beforeEach(() => {
    vi.clearAllMocks()
    mockRoundData = undefined
    mockDecimals = undefined
    mockReadOverride = {}
    mockChainId = 1
    mockIsConnected = true
    mockGetChainlinkFeed.mockReturnValue(FEED)
  })

  it('a READ ERROR with NO usable round → unavailable AND integrity-failed (both gates engage)', () => {
    mockReadOverride = { latestRoundData: errored(), decimals: { data: 8 } }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    // oracleUnavailable engages the tiered >$10k USD gate...
    expect(result.current.oracleUnavailable).toBe(true)
    // ...and oracleIntegrityFailed engages the deviation gate as a HARD block at every trade size.
    expect(result.current.oracleIntegrityFailed).toBe(true)
    expect(result.current.oracleReadFailed).toBe(true)
    expect(result.current.chainlinkPrice).toBeNull()
  })

  it('a READ ERROR on decimals with no cached decimals → same fail-closed verdict (no partial pricing)', () => {
    mockReadOverride = { latestRoundData: { data: roundData({}) }, decimals: errored(undefined) }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(true)
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })

  // [FIX-PRICE-ORACLE-FAIL-CLOSED / OB-1] The mirror risk, caught by the pre-commit adversarial
  // review. TanStack RETAINS the last successful data when a REFETCH errors, so with the 30s poll
  // an isError-first check would hard-block the whole app on any transient RPC blip while holding a
  // round the oracle timestamps as fresh. The gate keys on "do we have a usable round?", not "did
  // the last fetch error?" — and the staleness ladder still judges whatever we retained.
  it('[OB-1] a REFETCH error that still holds a FRESH cached round does NOT block — data is verifiable', () => {
    mockReadOverride = {
      latestRoundData: { data: roundData({ answer: 2_000_00000000n }), isError: true, failureCount: 4, errorUpdateCount: 1 },
      decimals: { data: 8, isError: true, failureCount: 4, errorUpdateCount: 1 },
    }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(false)
    expect(result.current.oracleIntegrityFailed).toBeFalsy()
    expect(result.current.chainlinkPrice).toBe(2000)
  })

  it('[OB-1] a refetch error holding a STALE cached round still blocks, via the staleness ladder', () => {
    // Self-correcting: if the outage outlives the feed heartbeat, the retained round ages out and
    // the pre-existing integrity branch blocks — no special-casing needed.
    mockReadOverride = {
      latestRoundData: { data: roundData({ answer: 2_000_00000000n, updatedAt: NOW_SECONDS - 26 * 3600 }), isError: true, errorUpdateCount: 1 },
      decimals: { data: 8, isError: true, errorUpdateCount: 1 },
    }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBe(true)
    expect(result.current.message).toMatch(/outdated/i)
  })

  // [FIX-PRICE-ORACLE-FAIL-CLOSED / TQ-01] INVARIANT A — the highest-consequence one. A token that
  // genuinely has NO feed must keep its pre-existing calm treatment: unavailable (so the tiered USD
  // gate still handles it) but NOT an integrity failure, or every exotic/imported token in the app
  // would start hard-blocking at any size.
  it('[Invariant A] a NO-FEED token is unavailable but NOT integrity-failed / read-failed', () => {
    mockGetChainlinkFeed.mockReturnValue(null)
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(true)
    expect(result.current.oracleIntegrityFailed).toBeFalsy()
    expect(result.current.oracleReadFailed).toBeFalsy()
  })

  // [FIX-PRICE-ORACLE-FAIL-CLOSED / TQ-03] The poll is documented as load-bearing (it is what stops
  // an UNREADABLE verdict latching for the whole session), so it is pinned rather than assumed.
  it('polls a configured feed every 30s, and issues NO reads for a token with no feed', () => {
    mockRoundData = roundData({})
    mockDecimals = 8
    renderHook(() => useChainlinkPrice(TOKEN, null))
    expect(vi.mocked(useReadContract)).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ enabled: true, refetchInterval: 30_000 }) }),
    )

    vi.mocked(useReadContract).mockClear()
    mockGetChainlinkFeed.mockReturnValue(null)
    renderHook(() => useChainlinkPrice(TOKEN, null))
    expect(vi.mocked(useReadContract)).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ enabled: false, refetchInterval: undefined }) }),
    )
  })

  it('settled but EMPTY (no data, not loading, no error) → fail closed, never assumed healthy', () => {
    mockReadOverride = {
      latestRoundData: { data: undefined, isLoading: false },
      decimals: { data: undefined, isLoading: false },
    }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(true)
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })

  it('FIRST LOAD still in flight (no failure history) → neutral, NOT a block', () => {
    mockReadOverride = {
      latestRoundData: { data: undefined, isLoading: true, failureCount: 0, errorUpdateCount: 0 },
      decimals: { data: undefined, isLoading: true, failureCount: 0, errorUpdateCount: 0 },
    }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.level).toBe('none')
    expect(result.current.oracleUnavailable).toBe(false)
    expect(result.current.oracleIntegrityFailed).toBeFalsy()
    expect(result.current.message).toBeNull()
  })

  it('a read still RETRYING (isLoading true, failureCount > 0) is failing, not loading → blocked', () => {
    mockReadOverride = {
      latestRoundData: { data: undefined, isLoading: true, failureCount: 2, errorUpdateCount: 0 },
      decimals: { data: undefined, isLoading: true, failureCount: 2, errorUpdateCount: 0 },
    }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(true)
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })

  it('unreadable copy says the feed could not be READ — never that the token has no feed', () => {
    mockReadOverride = { latestRoundData: errored(), decimals: { data: 8 } }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.message).toMatch(/could not be read/i)
    expect(result.current.message).not.toMatch(/no chainlink oracle/i)
  })

  it('a HEALTHY read is completely unaffected — no new friction', () => {
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(false)
    expect(result.current.oracleReadFailed).toBeFalsy()
    expect(result.current.chainlinkPrice).toBe(2000)
  })

  it('STALE data still fails closed via the pre-existing integrity path (unchanged)', () => {
    mockRoundData = roundData({ answer: 2_000_00000000n, updatedAt: NOW_SECONDS - 26 * 3600 })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })

  it('CONNECTED with an unresolved chain → blocked, and NO mainnet feed lookup is attempted', () => {
    // The old `?? DEFAULT_CHAIN_ID` fallback resolved mainnet's registry here and answered
    // confidently about the wrong chain's feed. The lookup must not happen at all.
    mockChainId = undefined
    mockIsConnected = true
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(true)
    expect(result.current.oracleIntegrityFailed).toBe(true)
    expect(mockGetChainlinkFeed).not.toHaveBeenCalled()
  })

  it('DISCONNECTED with an unresolved chain → neutral (no swap to guard, no scary banner)', () => {
    mockChainId = undefined
    mockIsConnected = false
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.level).toBe('none')
    expect(result.current.oracleUnavailable).toBe(false)
    expect(mockGetChainlinkFeed).not.toHaveBeenCalled()
  })

  // [M-01 replay] The audit's runtime reproduction, applied to this hook. query-core resets
  // fetchFailureCount to 0 AND rewinds status to 'pending' on every poll of a never-succeeded
  // query, so keying "in flight" on isLoading/failureCount alone re-opens the gate once per cycle.
  // errorUpdateCount is the only signal the library never resets — these frames pin that.
  it('[M-01] a sustained outage never re-opens the gate across poll cycles', () => {
    const FRAMES: { label: string; state: ReadResult; mustBlock: boolean }[] = [
      { label: 'first fetch, no history', state: { isLoading: true, failureCount: 0, errorUpdateCount: 0 }, mustBlock: false },
      { label: 'retry 1', state: { isLoading: true, failureCount: 1, errorUpdateCount: 0 }, mustBlock: true },
      { label: 'retry 2', state: { isLoading: true, failureCount: 2, errorUpdateCount: 0 }, mustBlock: true },
      { label: 'retries exhausted → error committed', state: { isLoading: false, isError: true, failureCount: 3, errorUpdateCount: 1 }, mustBlock: true },
      { label: 'POLL 1 → fetchState wipes failureCount AND rewinds status', state: { isLoading: true, failureCount: 0, errorUpdateCount: 1 }, mustBlock: true },
      { label: 'poll 1 retrying', state: { isLoading: true, failureCount: 1, errorUpdateCount: 1 }, mustBlock: true },
      { label: 'poll 1 errors', state: { isLoading: false, isError: true, failureCount: 3, errorUpdateCount: 2 }, mustBlock: true },
      { label: 'POLL 2 → counters wiped again', state: { isLoading: true, failureCount: 0, errorUpdateCount: 2 }, mustBlock: true },
      { label: 'POLL 3 (outage sustained)', state: { isLoading: true, failureCount: 0, errorUpdateCount: 3 }, mustBlock: true },
    ]
    for (const frame of FRAMES) {
      mockReadOverride = { latestRoundData: frame.state, decimals: frame.state }
      const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
      if (frame.mustBlock) {
        expect(result.current.oracleUnavailable, `must BLOCK at: ${frame.label}`).toBe(true)
        expect(result.current.oracleIntegrityFailed, `must BLOCK at: ${frame.label}`).toBe(true)
      } else {
        expect(result.current.level, `must stay neutral at: ${frame.label}`).toBe('none')
        expect(result.current.oracleUnavailable, `must stay neutral at: ${frame.label}`).toBe(false)
      }
    }
  })

  it('[M-01] the exact regressed frame — failureCount reset to 0 mid-poll — blocks on errorUpdateCount alone', () => {
    mockReadOverride = {
      latestRoundData: { isLoading: true, failureCount: 0, errorUpdateCount: 1 },
      decimals: { isLoading: true, failureCount: 0, errorUpdateCount: 1 },
    }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(true)
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })
})
