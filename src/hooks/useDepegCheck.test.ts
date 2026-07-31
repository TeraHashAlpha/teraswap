// @vitest-environment jsdom
/**
 * [FIX-ORACLE-FAIL-CLOSED] useDepegCheck — the depeg circuit-breaker must FAIL CLOSED.
 *
 * The hook previously collapsed every failure mode (read error, revert, stale round, unresolved
 * chain) into mode 'ok', so a feed outage silently disabled the guard and the swap proceeded as
 * though the peg had been verified. Every branch of the new decision tree is pinned here:
 *
 *   - no exchange-rate pair          → 'ok'         (does not APPLY — the common case, frictionless)
 *   - reads in flight                → 'pending'    (a normal first render, NOT a block)
 *   - read error / revert            → 'unverified' (blocked)
 *   - settled but empty              → 'unverified' (blocked)
 *   - stale round (past heartbeat×1.5) → 'unverified' (blocked)
 *   - failed round integrity         → 'unverified' (blocked)
 *   - healthy read, peg holds        → 'ok'         (passes)
 *   - healthy read, real depeg       → 'consent'/'block' (blocked, with DEPEG copy)
 *   - connected, chain unresolved    → 'unverified' (blocked)
 *   - disconnected                   → 'pending'    (no swap to guard — frictionless)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// One controllable result per (address, functionName) pair. Mocked BEFORE the import — vi.mock hoists.
//
// FAITHFULNESS MATTERS HERE. Real wagmi/TanStack Query v5 RETAINS the last successful `data` when a
// refetch errors — an errored query is `{ data: <last good>, isError: true }`, not
// `{ data: undefined, isError: true }`. A mock that drops the data makes every read-error test pass
// for the wrong reason (the hook falls through to the !dataComplete branch and reaches UNVERIFIED
// anyway), so the isError guard survives deletion and the tests pin nothing. `errored()` below
// therefore keeps stale-but-present data, which is what the real library does.
type ReadResult = {
  data?: unknown
  isError?: boolean
  isLoading?: boolean
  failureCount?: number
  errorUpdateCount?: number
}
let reads: Record<string, ReadResult> = {}
const readKey = (address: string | undefined, fn: string) => `${(address ?? '').toLowerCase()}:${fn}`
const EMPTY: ReadResult = {
  data: undefined, isError: false, isLoading: false, failureCount: 0, errorUpdateCount: 0,
}

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: mockIsConnected }),
  useReadContract: (opts: { address?: string; functionName: string; query?: { enabled?: boolean } }) => {
    if (opts.query?.enabled === false) return EMPTY
    return { ...EMPTY, ...(reads[readKey(opts.address, opts.functionName)] ?? {}) }
  },
}))

let mockChainId: number | undefined = 8453
let mockIsConnected = true
vi.mock('./useChainId', () => ({ useResolvedChainId: () => mockChainId }))

import { renderHook } from '@testing-library/react'
import { useDepegCheck } from './useDepegCheck'

// cbETH on Base — the only registered exchange-rate pair today (chains/chainlink-feeds.ts).
const CBETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'
const MARKET = '0x806b4Ac04501c29769051e42783cF04dCE41440b'
const ER = '0x868a501e68F3D1E89CfC0D22F6b22E8dabce5F04'
// A token with no exchange-rate pair (USDC on Base).
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// Wall clock is FROZEN for the whole file. The hook computes its own `Math.floor(Date.now()/1000)`
// at render, so a module-load NOW would drift by a second mid-run and flip the staleness-boundary
// case from 'ok' to 'unverified' — a real, low-frequency flake. vi.setSystemTime removes the race.
const NOW = 1_780_000_000
// Both cbETH legs carry an 86_400s heartbeat → getFeedStalenessSec = 86_400 × 1.5 = 129_600s (36h).
const STALENESS_SEC = 129_600

/** [roundId, answer, startedAt, updatedAt, answeredInRound] */
function round(answer: bigint, ageSec = 0, opts: { roundId?: bigint; answeredInRound?: bigint; startedAt?: bigint } = {}) {
  const ts = BigInt(NOW - ageSec)
  const { roundId = 10n, answeredInRound = 10n, startedAt = ts } = opts
  return [roundId, answer, startedAt, ts, answeredInRound] as const
}

/** Both legs healthy and equal (1.0 each, 18dp) → peg holds. */
function healthyReads(marketAnswer = 10n ** 18n, erAnswer = 10n ** 18n) {
  return {
    [readKey(MARKET, 'latestRoundData')]: { data: round(marketAnswer) },
    [readKey(MARKET, 'decimals')]: { data: 18 },
    [readKey(ER, 'latestRoundData')]: { data: round(erAnswer) },
    [readKey(ER, 'decimals')]: { data: 18 },
  }
}

/**
 * An errored read AS THE REAL LIBRARY REPORTS IT: the last good value is still in `data` while
 * `isError` is true. Passing `data: undefined` here would let the isError guard be deleted without
 * a single test failing — the whole point of these cases.
 */
const errored = (lastGood: unknown = round(10n ** 18n)) =>
  ({ data: lastGood, isError: true, failureCount: 4, errorUpdateCount: 1 })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
  reads = {}
  mockChainId = 8453
  mockIsConnected = true
})
afterEach(() => {
  vi.useRealTimers()
})

const run = (tokenIn = CBETH, tokenOut: string | undefined = USDC) =>
  renderHook(() => useDepegCheck(tokenIn, tokenOut)).result.current

describe('useDepegCheck — applicability (must not block the whole app)', () => {
  it('a pair with NO exchange-rate feed → ok, frictionless (the overwhelmingly common swap)', () => {
    const r = run(USDC, USDC)
    expect(r.mode).toBe('ok')
    expect(r.message).toBeNull()
  })

  it('"does not apply" is NEVER conflated with "could not verify"', () => {
    // No reads configured at all — yet a non-pair token must still pass, not block.
    expect(run(USDC, USDC).mode).not.toBe('unverified')
  })

  it('resolves the pair from EITHER side of the swap (BUYING cbETH is guarded too)', () => {
    // Asserted with a DEPEGGED reading, not a healthy one: 'ok' is also the no-pair verdict, so
    // `expect(run(USDC, CBETH).mode).toBe('ok')` would pass even if tokenOut-side resolution were
    // deleted outright. Only a non-'ok' verdict actually proves the pair was resolved from tokenOut.
    reads = healthyReads(112n * 10n ** 16n, 10n ** 18n) // 1.12 vs 1.00 → 12% → block
    expect(run(CBETH, USDC).mode).toBe('block') // selling cbETH
    expect(run(USDC, CBETH).mode).toBe('block') // buying cbETH — the direction that was unpinned
  })
})

describe('useDepegCheck — in-flight is pending, not a block', () => {
  it('reads still loading → pending, frictionless (a normal first render is not an error)', () => {
    reads = {
      [readKey(MARKET, 'latestRoundData')]: { isLoading: true },
      [readKey(MARKET, 'decimals')]: { isLoading: true },
      [readKey(ER, 'latestRoundData')]: { isLoading: true },
      [readKey(ER, 'decimals')]: { isLoading: true },
    }
    const r = run()
    expect(r.mode).toBe('pending')
    expect(r.message).toBeNull()
  })

  it('a PARTIALLY arrived read set is still pending, not a premature verdict', () => {
    reads = {
      ...healthyReads(),
      [readKey(ER, 'decimals')]: { isLoading: true, data: undefined },
    }
    expect(run().mode).toBe('pending')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// [FIX-DEPEG-RETRY-WINDOW / M-01] The independent audit's runtime reproduction, made permanent.
//
// The 30s refetchInterval (added so 'unverified' could not latch) defeated the failureCount guard:
// for a query that has NEVER succeeded, query-core's 'fetch' action applies fetchState(), which
// resets fetchFailureCount to 0 and — because data === undefined — also rewinds error/status to
// 'pending'. The hook then saw {isLoading: true, failureCount: 0, isError: false}, i.e. exactly a
// first render, and re-opened the gate for ~0.3-1.3s on every poll during the outage it exists to
// catch. These cases drive the REAL observer state sequence, one entry per emitted result.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('useDepegCheck — M-01: the poll must never re-open the gate', () => {
  /** Apply one observer-result shape to ALL four reads (they share a query config, so they move together). */
  const allFour = (r: ReadResult) => ({
    [readKey(MARKET, 'latestRoundData')]: r,
    [readKey(MARKET, 'decimals')]: r,
    [readKey(ER, 'latestRoundData')]: r,
    [readKey(ER, 'decimals')]: r,
  })

  // The exact sequence query-core emits for a never-succeeded query under a sustained outage, taken
  // from the audit's runtime trace. `data` stays undefined throughout — nothing ever succeeded.
  const OUTAGE_SEQUENCE: { label: string; state: ReadResult; mustBlock: boolean }[] = [
    { label: 'first fetch in flight (no history yet)',
      state: { isLoading: true, isError: false, failureCount: 0, errorUpdateCount: 0 }, mustBlock: false },
    { label: 'retry 1 (fetchFailureCount rising, no error committed)',
      state: { isLoading: true, isError: false, failureCount: 1, errorUpdateCount: 0 }, mustBlock: true },
    { label: 'retry 2',
      state: { isLoading: true, isError: false, failureCount: 2, errorUpdateCount: 0 }, mustBlock: true },
    { label: 'retries exhausted → error committed',
      state: { isLoading: false, isError: true, failureCount: 3, errorUpdateCount: 1 }, mustBlock: true },
    { label: 'POLL 1 fires → fetchState wipes failureCount AND rewinds status to pending',
      state: { isLoading: true, isError: false, failureCount: 0, errorUpdateCount: 1 }, mustBlock: true },
    { label: 'poll 1 retries',
      state: { isLoading: true, isError: false, failureCount: 1, errorUpdateCount: 1 }, mustBlock: true },
    { label: 'poll 1 errors',
      state: { isLoading: false, isError: true, failureCount: 3, errorUpdateCount: 2 }, mustBlock: true },
    { label: 'POLL 2 fires → counters wiped again',
      state: { isLoading: true, isError: false, failureCount: 0, errorUpdateCount: 2 }, mustBlock: true },
    { label: 'POLL 3 fires (outage sustained)',
      state: { isLoading: true, isError: false, failureCount: 0, errorUpdateCount: 3 }, mustBlock: true },
  ]

  it('stays blocked across EVERY step of a sustained outage — no pending window after the first failure', () => {
    for (const step of OUTAGE_SEQUENCE) {
      reads = allFour(step.state)
      const mode = run().mode
      if (step.mustBlock) {
        expect(mode, `must BLOCK at: ${step.label}`).toBe('unverified')
      } else {
        expect(mode, `must stay frictionless at: ${step.label}`).toBe('pending')
      }
    }
  })

  it('the exact regressed frame — failureCount reset to 0 mid-poll — blocks on errorUpdateCount alone', () => {
    // This single frame is the bug. Before the fix it returned 'pending' (gate open); the ONLY thing
    // distinguishing it from a genuine first render is errorUpdateCount, which query-core never resets.
    reads = allFour({ isLoading: true, isError: false, failureCount: 0, errorUpdateCount: 1 })
    expect(run().mode).toBe('unverified')
  })

  it('one still-failing leg is enough — the gate does not need all four to have failed', () => {
    reads = {
      ...allFour({ isLoading: true, isError: false, failureCount: 0, errorUpdateCount: 0 }),
      [readKey(ER, 'latestRoundData')]: { isLoading: true, isError: false, failureCount: 0, errorUpdateCount: 1 },
    }
    expect(run().mode).toBe('unverified')
  })

  it('RECOVERY: a completed successful read reopens the gate, even with error history on record', () => {
    // errorUpdateCount stays > 0 forever (monotonic), so recovery must be driven by DATA arriving,
    // not by the failure memory clearing. All four legs now carry good data despite past errors.
    reads = {
      [readKey(MARKET, 'latestRoundData')]: { data: round(10n ** 18n), errorUpdateCount: 3, failureCount: 0 },
      [readKey(MARKET, 'decimals')]: { data: 18, errorUpdateCount: 3, failureCount: 0 },
      [readKey(ER, 'latestRoundData')]: { data: round(10n ** 18n), errorUpdateCount: 3, failureCount: 0 },
      [readKey(ER, 'decimals')]: { data: 18, errorUpdateCount: 3, failureCount: 0 },
    }
    expect(run().mode).toBe('ok')
  })

  it('RECOVERY still yields a real verdict, not a rubber stamp — a depeg in the recovered data blocks', () => {
    reads = {
      [readKey(MARKET, 'latestRoundData')]: { data: round(112n * 10n ** 16n), errorUpdateCount: 2 },
      [readKey(MARKET, 'decimals')]: { data: 18, errorUpdateCount: 2 },
      [readKey(ER, 'latestRoundData')]: { data: round(10n ** 18n), errorUpdateCount: 2 },
      [readKey(ER, 'decimals')]: { data: 18, errorUpdateCount: 2 },
    }
    const r = run()
    expect(r.mode).toBe('block')
    expect(r.message).toMatch(/depeg/i)
  })

  it('a genuine fresh mount with zero history is still frictionless (no first-render regression)', () => {
    reads = allFour({ isLoading: true, isError: false, failureCount: 0, errorUpdateCount: 0 })
    const r = run()
    expect(r.mode).toBe('pending')
    expect(r.message).toBeNull()
  })
})

describe('useDepegCheck — FAIL CLOSED: cannot verify ⇒ blocked as unverified', () => {
  // These four use `errored()`, which keeps the last good value in `data` exactly as TanStack does.
  // That is what makes them bite: with otherwise-healthy, in-heartbeat data still in hand, ONLY the
  // isError guard can produce 'unverified'. Delete that guard and these fail — which is the property
  // a test of "the single most important line in the fix" has to have.
  it('a read ERROR → unverified, even though valid data is still in hand', () => {
    reads = { ...healthyReads(), [readKey(MARKET, 'latestRoundData')]: errored() }
    const r = run()
    expect(r.mode).toBe('unverified')
    expect(r.message).toContain("couldn't verify")
  })

  it('a REVERT on the exchange-rate leg → unverified', () => {
    reads = { ...healthyReads(), [readKey(ER, 'latestRoundData')]: errored() }
    expect(run().mode).toBe('unverified')
  })

  it('an error on EITHER decimals leg → unverified (no partial pricing)', () => {
    reads = { ...healthyReads(), [readKey(MARKET, 'decimals')]: errored(18) }
    expect(run().mode).toBe('unverified')
    reads = { ...healthyReads(), [readKey(ER, 'decimals')]: errored(18) }
    expect(run().mode).toBe('unverified')
  })

  it('a read still RETRYING (isLoading true, failureCount > 0) is failing, not loading → unverified', () => {
    // The subtle one. TanStack keeps isLoading true across the entire retry/backoff sequence, so
    // testing isLoading alone would report 'pending' — leaving the gate inactive for the whole
    // backoff window during exactly the RPC outage it exists to catch.
    reads = {
      ...healthyReads(),
      [readKey(MARKET, 'latestRoundData')]: { data: undefined, isLoading: true, failureCount: 2 },
    }
    expect(run().mode).toBe('unverified')
  })

  it('settled but EMPTY (no data, not loading, no error) → unverified, never assumed healthy', () => {
    reads = { ...healthyReads(), [readKey(ER, 'latestRoundData')]: { data: undefined, isLoading: false } }
    expect(run().mode).toBe('unverified')
  })

  it('STALE round past heartbeat×1.5 (36h) → unverified', () => {
    reads = {
      ...healthyReads(),
      [readKey(MARKET, 'latestRoundData')]: { data: round(10n ** 18n, STALENESS_SEC + 60) },
    }
    expect(run().mode).toBe('unverified')
  })

  it('a round exactly AT the staleness boundary is still accepted (no false block)', () => {
    reads = {
      ...healthyReads(),
      [readKey(MARKET, 'latestRoundData')]: { data: round(10n ** 18n, STALENESS_SEC) },
    }
    expect(run().mode).toBe('ok')
  })

  it('failed round INTEGRITY (answeredInRound < roundId) → unverified', () => {
    reads = {
      ...healthyReads(),
      [readKey(MARKET, 'latestRoundData')]: { data: round(10n ** 18n, 0, { roundId: 10n, answeredInRound: 9n }) },
    }
    expect(run().mode).toBe('unverified')
  })

  it('a non-positive answer → unverified (not treated as a 0 price)', () => {
    reads = { ...healthyReads(), [readKey(ER, 'latestRoundData')]: { data: round(0n) } }
    expect(run().mode).toBe('unverified')
  })

  it('unverified copy never claims a depeg — it says we could not check', () => {
    reads = { ...healthyReads(), [readKey(MARKET, 'latestRoundData')]: errored() }
    const r = run()
    expect(r.message).not.toMatch(/depeg/i)
    expect(r.message).toContain('cbETH')
  })
})

describe('useDepegCheck — healthy reads still produce the real verdict', () => {
  it('peg holds (market == ER) → ok, passes', () => {
    reads = healthyReads()
    const r = run()
    expect(r.mode).toBe('ok')
    expect(r.message).toBeNull()
  })

  it('a 5% divergence → consent, with DEPEG copy (not the unverified copy)', () => {
    reads = healthyReads(105n * 10n ** 16n, 10n ** 18n) // 1.05 vs 1.00
    const r = run()
    expect(r.mode).toBe('consent')
    expect(r.message).toMatch(/depeg/i)
    expect(r.divergence).toBeCloseTo(0.05, 4)
  })

  it('a 12% divergence → hard block, with DEPEG copy', () => {
    reads = healthyReads(112n * 10n ** 16n, 10n ** 18n) // 1.12 vs 1.00
    const r = run()
    expect(r.mode).toBe('block')
    expect(r.message).toMatch(/Swap blocked/i)
  })

  it('a real depeg and an unverified read are DIFFERENT states with different copy', () => {
    reads = healthyReads(112n * 10n ** 16n, 10n ** 18n)
    const depeg = run()
    reads = { ...healthyReads(), [readKey(MARKET, 'latestRoundData')]: errored() }
    const unverified = run()
    expect(depeg.mode).not.toBe(unverified.mode)
    expect(depeg.message).not.toBe(unverified.message)
  })
})

describe('useDepegCheck — unresolved chain (the fallback-to-mainnet hole)', () => {
  it('CONNECTED with an unresolved chain → unverified, never a confident "ok"', () => {
    // The old useActiveChainId fallback resolved this to mainnet, found no pair there (only Base
    // has one), and reported 'ok' — the guard vanished exactly when the chain was in flux.
    mockChainId = undefined
    mockIsConnected = true
    reads = healthyReads()
    expect(run().mode).toBe('unverified')
  })

  it('DISCONNECTED → pending, frictionless (there is no swap to guard)', () => {
    mockChainId = undefined
    mockIsConnected = false
    const r = run()
    expect(r.mode).toBe('pending')
    expect(r.message).toBeNull()
  })

  it('an unresolved chain issues no confident verdict even for a non-pair token', () => {
    mockChainId = undefined
    mockIsConnected = true
    expect(run(USDC, USDC).mode).toBe('unverified')
  })
})
