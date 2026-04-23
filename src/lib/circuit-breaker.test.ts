/**
 * Unit tests for src/lib/circuit-breaker.ts — P46 automated circuit breaker.
 *
 * Tests cover: majority threshold (5 disabled → no trip, 6 → trip), rapid cascade
 * (4 within 10min → trip, 4 over 30min → no trip), cooldown suppression,
 * alert message content, KV audit trail, integration with monitoring tick.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  evaluateCircuitBreaker,
  checkCircuitBreaker,
  isInCooldown,
  isSystemHalted,
  clearHalt,
  _constants,
  type CircuitBreakerResult,
} from './circuit-breaker'
import type { SourceStatus } from './source-state-machine'

// ── Mocks ─────────���──────────────────────────────────────

const mockKvSet = vi.fn().mockResolvedValue(undefined)
const mockKvGet = vi.fn().mockResolvedValue(null)
const mockKvDel = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/kv', () => ({
  kv: {
    set: (...args: unknown[]) => mockKvSet(...args),
    get: (...args: unknown[]) => mockKvGet(...args),
    del: (...args: unknown[]) => mockKvDel(...args),
  },
}))

const mockEmitTransitionAlert = vi.fn().mockResolvedValue(undefined)
vi.mock('./alert-wrapper', () => ({
  emitTransitionAlert: (...args: unknown[]) => mockEmitTransitionAlert(...args),
}))

// ── Helpers ─────��────────────────────────────────────────

const NOW = Date.now()

function makeSource(
  id: string,
  state: 'active' | 'degraded' | 'disabled',
  disabledAt?: number,
): SourceStatus {
  return {
    id,
    state,
    lastCheckAt: NOW,
    failureCount: state === 'disabled' ? 5 : 0,
    successCount: state === 'active' ? 10 : 0,
    latencyHistory: [200, 300, 250],
    disabledReason: state === 'disabled' ? 'test-reason' : undefined,
    disabledAt: state === 'disabled' ? (disabledAt ?? NOW) : undefined,
    lastTransitionAt: NOW,
  }
}

/** Build a list of N active + M disabled sources */
function makeSources(
  activeCount: number,
  disabledCount: number,
  opts?: { disabledAt?: number; degradedCount?: number },
): SourceStatus[] {
  const sources: SourceStatus[] = []
  for (let i = 0; i < activeCount; i++) {
    sources.push(makeSource(`source-active-${i}`, 'active'))
  }
  for (let i = 0; i < (opts?.degradedCount ?? 0); i++) {
    sources.push(makeSource(`source-degraded-${i}`, 'degraded'))
  }
  for (let i = 0; i < disabledCount; i++) {
    sources.push(makeSource(`source-disabled-${i}`, 'disabled', opts?.disabledAt))
  }
  return sources
}

// ── Tests ─────────────���──────────────────────────────────

describe('evaluateCircuitBreaker', () => {
  // ── Majority threshold ──���─────────────────────────────

  describe('majority threshold', () => {
    it('does NOT trigger with 5 disabled sources (old timestamps)', () => {
      // disabledAt outside cascade window so only majority check applies
      const longAgo = NOW - 30 * 60 * 1000
      const statuses = makeSources(6, 5, { disabledAt: longAgo })
      const result = evaluateCircuitBreaker(statuses)
      expect(result.triggered).toBe(false)
      expect(result.disabledCount).toBe(5)
      expect(result.totalSources).toBe(11)
    })

    it('triggers with 6 disabled sources (majority)', () => {
      const statuses = makeSources(5, 6)
      const result = evaluateCircuitBreaker(statuses)
      expect(result.triggered).toBe(true)
      expect(result.disabledCount).toBe(6)
      expect(result.totalSources).toBe(11)
      expect(result.triggerReason).toContain('majority')
      expect(result.triggerReason).toContain('6/11')
    })

    it('triggers with all 11 sources disabled', () => {
      const statuses = makeSources(0, 11)
      const result = evaluateCircuitBreaker(statuses)
      expect(result.triggered).toBe(true)
      expect(result.disabledCount).toBe(11)
      expect(result.triggerReason).toContain('11/11')
    })

    it('does NOT count degraded sources toward majority', () => {
      // 5 disabled + 3 degraded + 3 active = 11 total, only 5 disabled
      // disabledAt outside cascade window so only majority check applies
      const longAgo = NOW - 30 * 60 * 1000
      const statuses = makeSources(3, 5, { degradedCount: 3, disabledAt: longAgo })
      const result = evaluateCircuitBreaker(statuses)
      expect(result.triggered).toBe(false)
      expect(result.disabledCount).toBe(5)
    })
  })

  // ── Rapid cascade ───────���─────────────────────────────

  describe('rapid cascade', () => {
    it('triggers with 4 sources disabled within 10 minutes', () => {
      // All disabled 5 minutes ago (within window)
      const fiveMinAgo = NOW - 5 * 60 * 1000
      const statuses = makeSources(7, 4, { disabledAt: fiveMinAgo })
      const result = evaluateCircuitBreaker(statuses)
      expect(result.triggered).toBe(true)
      expect(result.disabledCount).toBe(4)
      expect(result.triggerReason).toContain('cascade')
      expect(result.triggerReason).toContain('4 sources')
    })

    it('does NOT trigger with 4 sources disabled over 30 minutes', () => {
      // All disabled 30 minutes ago (outside window)
      const thirtyMinAgo = NOW - 30 * 60 * 1000
      const statuses = makeSources(7, 4, { disabledAt: thirtyMinAgo })
      const result = evaluateCircuitBreaker(statuses)
      expect(result.triggered).toBe(false)
    })

    it('does NOT trigger with 3 sources disabled within window', () => {
      const twoMinAgo = NOW - 2 * 60 * 1000
      const statuses = makeSources(8, 3, { disabledAt: twoMinAgo })
      const result = evaluateCircuitBreaker(statuses)
      expect(result.triggered).toBe(false)
    })

    it('handles mix of recent and old disabled sources', () => {
      // 2 disabled recently + 2 disabled long ago = only 2 in window → no cascade
      const sources = [
        ...makeSources(7, 0),
        makeSource('old-1', 'disabled', NOW - 30 * 60 * 1000),
        makeSource('old-2', 'disabled', NOW - 30 * 60 * 1000),
        makeSource('new-1', 'disabled', NOW - 3 * 60 * 1000),
        makeSource('new-2', 'disabled', NOW - 3 * 60 * 1000),
      ]
      const result = evaluateCircuitBreaker(sources)
      // 4 total disabled but only 2 in window → no cascade, and <6 → no majority
      expect(result.triggered).toBe(false)
      expect(result.disabledCount).toBe(4)
    })
  })

  // ── Result shape ──────────────────────────────────────

  describe('result shape', () => {
    it('includes disabled source IDs in result', () => {
      const statuses = makeSources(5, 6)
      const result = evaluateCircuitBreaker(statuses)
      expect(result.disabledSources).toHaveLength(6)
      expect(result.disabledSources[0]).toContain('source-disabled-')
    })

    it('returns empty disabledSources when none disabled', () => {
      const statuses = makeSources(11, 0)
      const result = evaluateCircuitBreaker(statuses)
      expect(result.triggered).toBe(false)
      expect(result.disabledSources).toEqual([])
      expect(result.disabledCount).toBe(0)
    })
  })
})

// ── checkCircuitBreaker (with cooldown + alerting) ──────

describe('checkCircuitBreaker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockKvGet.mockResolvedValue(null) // no cooldown by default
    mockKvSet.mockResolvedValue(undefined)
  })

  it('emits alert and writes audit trail when triggered', async () => {
    const statuses = makeSources(5, 6)
    const result = await checkCircuitBreaker(statuses)

    expect(result.triggered).toBe(true)

    // Alert emitted
    expect(mockEmitTransitionAlert).toHaveBeenCalledTimes(1)
    expect(mockEmitTransitionAlert).toHaveBeenCalledWith(
      'circuit-breaker',
      'active',
      'disabled',
      expect.stringContaining('circuit-breaker-tripped'),
    )

    // KV writes: audit trail + cooldown
    expect(mockKvSet).toHaveBeenCalledWith(
      _constants.LAST_TRIP_KEY,
      expect.objectContaining({
        disabledCount: 6,
        totalSources: 11,
      }),
      expect.objectContaining({ ex: expect.any(Number) }),
    )
    expect(mockKvSet).toHaveBeenCalledWith(
      _constants.COOLDOWN_KEY,
      expect.any(Number),
      expect.objectContaining({ ex: expect.any(Number) }),
    )
  })

  it('alert reason includes source list', async () => {
    const statuses = makeSources(5, 6)
    await checkCircuitBreaker(statuses)

    const alertReason = mockEmitTransitionAlert.mock.calls[0][3] as string
    expect(alertReason).toContain('source-disabled-0')
    expect(alertReason).toContain('source-disabled-5')
    expect(alertReason).toContain('6/11')
  })

  it('suppresses when in cooldown', async () => {
    // Simulate cooldown: KV returns recent timestamp
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === _constants.COOLDOWN_KEY) return Date.now() - 5 * 60 * 1000 // 5min ago, within 15min cooldown
      return null
    })

    const statuses = makeSources(5, 6)
    const result = await checkCircuitBreaker(statuses)

    // Evaluation says triggered but cooldown suppresses
    expect(result.triggered).toBe(false)
    expect(result.triggerReason).toContain('cooldown')
    // No alert emitted
    expect(mockEmitTransitionAlert).not.toHaveBeenCalled()
  })

  it('allows trigger after cooldown expires', async () => {
    // Simulate expired cooldown: KV returns old timestamp
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === _constants.COOLDOWN_KEY) return Date.now() - 20 * 60 * 1000 // 20min ago, past 15min cooldown
      return null
    })

    const statuses = makeSources(5, 6)
    const result = await checkCircuitBreaker(statuses)

    expect(result.triggered).toBe(true)
    expect(mockEmitTransitionAlert).toHaveBeenCalledTimes(1)
  })

  it('does not emit alert when not triggered', async () => {
    const statuses = makeSources(8, 3)
    const result = await checkCircuitBreaker(statuses)

    expect(result.triggered).toBe(false)
    expect(mockEmitTransitionAlert).not.toHaveBeenCalled()
    // No KV writes for non-trigger
    expect(mockKvSet).not.toHaveBeenCalled()
  })
})

// ─�� isInCooldown ─────────────────────────────────────��──

describe('isInCooldown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false when no cooldown set', async () => {
    mockKvGet.mockResolvedValue(null)
    expect(await isInCooldown()).toBe(false)
  })

  it('returns true when within cooldown window', async () => {
    mockKvGet.mockResolvedValue(Date.now() - 5 * 60 * 1000) // 5min ago
    expect(await isInCooldown()).toBe(true)
  })

  it('returns false when cooldown expired', async () => {
    mockKvGet.mockResolvedValue(Date.now() - 20 * 60 * 1000) // 20min ago
    expect(await isInCooldown()).toBe(false)
  })

  it('returns false (fail-open) when KV read fails', async () => {
    mockKvGet.mockRejectedValue(new Error('KV unavailable'))
    expect(await isInCooldown()).toBe(false)
  })
})

// ── [H-03] System halt flag ─────────────────────────────

describe('system halt flag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockKvGet.mockResolvedValue(null)
    mockKvSet.mockResolvedValue(undefined)
    mockKvDel.mockResolvedValue(undefined)
  })

  it('writes halt flag to KV when circuit breaker trips', async () => {
    const statuses = makeSources(5, 6)
    await checkCircuitBreaker(statuses)

    const haltCall = mockKvSet.mock.calls.find(c => c[0] === _constants.HALT_KEY)
    expect(haltCall).toBeDefined()
  })

  it('halt flag has NO TTL (requires manual clearance)', async () => {
    const statuses = makeSources(5, 6)
    await checkCircuitBreaker(statuses)

    const haltCall = mockKvSet.mock.calls.find(c => c[0] === _constants.HALT_KEY)
    expect(haltCall).toBeDefined()
    // kv.set(HALT_KEY, value) is called with exactly 2 args — no options object.
    expect(haltCall!.length).toBe(2)
    expect(haltCall![2]).toBeUndefined()
  })

  it('halt flag payload contains timestamp, reason, and disabled sources', async () => {
    const statuses = makeSources(5, 6)
    await checkCircuitBreaker(statuses)

    const haltCall = mockKvSet.mock.calls.find(c => c[0] === _constants.HALT_KEY)
    expect(haltCall![1]).toMatchObject({
      timestamp: expect.any(String),
      reason: expect.stringContaining('majority'),
      disabledSources: expect.arrayContaining(['source-disabled-0']),
    })
    expect((haltCall![1] as { disabledSources: string[] }).disabledSources).toHaveLength(6)
  })

  it('halt flag NOT written when circuit breaker does not trip', async () => {
    const statuses = makeSources(8, 3)
    await checkCircuitBreaker(statuses)

    const haltCall = mockKvSet.mock.calls.find(c => c[0] === _constants.HALT_KEY)
    expect(haltCall).toBeUndefined()
  })

  it('halt flag NOT written when suppressed by cooldown', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === _constants.COOLDOWN_KEY) return Date.now() - 5 * 60 * 1000
      return null
    })

    const statuses = makeSources(5, 6)
    await checkCircuitBreaker(statuses)

    const haltCall = mockKvSet.mock.calls.find(c => c[0] === _constants.HALT_KEY)
    expect(haltCall).toBeUndefined()
  })

  it('isSystemHalted returns true when halt flag present', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === _constants.HALT_KEY) {
        return { timestamp: '2026-04-23T00:00:00Z', reason: 'test-trip', disabledSources: ['a', 'b'] }
      }
      return null
    })
    expect(await isSystemHalted()).toBe(true)
  })

  it('isSystemHalted returns false when halt flag absent', async () => {
    mockKvGet.mockResolvedValue(null)
    expect(await isSystemHalted()).toBe(false)
  })

  it('isSystemHalted fails-open (returns false) on KV error', async () => {
    mockKvGet.mockRejectedValue(new Error('KV unavailable'))
    expect(await isSystemHalted()).toBe(false)
  })

  it('clearHalt deletes the halt key', async () => {
    await clearHalt()
    expect(mockKvDel).toHaveBeenCalledTimes(1)
    expect(mockKvDel).toHaveBeenCalledWith(_constants.HALT_KEY)
  })
})
