/**
 * [P112/M-02] Tests for src/lib/adapters/circuit-breaker.ts cold-start
 * pre-seed from KV.
 *
 * Pins three behaviours flagged by the external analysis (M-02):
 *   1. When the source-state-machine reports a source as disabled or
 *      degraded, the in-memory breaker for that source must start OPEN
 *      so the very first request after a cold start short-circuits.
 *   2. When the source-state read fails (KV down, network blip), the
 *      hot path must continue with every breaker defaulting to CLOSED
 *      and emit a console.warn for ops visibility.
 *   3. The init must run at most once per process lifetime (idempotent
 *      lazy bootstrap, shared by concurrent callers).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock source-state-machine BEFORE importing the breaker module so the
// dynamic import inside initFromKV() picks up the stub.
const mockGetAllStatuses = vi.fn()
vi.mock('@/lib/source-state-machine', () => ({
  getAllStatuses: (...args: unknown[]) => mockGetAllStatuses(...args),
}))

import {
  withCircuitBreaker,
  getCircuitBreaker,
  resetAllCircuitBreakers,
  initFromKV,
  circuitKey,
} from './circuit-breaker'

function status(id: string, state: 'active' | 'degraded' | 'disabled') {
  return {
    id,
    state,
    lastCheckAt: Date.now(),
    failureCount: state === 'active' ? 0 : 5,
    successCount: 0,
    latencyHistory: [],
    lastTransitionAt: Date.now(),
  }
}

describe('circuit-breaker — KV pre-seed [P112/M-02]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAllCircuitBreakers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pre-seeds breakers to OPEN for sources marked disabled in KV', async () => {
    mockGetAllStatuses.mockResolvedValueOnce([
      status('1inch', 'active'),
      status('cowswap', 'disabled'),
    ])
    await initFromKV()

    expect(getCircuitBreaker('cowswap').getState()).toBe('OPEN')
    // Active source: no entry created until first use (default CLOSED).
    expect(getCircuitBreaker('1inch').getState()).toBe('CLOSED')
  })

  it('pre-seeds degraded sources to OPEN as well', async () => {
    mockGetAllStatuses.mockResolvedValueOnce([status('balancer', 'degraded')])
    await initFromKV()
    expect(getCircuitBreaker('balancer').getState()).toBe('OPEN')
  })

  it('defaults all breakers to CLOSED when getAllStatuses() throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGetAllStatuses.mockRejectedValueOnce(new Error('KV unavailable'))

    await initFromKV()

    expect(getCircuitBreaker('1inch').getState()).toBe('CLOSED')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('initFromKV failed'),
      expect.anything(),
    )
  })

  it('does not block the hot path when KV is unavailable', async () => {
    mockGetAllStatuses.mockRejectedValue(new Error('KV unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await withCircuitBreaker('1inch', async () => 'ok')
    expect(result).toBe('ok')
    expect(getCircuitBreaker('1inch').getState()).toBe('CLOSED')
  })

  it('OPEN-pre-seeded breakers block requests via withCircuitBreaker', async () => {
    mockGetAllStatuses.mockResolvedValueOnce([status('cowswap', 'disabled')])

    await expect(
      withCircuitBreaker('cowswap', async () => 'should not run'),
    ).rejects.toThrow(/circuit is OPEN/)
  })

  it('runs the KV read at most once per process (lazy + idempotent)', async () => {
    mockGetAllStatuses.mockResolvedValue([status('1inch', 'active')])

    await withCircuitBreaker('1inch', async () => 1)
    await withCircuitBreaker('1inch', async () => 2)
    await withCircuitBreaker('odos', async () => 3)

    expect(mockGetAllStatuses).toHaveBeenCalledTimes(1)
  })

  it('shares the init promise across concurrent callers', async () => {
    // Make the KV read slow enough to race with the second caller.
    mockGetAllStatuses.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([status('1inch', 'active')]), 10),
        ),
    )

    await Promise.all([
      withCircuitBreaker('1inch', async () => 'a'),
      withCircuitBreaker('1inch', async () => 'b'),
      withCircuitBreaker('1inch', async () => 'c'),
    ])

    // Despite 3 concurrent calls on a cold start, only ONE KV read.
    expect(mockGetAllStatuses).toHaveBeenCalledTimes(1)
  })

  it('resetAllCircuitBreakers clears the init cache so tests can re-seed', async () => {
    mockGetAllStatuses.mockResolvedValueOnce([status('1inch', 'active')])
    await initFromKV()
    expect(mockGetAllStatuses).toHaveBeenCalledTimes(1)

    resetAllCircuitBreakers()

    mockGetAllStatuses.mockResolvedValueOnce([status('cowswap', 'disabled')])
    await initFromKV()
    expect(mockGetAllStatuses).toHaveBeenCalledTimes(2)
    expect(getCircuitBreaker('cowswap').getState()).toBe('OPEN')
  })
})

// ═══════════════════════════════════════════════════════════════
// [SPRINT-9F backlog] no-route vs failure convention
//
// A resolved null/undefined result means "no route" (a legitimate
// absence — the adapter responded but has no quote for this pair/size,
// e.g. bebop.ts:82 or curve's off-mainnet skip). It must be NEUTRAL for
// the breaker: it neither trips it (not a failure) NOR resets the
// consecutive-failure counter (which would mask a real failure trend).
// Only a thrown error is a real failure; only a resolved VALUE is a
// success.
// ═══════════════════════════════════════════════════════════════

describe('circuit-breaker — no-route (null) is NEUTRAL [SPRINT-9F backlog]', () => {
  const fail = () => Promise.reject(new Error('upstream 502'))
  const noRoute = async () => null

  async function drive(name: string, fn: () => Promise<unknown>, n: number) {
    for (let i = 0; i < n; i++) {
      await withCircuitBreaker(name, fn).catch(() => {})
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetAllCircuitBreakers()
    mockGetAllStatuses.mockResolvedValue([]) // clean cold-start, all CLOSED
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a no-route (null) does NOT reset the consecutive-failure count', async () => {
    await drive('bebop', fail, 2)
    expect(getCircuitBreaker('bebop').getInfo().consecutiveFailures).toBe(2)

    // A no-route between failures must NOT paper over the failure trend.
    await drive('bebop', noRoute, 1)
    expect(getCircuitBreaker('bebop').getInfo().consecutiveFailures).toBe(2)
    expect(getCircuitBreaker('bebop').getState()).toBe('CLOSED')

    // One more real failure crosses the threshold (3) and opens it.
    await drive('bebop', fail, 1)
    expect(getCircuitBreaker('bebop').getState()).toBe('OPEN')
  })

  it('N consecutive no-routes leave the breaker CLOSED (never trips)', async () => {
    await drive('curve', noRoute, 5)
    expect(getCircuitBreaker('curve').getState()).toBe('CLOSED')
    expect(getCircuitBreaker('curve').getInfo().consecutiveFailures).toBe(0)
  })

  it('N consecutive real failures OPEN the breaker (threshold = 3)', async () => {
    await drive('odos', fail, 3)
    expect(getCircuitBreaker('odos').getState()).toBe('OPEN')
    // Once OPEN, the next call short-circuits without running fn.
    await expect(
      withCircuitBreaker('odos', async () => 'should not run'),
    ).rejects.toThrow(/circuit is OPEN/)
  })

  it('a resolved VALUE still records success and resets the failure count', async () => {
    await drive('velora', fail, 2)
    expect(getCircuitBreaker('velora').getInfo().consecutiveFailures).toBe(2)

    const r = await withCircuitBreaker('velora', async () => 'a-real-quote')
    expect(r).toBe('a-real-quote')
    expect(getCircuitBreaker('velora').getInfo().consecutiveFailures).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────
// [SPRINT-9S S3] Per-chain breaker isolation.
// ─────────────────────────────────────────────────────────────
describe('circuitKey + per-chain isolation [SPRINT-9S S3]', () => {
  beforeEach(() => resetAllCircuitBreakers())

  it('mainnet keeps the BARE source name (byte-identical + KV pre-seed); other chains get a suffix', () => {
    expect(circuitKey('bebop', 1)).toBe('bebop')          // DEFAULT_CHAIN_ID → bare name
    expect(circuitKey('bebop', undefined)).toBe('bebop')  // unscoped → bare name
    expect(circuitKey('bebop', 8453)).toBe('bebop:8453')  // Base → isolated key
  })

  it('a source failing on Base does NOT open the same source\'s breaker on mainnet', () => {
    // Trip the Base-scoped breaker (3 consecutive failures → OPEN).
    const baseCb = getCircuitBreaker(circuitKey('bebop', 8453))
    baseCb.onFailure(); baseCb.onFailure(); baseCb.onFailure()
    expect(baseCb.getState()).toBe('OPEN')

    // The mainnet breaker for the same source is a SEPARATE instance — still CLOSED.
    const mainnetCb = getCircuitBreaker(circuitKey('bebop', 1))
    expect(mainnetCb.getState()).toBe('CLOSED')
    expect(mainnetCb.isOpen()).toBe(false)
  })

  it('and the reverse: a mainnet failure does not open the Base breaker', () => {
    const mainnetCb = getCircuitBreaker(circuitKey('bebop', 1))
    mainnetCb.onFailure(); mainnetCb.onFailure(); mainnetCb.onFailure()
    expect(mainnetCb.getState()).toBe('OPEN')
    expect(getCircuitBreaker(circuitKey('bebop', 8453)).getState()).toBe('CLOSED')
  })
})
