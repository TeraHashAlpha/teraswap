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
