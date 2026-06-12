/**
 * [P218 / ADR-009] L2 sequencer uptime check.
 *
 * Standard L2 DeFi safety requirement: before trusting a Chainlink price on an
 * L2, confirm the chain's sequencer is up AND has been up long enough that the
 * price feeds have caught up (the grace period). Reading a price while the
 * sequencer is down — or just after it recovered — can return a stale value.
 *
 * Mainnet (no sequencerUptimeFeed) always returns `true`.
 *
 * The client is structurally typed (just `readContract`) so both a viem
 * PublicClient and a test mock satisfy it without overload friction.
 */
import { getChainConfig } from './registry'

/** Price feeds may lag for up to an hour after the sequencer recovers. */
export const SEQUENCER_GRACE_PERIOD_SEC = 3600

/**
 * [E-2 / REVIEW-QUALITY-2026-06-11] Typed refusal thrown by the QUOTE path when
 * an L2's sequencer is down or still inside the recovery grace window. The
 * /api/quote route maps it to a calm 503 { error, sequencerDown: true } so the
 * client can show "quotes paused" instead of a generic failure.
 */
export class SequencerDownError extends Error {
  readonly sequencerDown = true as const
  readonly chainId: number
  constructor(chainId: number) {
    let chainName = `Chain ${chainId}`
    try {
      chainName = getChainConfig(chainId).name
    } catch { /* unknown chain — keep the numeric label */ }
    super(`${chainName} sequencer is down or recovering — quotes are paused until it stabilizes.`)
    this.name = 'SequencerDownError'
    this.chainId = chainId
  }
}

/** Cache the per-chain result briefly to avoid hammering the RPC. */
const CACHE_TTL_MS = 30_000

const SEQUENCER_ABI = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/** Structural — accepts a viem PublicClient or a test mock without overload
 *  friction. Only the `readContract` method is exercised. */
interface SequencerClient {
  readContract(args: { address: `0x${string}`; abi: typeof SEQUENCER_ABI; functionName: 'latestRoundData' }): Promise<unknown>
}

interface CacheEntry {
  up: boolean
  expiresAt: number
}
const cache = new Map<number, CacheEntry>()

// [E2-AUDIT H-1] Single-flight: concurrent checks during a cache miss share ONE
// in-flight RPC read instead of each paying their own (the audit's
// thundering-herd finding — worst exactly at TTL expiry under load and during
// outage transitions). Verdict semantics are unchanged; the entry clears once
// the shared read settles and writes the cache.
const inFlight = new Map<number, Promise<boolean>>()

/** Test-only: reset the per-chain cache between cases. */
export function _clearSequencerCache(): void {
  cache.clear()
  inFlight.clear()
}

/**
 * Is the L2 sequencer up (and past the grace period) for `chainId`?
 *
 * - Chains without a `sequencerUptimeFeed` (mainnet) → always `true`.
 * - `answer === 0` → up; `answer === 1` → down → `false`.
 * - Even when up, if it recovered less than SEQUENCER_GRACE_PERIOD_SEC ago,
 *   treat it as still down (`false`) so we don't trust lagging feeds.
 * - An RPC error fails safe (`false`) — never price an L2 without confirmation.
 */
export async function isSequencerUp(chainId: number, publicClient: SequencerClient): Promise<boolean> {
  let feed: `0x${string}` | undefined
  try {
    feed = getChainConfig(chainId).sequencerUptimeFeed
  } catch {
    return true // unknown chain — don't block (no L2 sequencer assumption)
  }
  if (!feed) return true // L1 (mainnet) — no sequencer to check

  const cached = cache.get(chainId)
  if (cached && cached.expiresAt > Date.now()) return cached.up

  // [E2-AUDIT H-1] Join an in-flight read instead of issuing another.
  const pending = inFlight.get(chainId)
  if (pending) return pending

  const flight = (async (): Promise<boolean> => {
    let up: boolean
    try {
      const [, answer, startedAt] = (await publicClient.readContract({
        address: feed,
        abi: SEQUENCER_ABI,
        functionName: 'latestRoundData',
      })) as readonly [bigint, bigint, bigint, bigint, bigint]
      const isUp = answer === 0n // 0 = up, 1 = down
      const sinceStartedSec = Math.floor(Date.now() / 1000) - Number(startedAt)
      up = isUp && sinceStartedSec >= SEQUENCER_GRACE_PERIOD_SEC
    } catch {
      up = false // fail safe
    }
    cache.set(chainId, { up, expiresAt: Date.now() + CACHE_TTL_MS })
    return up
  })()

  inFlight.set(chainId, flight)
  try {
    return await flight
  } finally {
    inFlight.delete(chainId)
  }
}
