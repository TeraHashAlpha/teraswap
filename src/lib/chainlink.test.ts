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
import { fetchChainlinkPriceRaw, fetchHistoricalPrice, getChainlinkFeed, chainlinkAggregatorAbi } from './chainlink'
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

interface RoundConfig {
  decimals: number
  roundId: bigint
  answer: bigint
  startedAt?: bigint
  updatedAt: bigint
  answeredInRound: bigint
}

/** Stub global fetch so rpcCall() returns the configured round/decimals. */
function mockChainlinkRpc(cfg: RoundConfig) {
  const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init.body as string)
    const data: string = body.params[0].data
    const selector = data.slice(0, 10).toLowerCase()

    let result: `0x${string}`
    if (selector === DECIMALS_SELECTOR) {
      result = encodeFunctionResult({
        abi: chainlinkAggregatorAbi,
        functionName: 'decimals',
        result: cfg.decimals,
      })
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

  it('correctly decodes an 18-decimal feed', async () => {
    const now = nowSec()
    mockChainlinkRpc({
      decimals: 18,
      roundId: 7n,
      answer: 1_230_000_000_000_000_000n, // 1.23 * 1e18
      updatedAt: now,
      answeredInRound: 7n,
    })
    const result = await fetchChainlinkPriceRaw(NATIVE_ETH)
    expect(result!.price).toBeCloseTo(1.23, 2)
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
    const data: string = body.params[0].data
    const selector = data.slice(0, 10).toLowerCase()

    let result: `0x${string}`
    if (selector === DECIMALS_SELECTOR) {
      result = encodeFunctionResult({ abi: chainlinkAggregatorAbi, functionName: 'decimals', result: 8 })
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

  it('getChainlinkFeed resolves the Base ETH/USD feed for chainId 8453', () => {
    expect(getChainlinkFeed(BASE_WETH, 8453)).toBe(BASE_ETH_USD)
    // native ETH on Base maps to Base WETH → same feed
    expect(getChainlinkFeed(NATIVE_ETH, 8453)).toBe(BASE_ETH_USD)
    // mainnet still resolves the mainnet ETH/USD feed (unchanged)
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
      const selector = (body.params[0].data as string).slice(0, 10).toLowerCase()
      let result: `0x${string}`
      if (selector === DECIMALS_SELECTOR) {
        result = encodeFunctionResult({ abi: chainlinkAggregatorAbi, functionName: 'decimals', result: 8 })
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
})
