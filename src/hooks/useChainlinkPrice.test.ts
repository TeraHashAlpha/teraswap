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
// [ADR-018] Defaults to 'ETH / USD' — the REAL, correct description() for both FEED and
// BASE_ETH_USD below, which is what every pre-existing happy-path test in this file mocks. Tests
// that want to exercise the new identity-mismatch branch set this explicitly to something else.
let mockDescription: string | undefined = 'ETH / USD'
/** Per-functionName overrides for the full observer shape; falls back to the data-only defaults. */
let mockReadOverride: Record<string, ReadResult> = {}
/**
 * [FIX-HOOK-COMPOSED-FEEDS] Per-ADDRESS data, keyed lowercase. A composition reads two DIFFERENT
 * addresses, so a mock keyed only on functionName would hand both legs the same description and
 * decimals — which would make an identity check that is actually per-leg look like it passes. Takes
 * precedence over the single-feed globals below; unset addresses fall back to them.
 */
let mockByAddress: Record<string, { round?: unknown; decimals?: number; description?: string; isLoading?: boolean }> = {}
const EMPTY_READ: ReadResult = {
  data: undefined, isError: false, isLoading: false, failureCount: 0, errorUpdateCount: 0,
}
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: mockIsConnected }),
  useReadContract: vi.fn((opts: { functionName: string; address?: string; query?: { enabled?: boolean } }) => {
    if (opts.query?.enabled === false) return EMPTY_READ
    const perAddress = opts.address ? mockByAddress[String(opts.address).toLowerCase()] : undefined
    if (perAddress) {
      const base = { ...EMPTY_READ, isLoading: perAddress.isLoading ?? false }
      if (opts.functionName === 'latestRoundData') return { ...base, data: perAddress.round }
      if (opts.functionName === 'decimals') return { ...base, data: perAddress.decimals }
      if (opts.functionName === 'description') return { ...base, data: perAddress.description }
      return base
    }
    const override = mockReadOverride[opts.functionName]
    if (override) return { ...EMPTY_READ, ...override }
    if (opts.functionName === 'latestRoundData') return { ...EMPTY_READ, data: mockRoundData }
    if (opts.functionName === 'decimals') return { ...EMPTY_READ, data: mockDecimals }
    if (opts.functionName === 'description') return { ...EMPTY_READ, data: mockDescription }
    return EMPTY_READ
  }),
}))

// Lock the Chainlink feed lookup so we can control "no feed" vs "feed
// exists" per test. Address picked has a real feed in production, so
// we override here instead of fishing for one. The (addr, chainId) pair
// is forwarded so tests can assert the hook resolves the feed for the
// ACTIVE chain [SPRINT-9E].
// [FIX-HOOK-COMPOSED-FEEDS] The hook resolves through resolveFeed (the shared resolver) rather than a
// bare getChainlinkFeed, so THAT is what these tests control. `single()`/`composed()` build the
// ResolvedFeed shape from the REAL FEED_EXPECTATIONS for each address — deliberately not from
// hand-written strings, so a happy-path test only passes when the mocked description()/decimals()
// genuinely match what the registry declares for that address.
const mockResolveFeed = vi.fn<(address: string, chainId?: number) => unknown>()
vi.mock('@/lib/chains/chainlink-feeds', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chains/chainlink-feeds')>('@/lib/chains/chainlink-feeds')
  return {
    ...actual,
    resolveFeed: (addr: string, chainId?: number) => mockResolveFeed(addr, chainId),
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
// getFeedExpectation / getChainlinkFeed / getComposedFeed / listConfiguredFeedTokens come through the
// partial mock's `...actual` spread, so these are the REAL implementations — only resolveFeed is
// intercepted. That is deliberate: the structural test below must enumerate the genuine registry.
import {
  getFeedExpectation,
  getChainlinkFeed as actualGetChainlinkFeed,
  getComposedFeed as actualGetComposedFeed,
  listConfiguredFeedTokens,
} from '@/lib/chains/chainlink-feeds'
import { useChainlinkPrice } from './useChainlinkPrice'

const TOKEN = '0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const FEED = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419' as `0x${string}`
const BASE_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' as `0x${string}`
const NOW_SECONDS = Math.floor(Date.now() / 1000)

/** A leg carrying the address's REAL declared identity (never a hand-written string). */
function leg(address: string) {
  const e = getFeedExpectation(address)
  if (!e) throw new Error(`test setup: ${address} has no FEED_EXPECTATIONS entry`)
  return { address: address as `0x${string}`, expectedDescription: e.description, expectedDecimals: e.decimals }
}
const single = (address: string) => ({ kind: 'single' as const, leg: leg(address) })
const composed = (base: string, quote: string) => ({ kind: 'composed' as const, base: leg(base), quote: leg(quote) })

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
    mockDescription = 'ETH / USD'
    mockReadOverride = {}
    mockByAddress = {}
    mockChainId = 1
    mockIsConnected = true
    mockResolveFeed.mockReturnValue(null)
  })

  it("flags oracleUnavailable when the token has no Chainlink feed", () => {
    mockResolveFeed.mockReturnValue(null)
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(true)
    expect(result.current.level).toBe('warn')
    expect(result.current.chainlinkPrice).toBeNull()
  })

  it("returns level='none' when tokenAddress is undefined (no real token to check)", () => {
    mockResolveFeed.mockReturnValue(null)
    const { result } = renderHook(() => useChainlinkPrice(undefined, null))
    expect(result.current.oracleUnavailable).toBe(false)
    expect(result.current.level).toBe('none')
  })

  it("returns level='none' when execution price is within 2% of Chainlink", () => {
    mockResolveFeed.mockReturnValue(single(FEED))
    mockRoundData = roundData({ answer: 2_000_00000000n }) // $2000
    mockDecimals = 8
    // executionPrice 1.5% off → below WARN
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2030))
    expect(result.current.level).toBe('none')
    expect(result.current.deviation).toBeCloseTo(0.015, 2)
  })

  it("returns level='warn' when deviation is between 2% and 3%", () => {
    mockResolveFeed.mockReturnValue(single(FEED))
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8
    // executionPrice 2.5% off → WARN band
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2050))
    expect(result.current.level).toBe('warn')
    expect(result.current.deviation).toBeCloseTo(0.025, 2)
  })

  it("returns level='danger' when deviation is at or above 3% (blocks swap)", () => {
    mockResolveFeed.mockReturnValue(single(FEED))
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8
    // executionPrice 5% off → DANGER
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2100))
    expect(result.current.level).toBe('danger')
    expect(result.current.deviation).toBeGreaterThanOrEqual(0.03)
  })

  it("flags stale Chainlink data when updatedAt is older than 25 hours", () => {
    mockResolveFeed.mockReturnValue(single(FEED))
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
    mockResolveFeed.mockReturnValue(single(FEED))
    mockRoundData = roundData({ roundId: 5n, answeredInRound: 3n })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.level).toBe('warn')
    expect(result.current.message).toMatch(/stale/i)
  })

  it("rejects zero / negative Chainlink answers as invalid price", () => {
    mockResolveFeed.mockReturnValue(single(FEED))
    mockRoundData = roundData({ answer: 0n })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.level).toBe('warn')
    expect(result.current.chainlinkPrice).toBeNull()
    expect(result.current.message).toMatch(/invalid/i)
  })

  it("returns the Chainlink price with deviation=0 when no execution price is given", () => {
    mockResolveFeed.mockReturnValue(single(FEED))
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
    mockResolveFeed.mockReturnValue(single(FEED))
    mockRoundData = roundData({ roundId: 5n, answeredInRound: 3n })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })

  it("tags >25h-old data as an oracle-integrity failure", () => {
    mockResolveFeed.mockReturnValue(single(FEED))
    mockRoundData = roundData({ answer: 2_000_00000000n, updatedAt: NOW_SECONDS - 26 * 3600 })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })

  it("tags a zero/invalid answer as an oracle-integrity failure", () => {
    mockResolveFeed.mockReturnValue(single(FEED))
    mockRoundData = roundData({ answer: 0n })
    mockDecimals = 8
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })

  it("does NOT tag a healthy-oracle price-impact deviation as an integrity failure", () => {
    mockResolveFeed.mockReturnValue(single(FEED))
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
    mockDescription = 'ETH / USD'
    mockReadOverride = {}
    mockByAddress = {}
    mockChainId = 1
    mockIsConnected = true
    mockResolveFeed.mockReturnValue(null)
  })

  it('resolves the ETH/USD feed for the ACTIVE chain (Base 8453) and reads on that chain', () => {
    mockChainId = 8453
    mockResolveFeed.mockReturnValue(single(BASE_ETH_USD))
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8

    const { result } = renderHook(() => useChainlinkPrice(NATIVE_ETH, null))

    // Base ETH/USD price is surfaced → QuoteBreakdown can render the fee ($).
    expect(result.current.chainlinkPrice).toBe(2000)
    // Feed resolved for the active chain, not mainnet.
    expect(mockResolveFeed).toHaveBeenCalledWith(NATIVE_ETH, 8453)
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
    mockResolveFeed.mockReturnValue(single(FEED))
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8

    const { result } = renderHook(() => useChainlinkPrice(TOKEN, null))

    expect(result.current.chainlinkPrice).toBe(2000)
    expect(mockResolveFeed).toHaveBeenCalledWith(TOKEN, 1)
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
    mockDescription = 'ETH / USD'
    mockReadOverride = {}
    mockByAddress = {}
    mockChainId = 1
    mockIsConnected = true
    mockResolveFeed.mockReturnValue(single(FEED))
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
    mockResolveFeed.mockReturnValue(null)
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
    mockResolveFeed.mockReturnValue(null)
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
    expect(mockResolveFeed).not.toHaveBeenCalled()
  })

  it('DISCONNECTED with an unresolved chain → neutral (no swap to guard, no scary banner)', () => {
    mockChainId = undefined
    mockIsConnected = false
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.level).toBe('none')
    expect(result.current.oracleUnavailable).toBe(false)
    expect(mockResolveFeed).not.toHaveBeenCalled()
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// [ADR-018] Feed self-identification. FEED's real declared identity (in FEED_EXPECTATIONS) is
// "ETH / USD" @ 8dp — the module-level mockDescription default. Each case here isolates ONE field
// as the mismatch while the round itself is genuinely fresh and valid, mirroring the WBTC/USD
// scenario ADR-018 exists to catch: a reachable, well-formed answer for the WRONG feed.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('useChainlinkPrice — [ADR-018] feed self-identification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRoundData = undefined
    mockDecimals = undefined
    mockDescription = 'ETH / USD'
    mockReadOverride = {}
    mockByAddress = {}
    mockChainId = 1
    mockIsConnected = true
    mockResolveFeed.mockReturnValue(single(FEED))
  })

  it('description mismatch → oracleIntegrityFailed, even with matching decimals and a fresh valid round', () => {
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8 // matches — isolates description as the mismatch
    mockDescription = 'BTC / USD' // the WBTC-shaped bug: wrong pair, otherwise well-formed
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBe(true)
    expect(result.current.chainlinkPrice).toBeNull()
    expect(result.current.message).toMatch(/identity/i)
  })

  it('decimals mismatch → oracleIntegrityFailed, even with matching description and a fresh valid round', () => {
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 18 // FEED is declared 8dp — isolates decimals as the mismatch
    mockDescription = 'ETH / USD' // matches
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBe(true)
    expect(result.current.chainlinkPrice).toBeNull()
  })

  it('a HEALTHY read with matching description AND decimals is unaffected (no new friction)', () => {
    mockRoundData = roundData({ answer: 2_000_00000000n })
    mockDecimals = 8
    mockDescription = 'ETH / USD'
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleIntegrityFailed).toBeFalsy()
    expect(result.current.chainlinkPrice).toBe(2000)
  })

  it('description not yet loaded (still undefined) is treated as not-ready, same as round/decimals', () => {
    mockReadOverride = {
      latestRoundData: { data: roundData({}) },
      decimals: { data: 8 },
      description: { data: undefined, isLoading: true, failureCount: 0, errorUpdateCount: 0 },
    }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.level).toBe('none') // in-flight, no failure history → neutral, not a block
    expect(result.current.oracleIntegrityFailed).toBeFalsy()
  })

  it('description read ERROR with no usable value → unavailable AND integrity-failed (same as a round/decimals read error)', () => {
    mockReadOverride = {
      latestRoundData: { data: roundData({}) },
      decimals: { data: 8 },
      description: { data: undefined, isError: true, failureCount: 4, errorUpdateCount: 1 },
    }
    const { result } = renderHook(() => useChainlinkPrice(TOKEN, 2000))
    expect(result.current.oracleUnavailable).toBe(true)
    expect(result.current.oracleIntegrityFailed).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════
// [FIX-HOOK-COMPOSED-FEEDS] Composed-feed support in the hook, and the STRUCTURAL guard.
//
// The regression this closes: FIX-MAINNET-FEED-REMEDIATION moved mainnet GRT/LDO/SHIB/WBTC to
// composed entries and removed them from the direct map. The hook resolved feeds with a bare
// getChainlinkFeed, so it stopped seeing them and returned oracleUnavailable WITHOUT
// oracleIntegrityFailed — the one combination evaluatePriceGate WAIVES. Four mainnet tokens became
// swappable with zero Chainlink validation.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('useChainlinkPrice — [FIX-HOOK-COMPOSED-FEEDS] composed feeds', () => {
  // Mainnet composed pairs, by token → [base leg, quote leg].
  const ETH_USD_MAINNET = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
  const BTC_USD_MAINNET = '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c'
  const GRT_TOKEN = '0xc944e90c64B2c07662A292be6244BDf05Cda44a7'
  const GRT_ETH = '0x17D054ECAC33D91F7340645341eFB5DE9009F1C1'
  const WBTC_TOKEN = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
  const WBTC_BTC = '0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23'

  /** Set up both legs with valid, fresh rounds and their REAL declared descriptions. */
  function mockComposedLegs(opts: {
    base: string; baseDec: number; baseAnswer: bigint; baseDesc?: string; baseUpdatedAt?: number
    quote: string; quoteDec: number; quoteAnswer: bigint; quoteDesc?: string; quoteUpdatedAt?: number
  }) {
    mockByAddress = {
      [opts.base.toLowerCase()]: {
        round: roundData({ answer: opts.baseAnswer, updatedAt: opts.baseUpdatedAt ?? NOW_SECONDS }),
        decimals: opts.baseDec,
        description: opts.baseDesc ?? getFeedExpectation(opts.base)!.description,
      },
      [opts.quote.toLowerCase()]: {
        round: roundData({ answer: opts.quoteAnswer, updatedAt: opts.quoteUpdatedAt ?? NOW_SECONDS }),
        decimals: opts.quoteDec,
        description: opts.quoteDesc ?? getFeedExpectation(opts.quote)!.description,
      },
    }
  }

  // GRT/ETH 7.8257e-6 x ETH/USD 1901.44 = $0.0148797...
  const GRT_LEGS = { base: GRT_ETH, baseDec: 18, baseAnswer: 7_825_700_951_025n, quote: ETH_USD_MAINNET, quoteDec: 8, quoteAnswer: 190_144_000_000n }
  // WBTC/BTC 1.0002498 x BTC/USD 63947.76010359 = $63963.73...
  const WBTC_LEGS = { base: WBTC_BTC, baseDec: 8, baseAnswer: 100_024_980n, quote: BTC_USD_MAINNET, quoteDec: 8, quoteAnswer: 6_394_776_010_359n }

  beforeEach(() => {
    vi.clearAllMocks()
    mockRoundData = undefined
    mockDecimals = undefined
    mockDescription = 'ETH / USD'
    mockReadOverride = {}
    mockByAddress = {}
    mockChainId = 1
    mockIsConnected = true
    mockResolveFeed.mockReturnValue(null)
  })

  it('prices a composed mainnet token as base x quote (GRT/ETH x ETH/USD)', () => {
    mockResolveFeed.mockReturnValue(composed(GRT_ETH, ETH_USD_MAINNET))
    mockComposedLegs(GRT_LEGS)
    const { result } = renderHook(() => useChainlinkPrice(GRT_TOKEN, null))
    expect(result.current.oracleUnavailable).toBe(false)
    expect(result.current.chainlinkPrice).toBeCloseTo(0.0148797, 6)
  })

  it('prices WBTC through BTC, not as BTC (the composition the whole ADR-018 arc exists for)', () => {
    mockResolveFeed.mockReturnValue(composed(WBTC_BTC, BTC_USD_MAINNET))
    mockComposedLegs(WBTC_LEGS)
    const { result } = renderHook(() => useChainlinkPrice(WBTC_TOKEN, null))
    expect(result.current.oracleUnavailable).toBe(false)
    // 63963.73, NOT BTC/USD's own 63947.76 — proves the WBTC/BTC leg is actually applied.
    expect(result.current.chainlinkPrice).toBeCloseTo(63963.73, 1)
    expect(result.current.chainlinkPrice).not.toBeCloseTo(63947.76, 1)
  })

  it('a composed token feeds the DEVIATION gate like any other price (not waived)', () => {
    mockResolveFeed.mockReturnValue(composed(WBTC_BTC, BTC_USD_MAINNET))
    mockComposedLegs(WBTC_LEGS)
    // Execution price 5% above the composed oracle price → danger, i.e. the gate is live again.
    const { result } = renderHook(() => useChainlinkPrice(WBTC_TOKEN, 63963.73 * 1.05))
    expect(result.current.level).toBe('danger')
    expect(result.current.deviation).toBeGreaterThanOrEqual(0.03)
    expect(result.current.oracleUnavailable).toBe(false)
  })

  // [task 4] The negative, per leg. Must be integrity-failed (hard block at every size) and
  // explicitly NOT oracleUnavailable (which price-gate waives).
  it('mutating the BASE leg description → oracleIntegrityFailed true AND oracleUnavailable false', () => {
    mockResolveFeed.mockReturnValue(composed(GRT_ETH, ETH_USD_MAINNET))
    mockComposedLegs({ ...GRT_LEGS, baseDesc: 'GRT / ETH (tampered)' })
    const { result } = renderHook(() => useChainlinkPrice(GRT_TOKEN, 0.0148797))
    expect(result.current.oracleIntegrityFailed).toBe(true)
    expect(result.current.oracleUnavailable).toBe(false)
    expect(result.current.chainlinkPrice).toBeNull()
    expect(result.current.message).toMatch(/identity/i)
  })

  it('mutating the QUOTE leg description → oracleIntegrityFailed true AND oracleUnavailable false', () => {
    mockResolveFeed.mockReturnValue(composed(GRT_ETH, ETH_USD_MAINNET))
    mockComposedLegs({ ...GRT_LEGS, quoteDesc: 'SOMETHING / ELSE' })
    const { result } = renderHook(() => useChainlinkPrice(GRT_TOKEN, 0.0148797))
    expect(result.current.oracleIntegrityFailed).toBe(true)
    expect(result.current.oracleUnavailable).toBe(false)
    expect(result.current.chainlinkPrice).toBeNull()
  })

  it('mutating either leg DECIMALS also fails closed (identity is description AND decimals)', () => {
    for (const mutation of [{ baseDec: 8 }, { quoteDec: 18 }]) {
      mockResolveFeed.mockReturnValue(composed(GRT_ETH, ETH_USD_MAINNET))
      mockComposedLegs({ ...GRT_LEGS, ...mutation })
      const { result } = renderHook(() => useChainlinkPrice(GRT_TOKEN, 0.0148797))
      expect(result.current.oracleIntegrityFailed, JSON.stringify(mutation)).toBe(true)
      expect(result.current.oracleUnavailable, JSON.stringify(mutation)).toBe(false)
    }
  })

  it('a STALE quote leg fails the whole composed read (no partial pricing from the fresh leg)', () => {
    mockResolveFeed.mockReturnValue(composed(GRT_ETH, ETH_USD_MAINNET))
    // ETH/USD has no per-feed heartbeat on mainnet → the hook's 90_000s (25h) global applies.
    mockComposedLegs({ ...GRT_LEGS, quoteUpdatedAt: NOW_SECONDS - 26 * 3600 })
    const { result } = renderHook(() => useChainlinkPrice(GRT_TOKEN, 0.0148797))
    expect(result.current.oracleIntegrityFailed).toBe(true)
    expect(result.current.oracleUnavailable).toBe(false)
    expect(result.current.chainlinkPrice).toBeNull()
    expect(result.current.message).toMatch(/outdated/i)
  })

  it('a composed read whose quote leg is SETTLED BUT EMPTY fails closed (never partial pricing)', () => {
    // The base leg is perfectly good. If readiness were judged on leg A alone, this would price the
    // token off one leg — precisely the partial pricing ADR-018 invariant (d) forbids.
    mockResolveFeed.mockReturnValue(composed(GRT_ETH, ETH_USD_MAINNET))
    mockByAddress = {
      [GRT_ETH.toLowerCase()]: { round: roundData({ answer: 7_825_700_951_025n }), decimals: 18, description: 'GRT / ETH' },
      [ETH_USD_MAINNET.toLowerCase()]: { round: undefined, decimals: undefined, description: undefined }, // settled, empty
    }
    const { result } = renderHook(() => useChainlinkPrice(GRT_TOKEN, 0.0148797))
    expect(result.current.chainlinkPrice).toBeNull()
    expect(result.current.oracleIntegrityFailed).toBe(true) // hard block, not a waived verdict
    expect(result.current.oracleReadFailed).toBe(true)
  })

  it('a composed read whose quote leg is genuinely IN FLIGHT stays neutral (no false first-render block)', () => {
    mockResolveFeed.mockReturnValue(composed(GRT_ETH, ETH_USD_MAINNET))
    mockByAddress = {
      [GRT_ETH.toLowerCase()]: { round: roundData({ answer: 7_825_700_951_025n }), decimals: 18, description: 'GRT / ETH' },
      [ETH_USD_MAINNET.toLowerCase()]: { isLoading: true }, // first fetch, no failure history
    }
    const { result } = renderHook(() => useChainlinkPrice(GRT_TOKEN, 0.0148797))
    expect(result.current.level).toBe('none')
    expect(result.current.oracleUnavailable).toBe(false)
    expect(result.current.oracleIntegrityFailed).toBeFalsy()
    expect(result.current.chainlinkPrice).toBeNull()
  })

  it('a single feed still issues exactly 3 reads; leg B is disabled', () => {
    mockResolveFeed.mockReturnValue(single(FEED))
    mockRoundData = roundData({})
    mockDecimals = 8
    renderHook(() => useChainlinkPrice(TOKEN, null))
    const calls = vi.mocked(useReadContract).mock.calls.map((c) => c[0] as { query?: { enabled?: boolean } })
    expect(calls.filter((c) => c.query?.enabled === true)).toHaveLength(3)
    expect(calls.filter((c) => c.query?.enabled === false)).toHaveLength(3)
  })

  it('a composed feed issues 6 enabled reads (3 per leg)', () => {
    mockResolveFeed.mockReturnValue(composed(GRT_ETH, ETH_USD_MAINNET))
    mockComposedLegs(GRT_LEGS)
    renderHook(() => useChainlinkPrice(GRT_TOKEN, null))
    const calls = vi.mocked(useReadContract).mock.calls.map((c) => c[0] as { query?: { enabled?: boolean } })
    expect(calls.filter((c) => c.query?.enabled === true)).toHaveLength(6)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════
// [FIX-HOOK-COMPOSED-FEEDS] THE STRUCTURAL GUARD — the test that stops this CLASS recurring.
//
// Enumerates EVERY configured feed in the registry, on EVERY chain, single and composed, and asserts
// the hook actually resolves and prices each one. The failure mode it exists to catch is not a wrong
// number — it is a token that is configured for one code path and INVISIBLE to another, silently
// arriving at the price gate as oracleUnavailable (which the gate waives).
//
// It is derived from listConfiguredFeedTokens(), so a feed added later is covered with no test edit.
// Revert the hook to a direct-map lookup and the four composed mainnet tokens fail this immediately.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('useChainlinkPrice — STRUCTURAL: every configured feed resolves', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRoundData = undefined
    mockDecimals = undefined
    mockDescription = undefined
    mockReadOverride = {}
    mockByAddress = {}
    mockIsConnected = true
  })

  const ALL = listConfiguredFeedTokens()

  it('the registry is non-empty and includes BOTH single and composed shapes (guard is not vacuous)', () => {
    expect(ALL.length).toBeGreaterThan(30)
    expect(ALL.some((f) => f.kind === 'single')).toBe(true)
    expect(ALL.some((f) => f.kind === 'composed')).toBe(true)
    // The four mainnet composed tokens this regression was about must be in scope.
    const mainnetComposed = ALL.filter((f) => f.chainId === 1 && f.kind === 'composed')
    expect(mainnetComposed).toHaveLength(4)
  })

  it('NO configured token — on any chain, single or composed — reaches the price gate as oracleUnavailable', () => {
    const offenders: string[] = []

    for (const entry of ALL) {
      // Resolve with the REAL registry (getChainlinkFeed/getComposedFeed are un-mocked here; only
      // resolveFeed itself is intercepted), then feed each leg a valid fresh round carrying that
      // address's own declared identity. Any token the hook cannot resolve shows up as unavailable.
      const direct = actualGetChainlinkFeed(entry.token, entry.chainId)
      const comp = direct ? null : actualGetComposedFeed(entry.token, entry.chainId)
      if (!direct && !comp) { offenders.push(`${entry.chainId}:${entry.token} (registry gave no source)`); continue }

      mockChainId = entry.chainId
      mockResolveFeed.mockReturnValue(direct ? single(direct) : composed(comp!.base, comp!.quote))

      const legs = direct ? [direct] : [comp!.base, comp!.quote]
      mockByAddress = {}
      for (const addr of legs) {
        const exp = getFeedExpectation(addr)!
        mockByAddress[addr.toLowerCase()] = {
          // A positive answer of 1 unit at the feed's own scale — value is irrelevant here, only
          // that the read RESOLVES rather than vanishing.
          round: roundData({ answer: 10n ** BigInt(exp.decimals), updatedAt: NOW_SECONDS }),
          decimals: exp.decimals,
          description: exp.description,
        }
      }

      const { result } = renderHook(() => useChainlinkPrice(entry.token, null))
      if (result.current.oracleUnavailable || result.current.chainlinkPrice === null) {
        offenders.push(
          `${entry.chainId}:${entry.token} (${entry.kind}) → unavailable=${result.current.oracleUnavailable} price=${result.current.chainlinkPrice}`,
        )
      }
    }

    expect(offenders, `configured feeds the hook failed to resolve:\n${offenders.join('\n')}`).toEqual([])
  })
})
