/**
 * [TEST-H-01] Unit tests for Chainlink staleness validation + decimal decoding.
 *
 * Targets fetchChainlinkPriceRaw in chainlink.ts — specifically the security
 * gates that previously had zero coverage:
 *   - answer <= 0          → null   (invalid price)
 *   - answeredInRound < roundId → null   (stale round)
 *   - age > CHAINLINK_MAX_STALENESS_SEC → null   (expired data)
 * plus the decimal-decoding math for 8- and 18-decimal feeds.
 *
 * Mocking strategy: the module's internal rpcCall() goes through global fetch
 * (eth_call JSON-RPC). We stub fetch and return ABI-encoded latestRoundData /
 * decimals responses, which lets the REAL gate + decode logic run unchanged.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { encodeFunctionData, encodeFunctionResult } from 'viem'
import { fetchChainlinkPriceRaw, fetchHistoricalPrice, fetchErc20Decimals, computeTokenAmountUsd, getChainlinkFeed, getFeedStalenessSec, getFeedExpectation, chainlinkAggregatorAbi, evaluatePairOracle, _clearFeedIdentityCache, type PriceCheck } from './chainlink'
import { getComposedFeed, getExchangeRatePair } from './chains/chainlink-feeds'
import { getRpcUrlForChain } from './adapters/shared'
import { NATIVE_ETH, CHAINLINK_MAX_STALENESS_SEC } from './constants'

// [P220] Control the L2 sequencer gate. Defaults to "up" so the existing
// chainId=1 tests (which never call it) and Base tests are unaffected unless a
// case opts into "down". [SPRINT-9G G1] forwards (chainId, client) so a test can
// assert WHICH client the swap path hands the sequencer gate.
const mockIsSequencerUp = vi.fn<(chainId?: number, client?: unknown) => Promise<boolean>>(async () => true)
vi.mock('@/lib/chains/sequencer-check', () => ({
  isSequencerUp: (chainId: number, client: unknown) => mockIsSequencerUp(chainId, client),
  SEQUENCER_GRACE_PERIOD_SEC: 3600,
  _clearSequencerCache: () => {},
}))

// Derive the call selectors from the ABI rather than hardcoding them.
const DECIMALS_SELECTOR = encodeFunctionData({ abi: chainlinkAggregatorAbi, functionName: 'decimals' }).slice(0, 10)
const LATEST_ROUND_SELECTOR = encodeFunctionData({ abi: chainlinkAggregatorAbi, functionName: 'latestRoundData' }).slice(0, 10)
const GET_ROUND_DATA_SELECTOR = encodeFunctionData({ abi: chainlinkAggregatorAbi, functionName: 'getRoundData', args: [1n] }).slice(0, 10)
const DESCRIPTION_SELECTOR = encodeFunctionData({ abi: chainlinkAggregatorAbi, functionName: 'description' }).slice(0, 10)

/**
 * [ADR-018] Every fetchSingleFeedRaw call now reads description() before latestRoundData()/decimals().
 * These mocks answer it TRUTHFULLY by default — looking up the real FEED_EXPECTATIONS entry for
 * whichever address is under test — so every pre-existing "happy path" test (which exercises real,
 * correctly-configured addresses) keeps passing unmodified. A test that wants to exercise the
 * mismatch branch passes an explicit `descriptionOverride` in its RoundConfig instead.
 */
function describeSelectorResult(to: string, override?: string): `0x${string}` {
  const description = override ?? getFeedExpectation(to)?.description ?? ''
  return encodeFunctionResult({ abi: chainlinkAggregatorAbi, functionName: 'description', result: description })
}

interface RoundConfig {
  decimals: number
  roundId: bigint
  answer: bigint
  startedAt?: bigint
  updatedAt: bigint
  answeredInRound: bigint
  /** [ADR-018] Force description() to return something other than the real expectation, to
   *  exercise the identity-mismatch branch. Omit to answer truthfully (the default happy path). */
  descriptionOverride?: string
}

/** Stub global fetch so rpcCall() returns the configured round/decimals/description. */
function mockChainlinkRpc(cfg: RoundConfig) {
  const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init.body as string)
    const to: string = body.params[0].to
    const data: string = body.params[0].data
    const selector = data.slice(0, 10).toLowerCase()

    let result: `0x${string}`
    if (selector === DECIMALS_SELECTOR) {
      result = encodeFunctionResult({
        abi: chainlinkAggregatorAbi,
        functionName: 'decimals',
        result: cfg.decimals,
      })
    } else if (selector === DESCRIPTION_SELECTOR) {
      result = describeSelectorResult(to, cfg.descriptionOverride)
    } else if (selector === LATEST_ROUND_SELECTOR) {
      result = encodeFunctionResult({
        abi: chainlinkAggregatorAbi,
        functionName: 'latestRoundData',
        result: [cfg.roundId, cfg.answer, cfg.startedAt ?? cfg.updatedAt, cfg.updatedAt, cfg.answeredInRound],
      })
    } else {
      throw new Error(`Unexpected selector ${selector}`)
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const nowSec = () => BigInt(Math.floor(Date.now() / 1000))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // [ADR-018] The feed identity cache is intentionally process-lifetime in production (identity is
  // immutable), but that means it MUST be cleared between tests, or a later test reusing the same
  // address inherits an earlier test's cached (possibly different, possibly mismatched) identity
  // instead of hitting its own mock.
  _clearFeedIdentityCache()
})

describe('chainlink — fetchChainlinkPriceRaw [TEST-H-01]', () => {
  it('returns price for valid fresh round', async () => {
    const now = nowSec()
    mockChainlinkRpc({
      decimals: 8,
      roundId: 100n,
      answer: 300_000_000_000n, // $3000.00 * 1e8
      updatedAt: now,
      answeredInRound: 100n,
    })
    const result = await fetchChainlinkPriceRaw(NATIVE_ETH)
    expect(result).not.toBeNull()
    expect(result!.price).toBeCloseTo(3000, 6)
    expect(result!.roundId).toBe(100n)
    expect(result!.updatedAt).toBe(Number(now))
  })

  it('returns null for stale round (answeredInRound < roundId)', async () => {
    const now = nowSec()
    mockChainlinkRpc({
      decimals: 8,
      roundId: 100n,
      answer: 300_000_000_000n,
      updatedAt: now,
      answeredInRound: 99n, // stale — answer not updated in the current round
    })
    expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).toBeNull()
  })

  it('returns null for expired data (age > CHAINLINK_MAX_STALENESS_SEC)', async () => {
    const stale = nowSec() - BigInt(CHAINLINK_MAX_STALENESS_SEC) - 1n
    mockChainlinkRpc({
      decimals: 8,
      roundId: 100n,
      answer: 300_000_000_000n,
      updatedAt: stale,
      answeredInRound: 100n,
    })
    expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).toBeNull()
  })

  it('accepts data exactly at the staleness boundary', async () => {
    // Pin the clock so the test's capture and the source's Date.now() read the
    // same instant — otherwise a 1-second tick between them flips age from 3600
    // to 3601 and flakes. Restored by the afterEach vi.restoreAllMocks().
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    // age === CHAINLINK_MAX_STALENESS_SEC is NOT > max, so it must pass.
    const boundary = nowSec() - BigInt(CHAINLINK_MAX_STALENESS_SEC)
    mockChainlinkRpc({
      decimals: 8,
      roundId: 100n,
      answer: 300_000_000_000n,
      updatedAt: boundary,
      answeredInRound: 100n,
    })
    expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).not.toBeNull()
  })

  it('returns null for zero answer', async () => {
    mockChainlinkRpc({
      decimals: 8,
      roundId: 100n,
      answer: 0n,
      updatedAt: nowSec(),
      answeredInRound: 100n,
    })
    expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).toBeNull()
  })

  it('returns null for negative answer', async () => {
    mockChainlinkRpc({
      decimals: 8,
      roundId: 100n,
      answer: -1n,
      updatedAt: nowSec(),
      answeredInRound: 100n,
    })
    expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).toBeNull()
  })

  it('returns null for an incomplete round (startedAt === 0) [SPRINT-9G G8]', async () => {
    // startedAt === 0 means the round never started — the order-engine path
    // already rejects this via validateRoundData; the swap path must too.
    mockChainlinkRpc({
      decimals: 8,
      roundId: 100n,
      answer: 300_000_000_000n,
      startedAt: 0n,
      updatedAt: nowSec(),
      answeredInRound: 100n,
    })
    expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).toBeNull()
  })

  it('propagates RPC failure (callers fail-closed via .catch(() => null))', async () => {
    // fetchChainlinkPriceRaw does NOT swallow RPC errors itself — the
    // fail-closed contract is enforced by callers (e.g. computeTokenAmountUsd
    // wraps it in `.catch(() => null)`). Verify both halves.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    await expect(fetchChainlinkPriceRaw(NATIVE_ETH)).rejects.toThrow()
    const safe = await fetchChainlinkPriceRaw(NATIVE_ETH).catch(() => null)
    expect(safe).toBeNull()
  })

  it('correctly decodes an 8-decimal feed (ETH/USD)', async () => {
    const now = nowSec()
    mockChainlinkRpc({
      decimals: 8,
      roundId: 42n,
      answer: 285_042_000_000n, // $2850.42 * 1e8
      updatedAt: now,
      answeredInRound: 42n,
    })
    const result = await fetchChainlinkPriceRaw(NATIVE_ETH)
    expect(result!.price).toBeCloseTo(2850.42, 2)
  })

  // [ADR-018] This used to mock NATIVE_ETH's feed reporting 18 decimals to test the exponent math
  // generically — but NATIVE_ETH's declared identity is now "ETH / USD" @ 8dp, so an 18dp answer
  // from that address is exactly the decimals-mismatch case ADR-018 exists to block, not something
  // fetchChainlinkPriceRaw should ever decode as a price. 18dp decode math is still exercised (as
  // part of the real 18dp legs in this config, cbETH's composed base leg) by the "[SPRINT-9V V2]
  // composed cbETH/USD" suite below (`1.08 × 3000 = 3240`, `1.1344 × 1681.30 ≈ 1907.27`).
  it('an 18-decimal answer from a feed DECLARED 8dp is a decimals mismatch → null [ADR-018]', async () => {
    const now = nowSec()
    mockChainlinkRpc({
      decimals: 18,
      roundId: 7n,
      answer: 1_230_000_000_000_000_000n, // 1.23 * 1e18
      updatedAt: now,
      answeredInRound: 7n,
    })
    expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// [P211/P215/FULL-M-03] fetchHistoricalPrice round-completeness gates.
// The binary search must never use an incomplete/invalid round as a data
// point. A valid fresh latest round lets fetchChainlinkPriceRaw succeed; every
// getRoundData below is invalid, so the search finds no usable point → null.
// ─────────────────────────────────────────────────────────────
function mockHistoricalRpc(getRound: {
  roundId: bigint
  answer: bigint
  startedAt: bigint
  updatedAt: bigint
  answeredInRound: bigint
}) {
  const now = nowSec()
  const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init.body as string)
    const to: string = body.params[0].to
    const data: string = body.params[0].data
    const selector = data.slice(0, 10).toLowerCase()

    let result: `0x${string}`
    if (selector === DECIMALS_SELECTOR) {
      result = encodeFunctionResult({ abi: chainlinkAggregatorAbi, functionName: 'decimals', result: 8 })
    } else if (selector === DESCRIPTION_SELECTOR) {
      // [ADR-018] fetchHistoricalPrice's first step is fetchChainlinkPriceRaw, which now
      // self-identifies before returning the "current round" this search anchors on.
      result = describeSelectorResult(to)
    } else if (selector === LATEST_ROUND_SELECTOR) {
      // Valid, fresh latest round → fetchChainlinkPriceRaw (called first) succeeds.
      result = encodeFunctionResult({
        abi: chainlinkAggregatorAbi,
        functionName: 'latestRoundData',
        result: [100n, 300_000_000_000n, now, now, 100n],
      })
    } else if (selector === GET_ROUND_DATA_SELECTOR) {
      result = encodeFunctionResult({
        abi: chainlinkAggregatorAbi,
        functionName: 'getRoundData',
        result: [getRound.roundId, getRound.answer, getRound.startedAt, getRound.updatedAt, getRound.answeredInRound],
      })
    } else {
      throw new Error(`Unexpected selector ${selector}`)
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('chainlink — fetchHistoricalPrice round completeness [P211/FULL-M-03]', () => {
  it('skips incomplete rounds (answeredInRound < roundId)', async () => {
    const past = nowSec() - 86_400n
    mockHistoricalRpc({ roundId: 50n, answer: 300_000_000_000n, startedAt: past, updatedAt: past, answeredInRound: 49n })
    expect(await fetchHistoricalPrice(NATIVE_ETH, 86_400)).toBeNull()
  })

  it('skips rounds with a zero answer', async () => {
    const past = nowSec() - 86_400n
    mockHistoricalRpc({ roundId: 50n, answer: 0n, startedAt: past, updatedAt: past, answeredInRound: 50n })
    expect(await fetchHistoricalPrice(NATIVE_ETH, 86_400)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// [P218/P220] Multi-chain feed resolution + L2 sequencer gate.
// ─────────────────────────────────────────────────────────────
describe('chainlink — multi-chain [P218]', () => {
  const BASE_WETH = '0x4200000000000000000000000000000000000006'
  const BASE_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'
  const MAINNET_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
  // [SPRINT-9S S1] Base feed addresses — verified 3 ways (Chainlink reference-data-directory +
  // on-chain description()/decimals() on Base + BaseScan EACAggregatorProxy).
  const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const BASE_USDC_USD = '0x458138Fc0D67027E9A6778ef40a6ffC318c69061'
  const BASE_DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'
  const BASE_DAI_USD = '0x591e79239a7d679378eC8c847e5038150364C78F'
  const BASE_CBETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'
  const BASE_USDBC = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA'

  it('getChainlinkFeed resolves the Base ETH/USD feed for chainId 8453', () => {
    expect(getChainlinkFeed(BASE_WETH, 8453)).toBe(BASE_ETH_USD)
    // native ETH on Base maps to Base WETH → same feed
    expect(getChainlinkFeed(NATIVE_ETH, 8453)).toBe(BASE_ETH_USD)
    // mainnet still resolves the mainnet ETH/USD feed (unchanged)
    expect(getChainlinkFeed(NATIVE_ETH, 1)).toBe(MAINNET_ETH_USD)
  })

  it('[SPRINT-9S S1] resolves the Base USDC/USD and DAI/USD feeds (case-insensitive)', () => {
    expect(getChainlinkFeed(BASE_USDC, 8453)).toBe(BASE_USDC_USD)
    expect(getChainlinkFeed(BASE_USDC.toLowerCase(), 8453)).toBe(BASE_USDC_USD)
    expect(getChainlinkFeed(BASE_DAI, 8453)).toBe(BASE_DAI_USD)
  })

  it('[SPRINT-9S S1] leaves cbETH and USDbC unfeeded on Base → null (no compatible USD feed)', () => {
    // cbETH publishes only cbETH/ETH on Base (ETH-denominated → would misprice in this USD-keyed
    // map); USDbC has no Chainlink feed. Both must fall through to null (multi-source + minOutput).
    expect(getChainlinkFeed(BASE_CBETH, 8453)).toBeNull()
    expect(getChainlinkFeed(BASE_USDBC, 8453)).toBeNull()
  })

  it('[SPRINT-9S S1] mainnet feed map is untouched — Base token addresses do NOT resolve on chainId 1', () => {
    // The Base additions live only under CHAINLINK_FEEDS_BY_CHAIN[8453]; chainId 1 still reads the
    // canonical mainnet CHAINLINK_FEEDS. A Base token address must not leak a feed on mainnet.
    expect(getChainlinkFeed(BASE_USDC, 1)).toBeNull()
    expect(getChainlinkFeed(BASE_DAI, 1)).toBeNull()
    expect(getChainlinkFeed(NATIVE_ETH, 1)).toBe(MAINNET_ETH_USD)
  })

  it('oracle read returns null when the L2 sequencer is down', async () => {
    mockIsSequencerUp.mockResolvedValueOnce(false)
    // Base feed resolves, but the sequencer gate short-circuits to null before
    // any price RPC is made.
    expect(await fetchChainlinkPriceRaw(BASE_WETH, 8453)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// [SPRINT-9G G1 / M04+M06] Chain-aware RPC routing. The Base feed read must hit
// the BASE RPC (getRpcUrlForChain(8453)), and the sequencer gate must receive a
// Base-bound client — never the mainnet client/RPC. Mainnet stays byte-identical.
// ─────────────────────────────────────────────────────────────
describe('chainlink — chain-aware RPC routing [SPRINT-9G G1]', () => {
  const BASE_WETH = '0x4200000000000000000000000000000000000006'

  /** Stub fetch so rpcCall returns a valid fresh round, recording each URL hit. */
  function captureRpc(): string[] {
    const urls: string[] = []
    const now = nowSec()
    const fetchMock = vi.fn(async (url: unknown, init: { body?: string }) => {
      urls.push(String(url))
      const body = JSON.parse(init.body as string)
      const to: string = body.params[0].to
      const selector = (body.params[0].data as string).slice(0, 10).toLowerCase()
      let result: `0x${string}`
      if (selector === DECIMALS_SELECTOR) {
        result = encodeFunctionResult({ abi: chainlinkAggregatorAbi, functionName: 'decimals', result: 8 })
      } else if (selector === DESCRIPTION_SELECTOR) {
        result = describeSelectorResult(to)
      } else if (selector === LATEST_ROUND_SELECTOR) {
        result = encodeFunctionResult({
          abi: chainlinkAggregatorAbi,
          functionName: 'latestRoundData',
          result: [100n, 300_000_000_000n, now, now, 100n],
        })
      } else {
        throw new Error(`Unexpected selector ${selector}`)
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    return urls
  }

  it('routes a Base (8453) feed read to the Base RPC, not the mainnet channel', async () => {
    const urls = captureRpc()
    await fetchChainlinkPriceRaw(BASE_WETH, 8453)
    expect(urls.length).toBeGreaterThan(0)
    // Every eth_call for a Base feed must target the Base RPC, not /api/rpc or mainnet.
    for (const u of urls) expect(u).toBe(getRpcUrlForChain(8453))
  })

  it('hands the sequencer gate a Base-bound client (chain.id 8453), not the mainnet client', async () => {
    captureRpc()
    mockIsSequencerUp.mockClear()
    await fetchChainlinkPriceRaw(BASE_WETH, 8453)
    expect(mockIsSequencerUp).toHaveBeenCalled()
    const client = mockIsSequencerUp.mock.calls[0]?.[1] as { chain?: { id?: number } } | undefined
    expect(client?.chain?.id).toBe(8453)
  })

  it('mainnet (chainId 1) feed read stays on the mainnet RPC channel (byte-identical)', async () => {
    const urls = captureRpc()
    await fetchChainlinkPriceRaw(NATIVE_ETH, 1)
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(u).toBe(getRpcUrlForChain(1))
  })

  // [CHORE-API-SMALL-FIXES] fetchErc20Decimals/computeTokenAmountUsd previously
  // had no chainId param and always hit the mainnet RPC for the decimals() call —
  // querying a Base token address against mainnet, which either errors or (worse)
  // silently resolves an unrelated mainnet contract at the same address. Both now
  // thread chainId through to rpcCall, matching the price-leg routing above.
  it('fetchErc20Decimals(tokenAddress, 8453) reads decimals via the Base RPC, not mainnet', async () => {
    const urls = captureRpc()
    await fetchErc20Decimals(BASE_WETH, 8453)
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(u).toBe(getRpcUrlForChain(8453))
  })

  it('computeTokenAmountUsd(tokenAddress, amount, 8453) prices the Base WETH/USD feed on the Base RPC', async () => {
    const urls = captureRpc()
    // captureRpc's decimals() stub answers 8 for BOTH the feed and the ERC20 token
    // (same 4-byte selector), so 1 token unit = 10^8 raw here.
    const result = await computeTokenAmountUsd(BASE_WETH, (1n * 10n ** 8n).toString(), 8453)
    expect(result).not.toBeNull()
    expect(result!.usd).toBeCloseTo(3000, 5) // 1 WETH * $3000 (captureRpc's fixed price answer)
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(u).toBe(getRpcUrlForChain(8453))
  })
})

// ─────────────────────────────────────────────────────────────
// [SPRINT-9S S2] Direction-agnostic pair oracle verdict.
// ─────────────────────────────────────────────────────────────
describe('evaluatePairOracle [SPRINT-9S S2]', () => {
  const none = (over: Partial<PriceCheck> = {}): PriceCheck => ({
    chainlinkPrice: 3000, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false, ...over,
  })
  const warn = (dev: number): PriceCheck => ({
    chainlinkPrice: 3000, executionPrice: 3000 * (1 + dev), deviation: dev, level: 'warn', message: 'deviation', oracleUnavailable: false,
  })
  const missing = (): PriceCheck => ({
    chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'warn', message: 'no feed', oracleUnavailable: true,
  })
  const integrity = (): PriceCheck => ({
    chainlinkPrice: 3000, executionPrice: null, deviation: 0, level: 'warn', message: 'stale', oracleUnavailable: false, oracleIntegrityFailed: true,
  })
  // [FIX-PRICE-ORACLE-FAIL-CLOSED] A feed that EXISTS but could not be read: unavailable (tiered
  // USD gate) + integrity-failed (hard block) + readFailed (so copy says "could not be read").
  const unreadable = (): PriceCheck => ({
    chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'warn',
    message: 'Chainlink price feed could not be read. Price not verified.',
    oracleUnavailable: true, oracleIntegrityFailed: true, oracleReadFailed: true,
  })

  it('produces an IDENTICAL verdict for ETH→USDC and USDC→ETH (direction-agnostic)', () => {
    // ETH→USDC: the deviation sits on the INPUT (ETH) side; USDC out is neutral.
    const ethToUsdc = evaluatePairOracle(warn(0.025), none(), 'ETH', 'USDC')
    // USDC→ETH: same pool, deviation now sits on the OUTPUT (ETH) side; USDC in is neutral.
    const usdcToEth = evaluatePairOracle(none(), warn(0.025), 'USDC', 'ETH')
    expect(ethToUsdc.level).toBe('warn')
    expect(usdcToEth.level).toBe('warn')
    expect(usdcToEth.level).toBe(ethToUsdc.level)
    expect(usdcToEth.deviation).toBe(ethToUsdc.deviation)
    expect(ethToUsdc.oracleUnavailable).toBe(false)
    expect(usdcToEth.oracleUnavailable).toBe(false)
  })

  it('flags oracleUnavailable and NAMES whichever side lacks a feed (regardless of direction)', () => {
    // Missing on the OUTPUT side (e.g. selling ETH for an exotic import) — must still warn + name it.
    const out = evaluatePairOracle(none(), missing(), 'ETH', 'EXOTIC')
    expect(out.oracleUnavailable).toBe(true)
    expect(out.oracleMissingSymbols).toEqual(['EXOTIC'])
    // Missing on the INPUT side.
    const inp = evaluatePairOracle(missing(), none(), 'EXOTIC', 'ETH')
    expect(inp.oracleUnavailable).toBe(true)
    expect(inp.oracleMissingSymbols).toEqual(['EXOTIC'])
    // Both missing → both named.
    const both = evaluatePairOracle(missing(), missing(), 'AAA', 'BBB')
    expect(both.oracleMissingSymbols).toEqual(['AAA', 'BBB'])
  })

  it('is "verified" (no warning) only when BOTH feeds exist', () => {
    const ok = evaluatePairOracle(none(), none(), 'ETH', 'USDC')
    expect(ok.oracleUnavailable).toBe(false)
    expect(ok.level).toBe('none')
    expect(ok.oracleMissingSymbols).toEqual([])
  })

  it('propagates an oracle-integrity failure on EITHER side (hard-block signal preserved)', () => {
    expect(evaluatePairOracle(integrity(), none(), 'ETH', 'USDC').oracleIntegrityFailed).toBe(true)
    expect(evaluatePairOracle(none(), integrity(), 'USDC', 'ETH').oracleIntegrityFailed).toBe(true)
  })

  // [FIX-PRICE-ORACLE-FAIL-CLOSED] An unreadable leg must keep BOTH its hard-block signal and its
  // honest framing when merged into the pair verdict. This branch previously hardcoded
  // `oracleIntegrityFailed: false`, which would have discarded the hard block at the pair level —
  // reopening, one layer up, exactly the hole the hook fix closes.
  it('an UNREADABLE leg keeps oracleIntegrityFailed at the pair level (hard block survives)', () => {
    expect(evaluatePairOracle(unreadable(), none(), 'ETH', 'USDC').oracleIntegrityFailed).toBe(true)
    expect(evaluatePairOracle(none(), unreadable(), 'USDC', 'ETH').oracleIntegrityFailed).toBe(true)
  })

  it('an UNREADABLE leg is NOT listed as a token with no feed (copy must not claim that)', () => {
    const r = evaluatePairOracle(unreadable(), none(), 'ETH', 'USDC')
    expect(r.oracleUnavailable).toBe(true)     // tiered USD gate still engages
    expect(r.oracleReadFailed).toBe(true)      // ...but as a read failure
    expect(r.oracleMissingSymbols).toEqual([]) // ETH is NOT missing a feed — it exists, we failed to read it
    expect(r.message).toMatch(/could not be read/i)
  })

  it('a genuinely missing feed is unchanged — still named, still not an integrity failure', () => {
    const r = evaluatePairOracle(missing(), none(), 'EXOTIC', 'ETH')
    expect(r.oracleUnavailable).toBe(true)
    expect(r.oracleIntegrityFailed).toBe(false)
    expect(r.oracleReadFailed).toBe(false)
    expect(r.oracleMissingSymbols).toEqual(['EXOTIC'])
  })

  it('is a safe drop-in: combine(check, check) preserves that check\'s gate verdict', () => {
    // SwapBox tests mock useChainlinkPrice once for both calls; the merge must be a no-op there.
    for (const c of [none(), warn(0.04), integrity()]) {
      const merged = evaluatePairOracle(c, c, 'ETH', 'USDC')
      expect(merged.level).toBe(c.level)
      expect(merged.deviation).toBe(c.deviation)
      expect(!!merged.oracleIntegrityFailed).toBe(!!c.oracleIntegrityFailed)
      expect(merged.oracleUnavailable).toBe(c.oracleUnavailable)
    }
  })
})

// ─────────────────────────────────────────────────────────────
// [SPRINT-9V V1] Per-feed staleness thresholds (heartbeat × 1.5).
// ─────────────────────────────────────────────────────────────
describe('getFeedStalenessSec [SPRINT-9V V1]', () => {
  const BASE_USDC_USD = '0x458138Fc0D67027E9A6778ef40a6ffC318c69061'
  const BASE_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'
  const MAINNET_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'

  it('a 24h-heartbeat feed → 36h (heartbeat×1.5); raw gate and UI hook AGREE (global ignored when known)', () => {
    expect(getFeedStalenessSec(BASE_USDC_USD, 3600)).toBe(129600)   // 86400 × 1.5
    expect(getFeedStalenessSec(BASE_USDC_USD, 90_000)).toBe(129600) // same regardless of caller global
    expect(getFeedStalenessSec(BASE_USDC_USD.toLowerCase(), 3600)).toBe(129600) // case-insensitive
  })

  it('Base ETH/USD (20-min heartbeat) → 30 min (tightening from the 1h global is fine — more conservative)', () => {
    expect(getFeedStalenessSec(BASE_ETH_USD, 3600)).toBe(1800) // 1200 × 1.5
  })

  it('an unknown-heartbeat feed → the caller global fallback (fail-conservative; MAINNET byte-identical)', () => {
    expect(getFeedStalenessSec(MAINNET_ETH_USD, 3600)).toBe(3600)   // mainnet has no per-feed heartbeat
    expect(getFeedStalenessSec(MAINNET_ETH_USD, 90_000)).toBe(90_000)
    expect(getFeedStalenessSec('0x000000000000000000000000000000000000dEaD', 3600)).toBe(3600)
  })
})

describe('[SPRINT-9V V1] raw gate uses per-feed staleness on Base USDC/USD (24h heartbeat → 36h)', () => {
  const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

  it('a 2h-old round is now VALID (was wrongly STALE under the 1h global — the 9S bug)', async () => {
    const now = nowSec()
    mockChainlinkRpc({ decimals: 8, roundId: 100n, answer: 99_960_000n, updatedAt: now - 7_200n, answeredInRound: 100n })
    const r = await fetchChainlinkPriceRaw(BASE_USDC, 8453)
    expect(r).not.toBeNull()
    expect(r!.price).toBeCloseTo(0.9996, 4)
  })

  it('a 37h-old round is STALE (beyond 36h = heartbeat×1.5) → null — NO loosening past the heartbeat', async () => {
    const now = nowSec()
    mockChainlinkRpc({ decimals: 8, roundId: 100n, answer: 99_960_000n, updatedAt: now - 133_200n, answeredInRound: 100n })
    expect(await fetchChainlinkPriceRaw(BASE_USDC, 8453)).toBeNull()
  })

  it('round-INTEGRITY still hard-fails regardless of the looser staleness (answeredInRound < roundId)', async () => {
    const now = nowSec()
    mockChainlinkRpc({ decimals: 8, roundId: 100n, answer: 99_960_000n, updatedAt: now - 7_200n, answeredInRound: 99n })
    expect(await fetchChainlinkPriceRaw(BASE_USDC, 8453)).toBeNull()
  })
})

/** [SPRINT-9V V2 / ADR-018] Stub fetch with a DIFFERENT round (+ optional description override) per
 *  feed address (composed legs). description() defaults to the real FEED_EXPECTATIONS entry for
 *  each leg address unless a test sets `descriptionOverride`. */
function mockComposedRpc(legs: Record<string, RoundConfig>) {
  const lower: Record<string, RoundConfig> = {}
  for (const [k, v] of Object.entries(legs)) lower[k.toLowerCase()] = v
  const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init.body as string)
    const to = String(body.params[0].to).toLowerCase()
    const selector = String(body.params[0].data).slice(0, 10).toLowerCase()
    const cfg = lower[to]
    if (!cfg) throw new Error(`No mock leg for feed ${to}`)
    let result: `0x${string}`
    if (selector === DECIMALS_SELECTOR) {
      result = encodeFunctionResult({ abi: chainlinkAggregatorAbi, functionName: 'decimals', result: cfg.decimals })
    } else if (selector === DESCRIPTION_SELECTOR) {
      result = describeSelectorResult(to, cfg.descriptionOverride)
    } else if (selector === LATEST_ROUND_SELECTOR) {
      result = encodeFunctionResult({
        abi: chainlinkAggregatorAbi,
        functionName: 'latestRoundData',
        result: [cfg.roundId, cfg.answer, cfg.startedAt ?? cfg.updatedAt, cfg.updatedAt, cfg.answeredInRound],
      })
    } else {
      throw new Error(`Unexpected selector ${selector}`)
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('[SPRINT-9V V2] composed cbETH/USD on Base = cbETH/ETH × ETH/USD', () => {
  const CBETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'
  const CBETH_ETH = '0x806b4Ac04501c29769051e42783cF04dCE41440b' // base leg, 18 dp, 24h heartbeat → 36h
  const ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'    // quote leg, 8 dp, 20min heartbeat → 30min

  it('both legs fresh → price = base(ETH) × quote(USD), decimals handled exactly per-leg', async () => {
    const now = nowSec()
    mockComposedRpc({
      [CBETH_ETH]: { decimals: 18, roundId: 10n, answer: 1_080_000_000_000_000_000n, updatedAt: now - 3_600n, answeredInRound: 10n }, // 1.08 ETH/cbETH
      [ETH_USD]:   { decimals: 8,  roundId: 20n, answer: 300_000_000_000n,           updatedAt: now - 600n,   answeredInRound: 20n }, // $3000/ETH
    })
    const r = await fetchChainlinkPriceRaw(CBETH, 8453)
    expect(r).not.toBeNull()
    expect(r!.price).toBeCloseTo(3240, 2)                  // 1.08 × 3000 — NOT 1.08 misread as $1.08
    expect(r!.updatedAt).toBe(Number(now - 3_600n))        // min(legs) = stalest leg (conservative)
  })

  it('base leg STALE (cbETH/ETH past 36h) → unavailable (null), NO partial pricing', async () => {
    const now = nowSec()
    mockComposedRpc({
      [CBETH_ETH]: { decimals: 18, roundId: 10n, answer: 1_080_000_000_000_000_000n, updatedAt: now - 133_200n, answeredInRound: 10n }, // 37h
      [ETH_USD]:   { decimals: 8,  roundId: 20n, answer: 300_000_000_000n,           updatedAt: now - 600n,      answeredInRound: 20n },
    })
    expect(await fetchChainlinkPriceRaw(CBETH, 8453)).toBeNull()
  })

  it('quote leg STALE under ITS OWN tighter staleness (ETH/USD past 30min) → unavailable', async () => {
    const now = nowSec()
    mockComposedRpc({
      [CBETH_ETH]: { decimals: 18, roundId: 10n, answer: 1_080_000_000_000_000_000n, updatedAt: now - 600n,   answeredInRound: 10n },
      [ETH_USD]:   { decimals: 8,  roundId: 20n, answer: 300_000_000_000n,           updatedAt: now - 2_400n, answeredInRound: 20n }, // 40min > 30min
    })
    expect(await fetchChainlinkPriceRaw(CBETH, 8453)).toBeNull()
  })

  it('quote leg INTEGRITY fail (ETH/USD answeredInRound < roundId) → unavailable', async () => {
    const now = nowSec()
    mockComposedRpc({
      [CBETH_ETH]: { decimals: 18, roundId: 10n, answer: 1_080_000_000_000_000_000n, updatedAt: now - 600n, answeredInRound: 10n },
      [ETH_USD]:   { decimals: 8,  roundId: 20n, answer: 300_000_000_000n,           updatedAt: now - 600n, answeredInRound: 19n }, // integrity fail
    })
    expect(await fetchChainlinkPriceRaw(CBETH, 8453)).toBeNull()
  })

  it('no swap-blocking regression: an UNFEEDED token (USDbC) still returns null (no direct, no composed)', async () => {
    const USDBC = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA'
    mockChainlinkRpc({ decimals: 8, roundId: 1n, answer: 100_000_000n, updatedAt: nowSec(), answeredInRound: 1n })
    expect(await fetchChainlinkPriceRaw(USDBC, 8453)).toBeNull()
  })
})

describe('[SPRINT-9V 9V-M-01] cbETH base leg = the CBETH/ETH MARKET feed (not the Exchange-Rate feed)', () => {
  const CBETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'
  const CBETH_ETH_MARKET = '0x806b4Ac04501c29769051e42783cF04dCE41440b'      // "CBETH / ETH"   (chosen)
  const CBETH_ETH_EXCHRATE = '0x868a501e68F3D1E89CfC0D22F6b22E8dabce5F04'    // "cbETH-ETH Exchange Rate" (rejected)
  const ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'

  it('pins the market proxy as the base leg (on-chain verified 2026-06-08); NOT the exchange-rate proxy', () => {
    const composed = getComposedFeed(CBETH, 8453)
    expect(composed).not.toBeNull()
    expect(composed!.base.toLowerCase()).toBe(CBETH_ETH_MARKET.toLowerCase())
    expect(composed!.base.toLowerCase()).not.toBe(CBETH_ETH_EXCHRATE.toLowerCase())
    expect(composed!.quote.toLowerCase()).toBe(ETH_USD.toLowerCase())
  })

  it('decimals nuance: 18-dp base × 8-dp quote → true USD (realistic on-chain values, no $1.13 bug)', async () => {
    const now = nowSec()
    mockComposedRpc({
      [CBETH_ETH_MARKET]: { decimals: 18, roundId: 10n, answer: 1_134_400_000_000_000_000n, updatedAt: now - 3_600n, answeredInRound: 10n }, // 1.1344 ETH/cbETH (live mkt)
      [ETH_USD]:          { decimals: 8,  roundId: 20n, answer: 168_130_000_000n,            updatedAt: now - 600n,   answeredInRound: 20n }, // $1681.30/ETH
    })
    const r = await fetchChainlinkPriceRaw(CBETH, 8453)
    expect(r).not.toBeNull()
    expect(r!.price).toBeCloseTo(1907.27, 1) // 1.1344 × 1681.30 ≈ $1907 — matches the live direct CBETH/USD feed
  })
})

describe('getExchangeRatePair [SPRINT-9W-oracle]', () => {
  const CBETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'
  it('cbETH on Base → {market 0x806b…, exchangeRate 0x868a…} (data-driven, on-chain verified)', () => {
    const p = getExchangeRatePair(CBETH, 8453)
    expect(p).not.toBeNull()
    expect(p!.symbol).toBe('cbETH')
    expect(p!.market.toLowerCase()).toBe('0x806b4ac04501c29769051e42783cf04dce41440b')
    expect(p!.exchangeRate.toLowerCase()).toBe('0x868a501e68f3d1e89cfc0d22f6b22e8dabce5f04')
  })
  it('non-cbETH tokens and mainnet → null (no depeg check; mainnet unaffected)', () => {
    expect(getExchangeRatePair('0x4200000000000000000000000000000000000006', 8453)).toBeNull() // Base WETH
    expect(getExchangeRatePair(CBETH, 1)).toBeNull()  // mainnet has no exchange-rate pairs
    expect(getExchangeRatePair(CBETH)).toBeNull()     // default chain = mainnet
  })
})

// ─────────────────────────────────────────────────────────────
// [ADR-018] Feed self-identification — the check that catches WBTC/USD silently reading the
// BTC/USD index feed. Every case here is a feed that is REACHABLE and returns a GENUINELY valid,
// fresh round — the only thing wrong is that description()/decimals() contradict the config key.
// ─────────────────────────────────────────────────────────────
describe('fetchChainlinkPriceRaw — [ADR-018] feed self-identification', () => {
  it('description mismatch → integrity failure (null), even with a fresh valid round', async () => {
    mockChainlinkRpc({
      decimals: 8, // matches expectation — decimals alone would pass
      roundId: 1n,
      answer: 100_000_000n,
      updatedAt: nowSec(),
      answeredInRound: 1n,
      descriptionOverride: 'BTC / USD', // NATIVE_ETH is declared "ETH / USD" — this is the WBTC-shaped bug
    })
    expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).toBeNull()
  })

  it('decimals mismatch → integrity failure (null), even with a matching description', async () => {
    mockChainlinkRpc({
      decimals: 18, // NATIVE_ETH is declared 8dp
      roundId: 1n,
      answer: 1_000_000_000_000_000_000n,
      updatedAt: nowSec(),
      answeredInRound: 1n,
      // descriptionOverride omitted → answers truthfully with "ETH / USD", isolating decimals as
      // the ONLY mismatched field.
    })
    expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).toBeNull()
  })

  it('a feed with NO declared expectation fails closed, distinct from a mismatch', async () => {
    // getComposedFeed/getChainlinkFeed never hand out an address absent from FEED_EXPECTATIONS in
    // production (the import-time assert guarantees it), but fetchSingleFeedRaw's own defensive
    // check is exercised directly here via a token with genuinely no configured feed at all.
    const NO_FEED_TOKEN = '0x000000000000000000000000000000000000dEaD'
    expect(await fetchChainlinkPriceRaw(NO_FEED_TOKEN)).toBeNull()
  })

  describe('composed leg self-identification', () => {
    const CBETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'
    const CBETH_ETH = '0x806b4Ac04501c29769051e42783cF04dCE41440b' // base leg, declared "CBETH / ETH" 18dp
    const ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'    // quote leg, declared "ETH / USD" 8dp

    it('base leg description mismatch fails the WHOLE composed read, even though the quote leg is fine', async () => {
      const now = nowSec()
      mockComposedRpc({
        [CBETH_ETH]: {
          decimals: 18, roundId: 10n, answer: 1_080_000_000_000_000_000n, updatedAt: now - 3_600n, answeredInRound: 10n,
          descriptionOverride: 'wrong / pair', // base leg misidentifies
        },
        [ETH_USD]: { decimals: 8, roundId: 20n, answer: 300_000_000_000n, updatedAt: now - 600n, answeredInRound: 20n },
      })
      expect(await fetchChainlinkPriceRaw(CBETH, 8453)).toBeNull()
    })

    it('quote leg decimals mismatch fails the WHOLE composed read, even though the base leg is fine', async () => {
      const now = nowSec()
      mockComposedRpc({
        [CBETH_ETH]: { decimals: 18, roundId: 10n, answer: 1_080_000_000_000_000_000n, updatedAt: now - 3_600n, answeredInRound: 10n },
        [ETH_USD]: {
          decimals: 6, // quote leg is declared 8dp — mismatch
          roundId: 20n, answer: 300_000_000n, updatedAt: now - 600n, answeredInRound: 20n,
        },
      })
      expect(await fetchChainlinkPriceRaw(CBETH, 8453)).toBeNull()
    })
  })

  describe('identity cache does not mask a per-address difference', () => {
    const CBETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'
    const CBETH_ETH = '0x806b4Ac04501c29769051e42783cF04dCE41440b'
    const ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'

    it('caches identity per (chainId, address) — a passing read for one address does not let a DIFFERENT mismatched address through', async () => {
      const now = nowSec()
      // First: NATIVE_ETH's real mainnet ETH/USD feed reads correctly and caches its identity.
      mockChainlinkRpc({ decimals: 8, roundId: 1n, answer: 300_000_000_000n, updatedAt: now, answeredInRound: 1n })
      expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).not.toBeNull()

      // Second, same test (cache NOT cleared mid-test — only afterEach clears it): a DIFFERENT
      // address (Base's cbETH/ETH leg, wrong chain too) with a genuinely mismatched description.
      // If the cache were keyed on description alone, or shared across addresses, this could
      // wrongly inherit NATIVE_ETH's cached "pass" — it must not.
      mockComposedRpc({
        [CBETH_ETH]: {
          decimals: 18, roundId: 10n, answer: 1_080_000_000_000_000_000n, updatedAt: now, answeredInRound: 10n,
          descriptionOverride: 'ETH / USD', // deliberately WRONG for this address (should be "CBETH / ETH")
        },
        [ETH_USD]: { decimals: 8, roundId: 20n, answer: 300_000_000_000n, updatedAt: now, answeredInRound: 20n },
      })
      expect(await fetchChainlinkPriceRaw(CBETH, 8453)).toBeNull()
    })

    it('re-reads a cold cache correctly after being cleared (sanity on the test harness itself)', async () => {
      _clearFeedIdentityCache()
      mockChainlinkRpc({ decimals: 8, roundId: 1n, answer: 300_000_000_000n, updatedAt: nowSec(), answeredInRound: 1n })
      expect(await fetchChainlinkPriceRaw(NATIVE_ETH)).not.toBeNull()
    })
  })
})

// ─────────────────────────────────────────────────────────────
// [FIX-MAINNET-FEED-REMEDIATION] The 7 defective mainnet feeds, post-remediation.
//
// Per token: (a) the read now resolves to a PLAUSIBLE USD price, and (b) it still fails closed the
// moment a leg's description is mutated — proving the price is flowing THROUGH the ADR-018 guard
// rather than around it. Answers below are the real on-chain values read on 2026-07-29, so the
// expected USD figures are the genuine arithmetic, not invented round numbers.
// ─────────────────────────────────────────────────────────────
describe('[FIX-MAINNET-FEED-REMEDIATION] remediated mainnet feeds', () => {
  const ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
  const BTC_USD = '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c'
  // Tokens
  const GRT = '0xc944e90c64B2c07662A292be6244BDf05Cda44a7'
  const LDO = '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32'
  const SHIB = '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE'
  const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
  const APE = '0x4d224452801ACEd8B2F0aeBE155379bb5D594381'
  const PAXG = '0x45804880De22913dAFE09f4980848ECE6EcbAf78'
  const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'
  // Feed legs
  const GRT_ETH = '0x17D054ECAC33D91F7340645341eFB5DE9009F1C1'
  const LDO_ETH = '0x4e844125952D32AcdF339BE976c98E22F6F318dB'
  const SHIB_ETH = '0x8dD1CD88F43aF196ae478e91b9F5E4Ac69A97C61'
  const WBTC_BTC = '0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23'
  const APE_USD = '0xD10aBbC76679a20055E167BB80A24ac851b37056'
  const PAXG_USD = '0x9944D86CEB9160aF5C5feB251FD671923323f8C3'

  // Real on-chain answers (2026-07-29). ETH/USD 1901.44; BTC/USD 63947.76010359.
  const ETH_USD_ANSWER = 190_144_000_000n
  const BTC_USD_ANSWER = 6_394_776_010_359n
  const ethUsdLeg = (now: bigint) => ({ decimals: 8, roundId: 20n, answer: ETH_USD_ANSWER, updatedAt: now - 400n, answeredInRound: 20n })
  const btcUsdLeg = (now: bigint) => ({ decimals: 8, roundId: 21n, answer: BTC_USD_ANSWER, updatedAt: now - 100n, answeredInRound: 21n })

  // token, base leg addr, base decimals, real base answer, quote leg addr, quote leg factory,
  // expected composed USD, and how precise the assertion can be.
  const COMPOSED = [
    { name: 'GRT', token: GRT, baseAddr: GRT_ETH, baseDec: 18, baseAnswer: 7_825_700_951_025n, quoteAddr: ETH_USD, quote: ethUsdLeg, usd: 0.01488, prec: 4, trueDesc: 'GRT / ETH' },
    { name: 'LDO', token: LDO, baseAddr: LDO_ETH, baseDec: 18, baseAnswer: 187_700_448_474_460n, quoteAddr: ETH_USD, quote: ethUsdLeg, usd: 0.35688, prec: 3, trueDesc: 'LDO / ETH' },
    { name: 'SHIB', token: SHIB, baseAddr: SHIB_ETH, baseDec: 18, baseAnswer: 2_471_866_650n, quoteAddr: ETH_USD, quote: ethUsdLeg, usd: 4.6997e-6, prec: 8, trueDesc: 'SHIB / ETH' },
    { name: 'WBTC', token: WBTC, baseAddr: WBTC_BTC, baseDec: 8, baseAnswer: 100_024_980n, quoteAddr: BTC_USD, quote: btcUsdLeg, usd: 63963.73, prec: 0, trueDesc: 'WBTC / BTC' },
  ]

  for (const c of COMPOSED) {
    it(`${c.name} resolves to a plausible USD price via composition (was mis-denominated before)`, async () => {
      const now = nowSec()
      mockComposedRpc({
        [c.baseAddr]: { decimals: c.baseDec, roundId: 10n, answer: c.baseAnswer, updatedAt: now - 3_600n, answeredInRound: 10n },
        [c.quoteAddr]: c.quote(now),
      })
      const r = await fetchChainlinkPriceRaw(c.token, 1)
      expect(r, `${c.name} must resolve`).not.toBeNull()
      expect(r!.price).toBeCloseTo(c.usd, c.prec)
      // The stalest leg governs freshness (conservative).
      expect(r!.updatedAt).toBe(Number(now - 3_600n))
    })

    it(`${c.name} still fails closed when the BASE leg's description is mutated`, async () => {
      const now = nowSec()
      mockComposedRpc({
        [c.baseAddr]: {
          decimals: c.baseDec, roundId: 10n, answer: c.baseAnswer, updatedAt: now - 3_600n, answeredInRound: 10n,
          descriptionOverride: `${c.trueDesc} (tampered)`,
        },
        [c.quoteAddr]: c.quote(now),
      })
      expect(await fetchChainlinkPriceRaw(c.token, 1)).toBeNull()
    })

    it(`${c.name} still fails closed when the QUOTE leg's description is mutated`, async () => {
      const now = nowSec()
      mockComposedRpc({
        [c.baseAddr]: { decimals: c.baseDec, roundId: 10n, answer: c.baseAnswer, updatedAt: now - 3_600n, answeredInRound: 10n },
        [c.quoteAddr]: { ...c.quote(now), descriptionOverride: 'SOMETHING / ELSE' },
      })
      expect(await fetchChainlinkPriceRaw(c.token, 1)).toBeNull()
    })
  }

  // Direct (single-leg) remediations: APE and PAXG.
  const DIRECT = [
    { name: 'APE', token: APE, feed: APE_USD, answer: 14_384_986n, usd: 0.14384986, prec: 6 },
    { name: 'PAXG', token: PAXG, feed: PAXG_USD, answer: 409_000_818_404n, usd: 4090.00818404, prec: 2 },
  ]
  for (const d of DIRECT) {
    it(`${d.name} resolves to a plausible USD price on its CORRECTED address`, async () => {
      mockChainlinkRpc({ decimals: 8, roundId: 5n, answer: d.answer, updatedAt: nowSec() - 600n, answeredInRound: 5n })
      const r = await fetchChainlinkPriceRaw(d.token, 1)
      expect(r, `${d.name} must resolve`).not.toBeNull()
      expect(r!.price).toBeCloseTo(d.usd, d.prec)
    })

    it(`${d.name} still fails closed when its description is mutated`, async () => {
      mockChainlinkRpc({
        decimals: 8, roundId: 5n, answer: d.answer, updatedAt: nowSec() - 600n, answeredInRound: 5n,
        descriptionOverride: 'TAMPERED / USD',
      })
      expect(await fetchChainlinkPriceRaw(d.token, 1)).toBeNull()
    })
  }

  it('PEPE remains UNRESOLVED — no Chainlink feed exists, so it stays blocked even on a "valid" round', async () => {
    // Even if the dead address somehow answered with a perfectly well-formed round, its description
    // cannot match, so the guard holds. This is the intended end state, not an oversight.
    mockChainlinkRpc({
      decimals: 8, roundId: 5n, answer: 1_000_000n, updatedAt: nowSec(), answeredInRound: 5n,
      descriptionOverride: 'NOT A REAL PEPE FEED',
    })
    expect(await fetchChainlinkPriceRaw(PEPE, 1)).toBeNull()
  })

  it('the long-tail 24h heartbeat is honoured: a 20h-old base leg is VALID, a 37h-old one is stale', async () => {
    // Guards the heartbeat entries added alongside this remediation. Under the bare 1h mainnet
    // global, the 20h case would be null and the whole remediation would silently be a no-op.
    const now = nowSec()
    mockComposedRpc({
      [GRT_ETH]: { decimals: 18, roundId: 10n, answer: 7_825_700_951_025n, updatedAt: now - 72_000n, answeredInRound: 10n }, // 20h
      [ETH_USD]: ethUsdLeg(now),
    })
    expect(await fetchChainlinkPriceRaw(GRT, 1), '20h-old base leg must be VALID under the 36h ceiling').not.toBeNull()

    _clearFeedIdentityCache()
    mockComposedRpc({
      [GRT_ETH]: { decimals: 18, roundId: 10n, answer: 7_825_700_951_025n, updatedAt: now - 133_200n, answeredInRound: 10n }, // 37h > 36h
      [ETH_USD]: ethUsdLeg(now),
    })
    expect(await fetchChainlinkPriceRaw(GRT, 1)).toBeNull()
  })
})
