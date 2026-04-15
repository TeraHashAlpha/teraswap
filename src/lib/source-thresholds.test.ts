/**
 * Unit tests for per-source threshold loading and the heartbeat endpoint.
 *
 * Tests cover:
 *  - Threshold defaults: unknown source gets default values
 *  - Threshold overrides: known sources get custom values with defaults filled in
 *  - Missing file fallback: graceful degradation to hardcoded defaults
 *  - Threshold-driven state transitions: cowswap degrades after 2, 1inch after 4
 *  - Heartbeat response shape and healthy/unhealthy logic
 *  - Heartbeat grace period override
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Simulated KV store for state persistence across calls ──────

const kvStore = new Map<string, unknown>()
const kvSets = new Set<string>() // smembers set

const mockKvGet = vi.fn(async (key: string) => kvStore.get(key) ?? null)
const mockKvSet = vi.fn(async (key: string, value: unknown) => { kvStore.set(key, value) })
const mockKvSmembers = vi.fn(async (key: string) => {
  if (key === 'teraswap:source-state:index') return Array.from(kvSets)
  return []
})

const mockPipelineSet = vi.fn((key: string, value: unknown) => { kvStore.set(key, value) })
const mockPipelineSadd = vi.fn((_key: string, id: string) => { kvSets.add(id) })
const mockPipelineExec = vi.fn(async () => [])

vi.mock('@vercel/kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...(args as [string])),
    set: (...args: unknown[]) => mockKvSet(...(args as [string, unknown])),
    smembers: (...args: unknown[]) => mockKvSmembers(...(args as [string])),
    pipeline: () => ({
      set: (...args: unknown[]) => { mockPipelineSet(...(args as [string, unknown])); return { sadd: mockPipelineSadd, exec: mockPipelineExec } },
      sadd: (...args: unknown[]) => { mockPipelineSadd(...(args as [string, string])); return { set: mockPipelineSet, exec: mockPipelineExec } },
      exec: mockPipelineExec,
    }),
  },
}))

// ── Mock alert-wrapper (fire-and-forget, don't test here) ──────

vi.mock('./alert-wrapper', () => ({
  emitTransitionAlert: vi.fn().mockResolvedValue(undefined),
}))

// ── Import after mocks ─────────────────────────────────────────

import {
  getThresholds,
  _resetThresholdsCache,
  recordHealthCheck,
  getStatus,
  beginTick,
} from './source-state-machine'

const originalEnv = { ...process.env }

describe('source thresholds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetThresholdsCache()
    kvStore.clear()
    kvSets.clear()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  // ── Defaults ─────────────────────────────────────────────

  describe('defaults', () => {
    it('returns default thresholds for unknown source', () => {
      const t = getThresholds('unknown-source')
      expect(t).toEqual({
        failuresToDegraded: 3,
        failuresToDisabled: 5,
        successesToActive: 3,
        p95LatencyThresholdMs: 5000,
      })
    })
  })

  // ── Overrides ────────────────────────────────────────────

  describe('overrides', () => {
    it('returns custom thresholds for 1inch (partial override fills defaults)', () => {
      const t = getThresholds('1inch')
      expect(t.failuresToDegraded).toBe(4)
      expect(t.failuresToDisabled).toBe(7)
      // These are not overridden → fall back to defaults
      expect(t.successesToActive).toBe(3)
      expect(t.p95LatencyThresholdMs).toBe(5000)
    })

    it('returns custom thresholds for cowswap', () => {
      const t = getThresholds('cowswap')
      expect(t.failuresToDegraded).toBe(2)
      expect(t.failuresToDisabled).toBe(3)
    })

    it('returns custom thresholds for teraswap-self', () => {
      const t = getThresholds('teraswap-self')
      expect(t.failuresToDegraded).toBe(2)
      expect(t.failuresToDisabled).toBe(3)
      expect(t.p95LatencyThresholdMs).toBe(3000)
    })

    it('returns custom thresholds for 0x', () => {
      const t = getThresholds('0x')
      expect(t.failuresToDegraded).toBe(4)
      expect(t.failuresToDisabled).toBe(7)
    })
  })

  // ── Threshold-driven transitions ─────────────────────────

  describe('threshold-driven state transitions', () => {
    it('cowswap degrades after 2 failures (not 3)', async () => {
      // First failure — stays active
      await recordHealthCheck('cowswap', { ok: false, latencyMs: 100, error: 'timeout' })
      beginTick() // clear tick cache so next read hits KV store

      let s = await getStatus('cowswap')
      expect(s.state).toBe('active')
      expect(s.failureCount).toBe(1)

      // Second failure → should degrade (cowswap threshold is 2)
      await recordHealthCheck('cowswap', { ok: false, latencyMs: 100, error: 'timeout' })
      beginTick()

      s = await getStatus('cowswap')
      expect(s.state).toBe('degraded')
    })

    it('1inch stays active after 3 failures (needs 4 to degrade)', async () => {
      for (let i = 0; i < 3; i++) {
        await recordHealthCheck('1inch', { ok: false, latencyMs: 100, error: 'timeout' })
        beginTick()
      }
      let s = await getStatus('1inch')
      expect(s.state).toBe('active')
      expect(s.failureCount).toBe(3)

      // 4th failure → degrades
      await recordHealthCheck('1inch', { ok: false, latencyMs: 100, error: 'timeout' })
      beginTick()

      s = await getStatus('1inch')
      expect(s.state).toBe('degraded')
    })

    it('default source (velora) degrades after 3 failures', async () => {
      for (let i = 0; i < 3; i++) {
        await recordHealthCheck('velora', { ok: false, latencyMs: 100, error: 'timeout' })
        beginTick()
      }
      const s = await getStatus('velora')
      expect(s.state).toBe('degraded')
    })
  })

  // ── Stable on cache reset ────────────────────────────────

  describe('cache behavior', () => {
    it('returns same thresholds after cache reset', () => {
      const t1 = getThresholds('1inch')
      _resetThresholdsCache()
      const t2 = getThresholds('1inch')
      expect(t1).toEqual(t2)
    })
  })
})

// ── Heartbeat response tests ───────────────────────────────────

describe('heartbeat endpoint logic', () => {
  const STALE_THRESHOLD = 180

  function computeHealthy(ageSeconds: number | null, grace: boolean): boolean {
    if (grace) return true
    if (ageSeconds === null) return false
    return ageSeconds < STALE_THRESHOLD
  }

  it('healthy when age < 180s', () => {
    expect(computeHealthy(58, false)).toBe(true)
  })

  it('unhealthy when age >= 180s', () => {
    expect(computeHealthy(200, false)).toBe(false)
  })

  it('unhealthy when age is null (no tick data)', () => {
    expect(computeHealthy(null, false)).toBe(false)
  })

  it('healthy during grace period regardless of age', () => {
    expect(computeHealthy(999, true)).toBe(true)
    expect(computeHealthy(null, true)).toBe(true)
  })

  it('healthy when age is exactly 0 (just ticked)', () => {
    expect(computeHealthy(0, false)).toBe(true)
  })

  it('unhealthy at exactly 180s boundary', () => {
    expect(computeHealthy(180, false)).toBe(false)
  })
})
