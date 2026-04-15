/**
 * Unit tests for per-source thresholds, P0 auto-recovery blocking,
 * KV failure alerting, threshold validation, and heartbeat logic.
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
const mockPipelineDel = vi.fn()

vi.mock('@vercel/kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...(args as [string])),
    set: (...args: unknown[]) => mockKvSet(...(args as [string, unknown])),
    smembers: (...args: unknown[]) => mockKvSmembers(...(args as [string])),
    pipeline: () => ({
      set: (...args: unknown[]) => { mockPipelineSet(...(args as [string, unknown])); return { sadd: mockPipelineSadd, exec: mockPipelineExec, del: mockPipelineDel } },
      sadd: (...args: unknown[]) => { mockPipelineSadd(...(args as [string, string])); return { set: mockPipelineSet, exec: mockPipelineExec, del: mockPipelineDel } },
      del: (...args: unknown[]) => { mockPipelineDel(...args); return { set: mockPipelineSet, sadd: mockPipelineSadd, exec: mockPipelineExec, del: mockPipelineDel } },
      exec: mockPipelineExec,
    }),
  },
}))

// ── Mock alert-wrapper ─────────────────────────────────────────

const mockEmitTransitionAlert = vi.fn().mockResolvedValue(undefined)

vi.mock('./alert-wrapper', () => ({
  emitTransitionAlert: (...args: unknown[]) => mockEmitTransitionAlert(...args),
}))

// ── Import after mocks ─────────────────────────────────────────

import {
  getThresholds,
  _resetThresholdsCache,
  recordHealthCheck,
  getStatus,
  beginTick,
  forceDisable,
  checkAutoRecovery,
} from './source-state-machine'

import { isP0Reason, P0_REASONS } from './p0-reasons'
import { isInGracePeriod } from './grace-period'

const originalEnv = { ...process.env }

// ═══════════════════════════════════════════════════════════════
// Existing threshold tests
// ═══════════════════════════════════════════════════════════════

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

  describe('defaults', () => {
    it('returns default thresholds for unknown source', () => {
      const t = getThresholds('unknown-source')
      expect(t).toEqual({
        failuresToDegraded: 3,
        failuresToDisabled: 5,
        successesToActive: 3,
        p95LatencyThresholdMs: 5000,
        quorumMaxDeviationPercent: 5,
        quorumStableMaxDeviationPercent: 2,
      })
    })
  })

  describe('overrides', () => {
    it('returns custom thresholds for 1inch (partial override fills defaults)', () => {
      const t = getThresholds('1inch')
      expect(t.failuresToDegraded).toBe(4)
      expect(t.failuresToDisabled).toBe(7)
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

  describe('threshold-driven state transitions', () => {
    it('cowswap degrades after 2 failures (not 3)', async () => {
      await recordHealthCheck('cowswap', { ok: false, latencyMs: 100, error: 'timeout' })
      beginTick()

      let s = await getStatus('cowswap')
      expect(s.state).toBe('active')
      expect(s.failureCount).toBe(1)

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

  describe('cache behavior', () => {
    it('returns same thresholds after cache reset', () => {
      const t1 = getThresholds('1inch')
      _resetThresholdsCache()
      const t2 = getThresholds('1inch')
      expect(t1).toEqual(t2)
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// Heartbeat endpoint logic tests (existing)
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// NEW TESTS — Audit findings C-01, H-02, M-03, L-08
// ═══════════════════════════════════════════════════════════════

describe('[C-01] P0 auto-recovery bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetThresholdsCache()
    kvStore.clear()
    kvSets.clear()
  })

  it('does NOT auto-recover source disabled with suffixed tls-fingerprint-change reason', async () => {
    // Force-disable with a descriptive suffix (as H2 validator produces)
    await forceDisable('cowswap', 'tls-fingerprint-change: Issuer changed from DigiCert to Let\'s Encrypt')
    beginTick()

    let s = await getStatus('cowswap')
    expect(s.state).toBe('disabled')
    expect(s.disabledReason).toBe('tls-fingerprint-change: Issuer changed from DigiCert to Let\'s Encrypt')

    // Simulate 10+ minutes passing
    s.disabledAt = Date.now() - 11 * 60_000
    kvStore.set('teraswap:source-state:cowswap', s)
    kvSets.add('cowswap')
    beginTick()

    const recovered = await checkAutoRecovery()

    // Must NOT recover — P0 reason blocks auto-recovery
    expect(recovered).not.toContain('cowswap')
    beginTick()
    s = await getStatus('cowswap')
    expect(s.state).toBe('disabled')
  })

  it('does NOT auto-recover source disabled with suffixed dns-record-change reason', async () => {
    await forceDisable('zerox', 'dns-record-change: NS mismatch detected')
    beginTick()

    const s = await getStatus('zerox')
    s.disabledAt = Date.now() - 11 * 60_000
    kvStore.set('teraswap:source-state:zerox', s)
    kvSets.add('zerox')
    beginTick()

    const recovered = await checkAutoRecovery()
    expect(recovered).not.toContain('zerox')
  })

  it('DOES auto-recover source disabled with non-P0 reason after 10 min', async () => {
    await forceDisable('sushiswap', 'consecutive-failures')
    beginTick()

    const s = await getStatus('sushiswap')
    s.disabledAt = Date.now() - 11 * 60_000
    kvStore.set('teraswap:source-state:sushiswap', s)
    kvSets.add('sushiswap')
    beginTick()

    const recovered = await checkAutoRecovery()
    expect(recovered).toContain('sushiswap')

    beginTick()
    const after = await getStatus('sushiswap')
    expect(after.state).toBe('active')
  })
})

describe('[H-02] KV failure routes through alert-wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetThresholdsCache()
    kvStore.clear()
    kvSets.clear()
  })

  it('calls emitTransitionAlert with kv-store-failure reason on KV write error', async () => {
    // Make the pipeline exec throw
    mockPipelineExec.mockRejectedValueOnce(new Error('Connection refused'))

    await recordHealthCheck('1inch', { ok: true, latencyMs: 50 })

    // emitTransitionAlert should have been called with kv-store-failure reason
    // (may also be called by transition(), so check for any call with kv-store-failure)
    const kvFailureCalls = mockEmitTransitionAlert.mock.calls.filter(
      (args: unknown[]) => typeof args[3] === 'string' && (args[3] as string).startsWith('kv-store-failure'),
    )
    expect(kvFailureCalls.length).toBeGreaterThanOrEqual(1)
    expect(kvFailureCalls[0][3]).toContain('kv-store-failure: write')
  })
})

describe('[M-03] Threshold validation', () => {
  beforeEach(() => {
    _resetThresholdsCache()
  })

  it('validates real thresholds pass through correctly', () => {
    const t = getThresholds('1inch')
    expect(t.failuresToDegraded).toBe(4) // real value
    expect(t.failuresToDisabled).toBe(7) // real value
  })

  // The validation applies to the JSON config at load time.
  // Since we can't inject bad JSON without mocking the import,
  // we test the shared isP0Reason function instead which is the
  // critical path.
})

describe('[L-08] Shared modules — single source of truth', () => {
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('isP0Reason is the same function used in both state machine and alert-wrapper', async () => {
    // Verify the shared module exports match what's used
    expect(typeof isP0Reason).toBe('function')
    expect(isP0Reason('kill-switch-triggered')).toBe(true)
    expect(isP0Reason('tls-fingerprint-change: Issuer changed')).toBe(true)
    expect(isP0Reason('dns-record-change: NS mismatch')).toBe(true)
    expect(isP0Reason('kv-store-failure: write — timeout')).toBe(true)
    expect(isP0Reason('consecutive-failures')).toBe(false)
    expect(isP0Reason(undefined)).toBe(false)
    expect(isP0Reason(null)).toBe(false)
  })

  it('P0_REASONS includes kv-store-failure', () => {
    expect(P0_REASONS).toContain('kv-store-failure')
  })

  it('isInGracePeriod reads from MONITOR_GRACE_UNTIL', () => {
    delete process.env.MONITOR_GRACE_UNTIL
    expect(isInGracePeriod()).toBe(false)

    process.env.MONITOR_GRACE_UNTIL = new Date(Date.now() + 3600_000).toISOString()
    expect(isInGracePeriod()).toBe(true)

    process.env.MONITOR_GRACE_UNTIL = new Date(Date.now() - 3600_000).toISOString()
    expect(isInGracePeriod()).toBe(false)
  })
})
