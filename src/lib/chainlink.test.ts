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
import { fetchChainlinkPriceRaw, chainlinkAggregatorAbi } from './chainlink'
import { NATIVE_ETH, CHAINLINK_MAX_STALENESS_SEC } from './constants'

// Derive the call selectors from the ABI rather than hardcoding them.
const DECIMALS_SELECTOR = encodeFunctionData({ abi: chainlinkAggregatorAbi, functionName: 'decimals' }).slice(0, 10)
const LATEST_ROUND_SELECTOR = encodeFunctionData({ abi: chainlinkAggregatorAbi, functionName: 'latestRoundData' }).slice(0, 10)

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
