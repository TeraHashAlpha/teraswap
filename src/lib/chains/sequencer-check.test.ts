/**
 * [P220] L2 sequencer uptime check (P218).
 *
 * The client is injected, so we pass a stub returning a configured
 * latestRoundData tuple [roundId, answer, startedAt, updatedAt, answeredInRound].
 * The per-chain cache is cleared between cases.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { isSequencerUp, _clearSequencerCache, SEQUENCER_GRACE_PERIOD_SEC } from './sequencer-check'

const nowSec = () => Math.floor(Date.now() / 1000)

/** Stub client whose readContract returns a sequencer round. */
function clientReturning(answer: bigint, startedAtSec: number) {
  return {
    readContract: async () =>
      [1n, answer, BigInt(startedAtSec), BigInt(startedAtSec), 1n] as const,
  }
}

beforeEach(() => {
  _clearSequencerCache()
})

describe('chains/sequencer-check [P218]', () => {
  it('returns true for mainnet (no sequencer feed — client never consulted)', async () => {
    const client = {
      readContract: async () => {
        throw new Error('mainnet must not read a sequencer feed')
      },
    }
    expect(await isSequencerUp(1, client)).toBe(true)
  })

  it('returns true when the sequencer is up and past the grace period', async () => {
    const client = clientReturning(0n, nowSec() - SEQUENCER_GRACE_PERIOD_SEC - 100)
    expect(await isSequencerUp(8453, client)).toBe(true)
  })

  it('returns false when the sequencer is down (answer === 1)', async () => {
    const client = clientReturning(1n, nowSec() - 10_000)
    expect(await isSequencerUp(8453, client)).toBe(false)
  })

  it('returns false during the grace period (recovered < grace ago)', async () => {
    const client = clientReturning(0n, nowSec() - 100) // up, but only 100s ago
    expect(await isSequencerUp(8453, client)).toBe(false)
  })
})
