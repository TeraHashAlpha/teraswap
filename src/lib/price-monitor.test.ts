/**
 * [P215/TEST-M-02] price-monitor oracle staleness coverage.
 *
 * getChainlinkPriceUSD must apply the same validity gates as the swap path
 * (P211/FULL-H-04): a stale, incomplete, or non-positive round returns null
 * rather than a "live" price for SL/TP/DCA triggers. isTriggerMet must never
 * fire when the oracle price is unavailable.
 *
 * Mocking strategy: stub @/lib/rpc's getPrivateClient so readContract returns
 * the configured latestRoundData / decimals. validateRoundData (the real gate,
 * shared with chainlink.ts) runs unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockReadContract = vi.fn<(opts: { functionName: string }) => Promise<unknown>>()

vi.mock('@/lib/rpc', () => ({
  getPrivateClient: vi.fn(() => ({
    readContract: (opts: { functionName: string }) => mockReadContract(opts),
  })),
}))

// getChainlinkPriceUSD never calls this, but the module imports it — stub so
// the import graph stays light.
vi.mock('@/lib/limit-order-api', () => ({
  fetchCurrentPrice: vi.fn(),
}))

import { getChainlinkPriceUSD, isTriggerMet } from './price-monitor'
import { NATIVE_ETH, CHAINLINK_MAX_STALENESS_SEC } from './constants'

const nowSec = () => Math.floor(Date.now() / 1000)

/** Configure the mocked client to answer latestRoundData + decimals. */
function mockRound(cfg: {
  decimals?: number
  roundId?: bigint
  answer: bigint
  startedAt?: bigint
  updatedAt?: bigint
  answeredInRound?: bigint
}) {
  const decimals = cfg.decimals ?? 8
  const roundId = cfg.roundId ?? 100n
  const updatedAt = cfg.updatedAt ?? BigInt(nowSec())
  const startedAt = cfg.startedAt ?? updatedAt
  const answeredInRound = cfg.answeredInRound ?? roundId
  mockReadContract.mockImplementation(async ({ functionName }) => {
    if (functionName === 'latestRoundData') {
      return [roundId, cfg.answer, startedAt, updatedAt, answeredInRound]
    }
    if (functionName === 'decimals') return decimals
    throw new Error(`unexpected readContract: ${functionName}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('price-monitor — getChainlinkPriceUSD staleness gates [P211]', () => {
  it('returns null on a stale round (updatedAt beyond the staleness threshold)', async () => {
    mockRound({
      answer: 300_000_000_000n, // $3000 * 1e8
      updatedAt: BigInt(nowSec() - CHAINLINK_MAX_STALENESS_SEC - 1),
    })
    expect(await getChainlinkPriceUSD(NATIVE_ETH)).toBeNull()
  })

  it('returns null on an incomplete round (answeredInRound < roundId)', async () => {
    mockRound({ answer: 300_000_000_000n, roundId: 100n, answeredInRound: 99n })
    expect(await getChainlinkPriceUSD(NATIVE_ETH)).toBeNull()
  })

  it('returns null on a zero or negative answer', async () => {
    mockRound({ answer: 0n })
    expect(await getChainlinkPriceUSD(NATIVE_ETH)).toBeNull()
    mockRound({ answer: -1n })
    expect(await getChainlinkPriceUSD(NATIVE_ETH)).toBeNull()
  })

  it('returns the decoded price on a good (fresh, complete) round', async () => {
    mockRound({ answer: 300_000_000_000n, decimals: 8 }) // $3000.00
    const price = await getChainlinkPriceUSD(NATIVE_ETH)
    expect(price).toBeCloseTo(3000, 6)
  })
})

describe('price-monitor — isTriggerMet oracle-unavailable guard [P211]', () => {
  it('returns false when the oracle price is unavailable (null)', () => {
    // null is exactly what getChainlinkPriceUSD returns on a stale/invalid round.
    expect(isTriggerMet(null, 2000, 'above')).toBe(false)
    expect(isTriggerMet(null, 2000, 'below')).toBe(false)
  })
})
