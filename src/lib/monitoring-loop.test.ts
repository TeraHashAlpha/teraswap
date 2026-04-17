/**
 * Integration tests for the monitoring loop.
 *
 * Covers:
 * - H5 quorum wiring (tick cadence, result passthrough, error resilience)
 * - [I-02] Single alert path — transitions emit exactly one alert via emitTransitionAlert
 * - forceActivate() emits an alert through emitTransitionAlert
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Simulated KV store ─────────────────────────────────

const kvStore = new Map<string, unknown>()
const kvSets = new Map<string, Set<string>>()

function getKvSet(key: string): Set<string> {
  if (!kvSets.has(key)) kvSets.set(key, new Set())
  return kvSets.get(key)!
}

const mockKvGet = vi.fn(async (key: string) => kvStore.get(key) ?? null)
const mockKvSet = vi.fn(async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
  // Support SET NX semantics for distributed lock tests
  if (opts?.nx && kvStore.has(key)) {
    return null // Key exists → NX fails
  }
  kvStore.set(key, value)
  return 'OK'
})
const mockKvSmembers = vi.fn(async (key: string) => Array.from(getKvSet(key)))
const mockKvIncr = vi.fn(async (key: string) => {
  const current = (kvStore.get(key) as number) ?? 0
  const next = current + 1
  kvStore.set(key, next)
  return next
})

const mockPipelineSet = vi.fn((key: string, value: unknown) => { kvStore.set(key, value) })
const mockPipelineSadd = vi.fn((key: string, member: string) => { getKvSet(key).add(member) })
const mockPipelineIncr = vi.fn(async (key: string) => {
  const current = (kvStore.get(key) as number) ?? 0
  const next = current + 1
  kvStore.set(key, next)
  return next
})
const mockPipelineExec = vi.fn(async () => [])
const mockPipelineDel = vi.fn()

vi.mock('@vercel/kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...(args as [string])),
    set: (...args: unknown[]) => mockKvSet(...(args as [string, unknown])),
    smembers: (...args: unknown[]) => mockKvSmembers(...(args as [string])),
    incr: (...args: unknown[]) => mockKvIncr(...(args as [string])),
    pipeline: () => ({
      set: (...args: unknown[]) => {
        mockPipelineSet(...(args as [string, unknown]))
        return { sadd: mockPipelineSadd, exec: mockPipelineExec, del: mockPipelineDel, incr: mockPipelineIncr }
      },
      sadd: (...args: unknown[]) => {
        mockPipelineSadd(...(args as [string, string]))
        return { set: mockPipelineSet, exec: mockPipelineExec, del: mockPipelineDel, incr: mockPipelineIncr }
      },
      del: (...args: unknown[]) => {
        mockPipelineDel(...args)
        return { set: mockPipelineSet, sadd: mockPipelineSadd, exec: mockPipelineExec, incr: mockPipelineIncr }
      },
      incr: (...args: unknown[]) => {
        mockPipelineIncr(...(args as [string]))
        return { set: mockPipelineSet, sadd: mockPipelineSadd, exec: mockPipelineExec, del: mockPipelineDel }
      },
      exec: mockPipelineExec,
    }),
  },
}))

// ── Mock health-check ──────────────────────────────────

vi.mock('./health-check', () => ({
  runHealthCheck: vi.fn(async () => ({ ok: true, latencyMs: 50 })),
}))

// ── Mock monitored-endpoints ───────────────────────────

vi.mock('./monitored-endpoints', () => ({
  MONITORED_ENDPOINTS: [
    { id: '1inch', hostname: 'api.1inch.io', url: 'https://api.1inch.io/v5.0/1/healthcheck' },
  ],
}))

// ── Mock fingerprint-validator ─────────────────────────

vi.mock('./fingerprint-validator', () => ({
  loadBaseline: vi.fn(() => null), // No baseline → skip H2
  validateTLS: vi.fn(),
  validateDNS: vi.fn(),
  captureLiveTLS: vi.fn(),
  captureLiveDNS: vi.fn(),
}))

// ── Mock alert-wrapper ─────────────────────────────────

const mockEmitTransitionAlert = vi.fn().mockResolvedValue(undefined)

vi.mock('./alert-wrapper', () => ({
  emitTransitionAlert: (...args: unknown[]) => mockEmitTransitionAlert(...args),
}))

// ── Mock quorum-check ──────────────────────────────────

const mockShouldRunQuorum = vi.fn()
const mockRunQuorumCheck = vi.fn()

vi.mock('./quorum-check', () => ({
  shouldRunQuorum: (...args: unknown[]) => mockShouldRunQuorum(...args),
  runQuorumCheck: (...args: unknown[]) => mockRunQuorumCheck(...args),
}))

// ── Mock fetchMetaQuote (for source-state-machine transitive import) ──

vi.mock('./api', () => ({
  fetchMetaQuote: vi.fn(),
}))

// ── Import after mocks ─────────────────────────────────

import { runMonitoringTick } from './monitoring-loop'
import {
  beginTick,
  recordHealthCheck,
  forceDisable,
  forceActivate,
  getStatus,
} from './source-state-machine'
import { runHealthCheck } from './health-check'

// ═══════════════════════════════════════════════════════════════

describe('monitoring-loop H5 integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
    kvSets.clear()
    beginTick()
    mockShouldRunQuorum.mockResolvedValue(false) // default: not a quorum tick
  })

  it('calls shouldRunQuorum on every tick', async () => {
    await runMonitoringTick()
    expect(mockShouldRunQuorum).toHaveBeenCalledTimes(1)
  })

  it('does NOT call runQuorumCheck when shouldRunQuorum returns false', async () => {
    mockShouldRunQuorum.mockResolvedValue(false)
    const result = await runMonitoringTick()
    expect(mockRunQuorumCheck).not.toHaveBeenCalled()
    expect(result.quorum).toBeUndefined()
  })

  it('calls runQuorumCheck when shouldRunQuorum returns true', async () => {
    mockShouldRunQuorum.mockResolvedValue(true)
    mockRunQuorumCheck.mockResolvedValue({
      timestamp: '2026-04-15T00:00:00.000Z',
      pairs: [],
      outliers: [],
      correlatedOutlierCount: 0,
      skipped: false,
    })

    const result = await runMonitoringTick()
    expect(mockRunQuorumCheck).toHaveBeenCalledTimes(1)
    expect(result.quorum).toBeDefined()
    expect(result.quorum!.timestamp).toBe('2026-04-15T00:00:00.000Z')
    expect(result.quorum!.correlatedOutlierCount).toBe(0)
  })

  it('includes quorum result in tick result when present', async () => {
    mockShouldRunQuorum.mockResolvedValue(true)
    const quorumData = {
      timestamp: '2026-04-15T00:05:00.000Z',
      pairs: [{ label: 'WETH→USDC (1 ETH)', medianAmount: '3000000000', quotesCollected: 5, outliers: [], skipped: false, maxDeviationPercent: 5 }],
      outliers: [{ sourceId: 'velora', deviationPercent: 6.5, medianAmount: '3000000000', sourceAmount: '3195000000', classification: 'warning', pairLabel: 'WETH→USDC (1 ETH)' }],
      correlatedOutlierCount: 0,
      skipped: false,
    }
    mockRunQuorumCheck.mockResolvedValue(quorumData)

    const result = await runMonitoringTick()
    expect(result.quorum).toEqual(quorumData)
  })

  it('logs correlated anomaly when ≥3 sources flagged', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockShouldRunQuorum.mockResolvedValue(true)
    mockRunQuorumCheck.mockResolvedValue({
      timestamp: '2026-04-15T00:00:00.000Z',
      pairs: [],
      outliers: [],
      correlatedOutlierCount: 3,
      skipped: false,
    })

    await runMonitoringTick()
    const correlatedLogs = consoleSpy.mock.calls.filter(
      args => typeof args[0] === 'string' && args[0].includes('H5 correlated anomaly'),
    )
    expect(correlatedLogs.length).toBe(1)
    expect(correlatedLogs[0][0]).toContain('3 sources flagged')
    consoleSpy.mockRestore()
  })

  it('survives runQuorumCheck failure without crashing the tick', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockShouldRunQuorum.mockResolvedValue(true)
    mockRunQuorumCheck.mockRejectedValue(new Error('Quorum fetch timeout'))

    const result = await runMonitoringTick()
    // Tick should still complete successfully
    expect(result.timestamp).toBeDefined()
    expect(result.quorum).toBeUndefined()

    const warnLogs = consoleSpy.mock.calls.filter(
      args => typeof args[0] === 'string' && args[0].includes('Quorum check failed'),
    )
    expect(warnLogs.length).toBe(1)
    consoleSpy.mockRestore()
  })

  it('survives shouldRunQuorum failure without crashing the tick', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockShouldRunQuorum.mockRejectedValue(new Error('KV down'))

    const result = await runMonitoringTick()
    expect(result.timestamp).toBeDefined()
    expect(result.quorum).toBeUndefined()
    consoleSpy.mockRestore()
  })

  it('tick result omits quorum key entirely on non-quorum ticks', async () => {
    mockShouldRunQuorum.mockResolvedValue(false)
    const result = await runMonitoringTick()
    expect('quorum' in result).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// KV persistence tests (quorum-check.ts writes)
// ═══════════════════════════════════════════════════════════════

describe('quorum KV persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
    kvSets.clear()
    beginTick()
  })

  it('monitoring loop passes quorum result through correctly', async () => {
    mockShouldRunQuorum.mockResolvedValue(true)
    const quorumData = {
      timestamp: '2026-04-15T00:00:00.000Z',
      pairs: [],
      outliers: [],
      correlatedOutlierCount: 0,
      skipped: false,
    }
    mockRunQuorumCheck.mockResolvedValue(quorumData)

    const result = await runMonitoringTick()
    expect(result.quorum).toEqual(quorumData)
    expect(result.quorum!.skipped).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// [I-02] Single alert path — no duplicate Telegram sends
// ═══════════════════════════════════════════════════════════════

describe('[I-02] single alert path', () => {
  function seedSource(sourceId: string, state: 'active' | 'degraded' | 'disabled' = 'active'): void {
    getKvSet('teraswap:source-state:index').add(sourceId)
    kvStore.set(`teraswap:source-state:${sourceId}`, {
      id: sourceId,
      state,
      lastCheckAt: Date.now(),
      failureCount: 0,
      successCount: 0,
      latencyHistory: [],
      lastTransitionAt: Date.now(),
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
    kvSets.clear()
    beginTick()
    mockShouldRunQuorum.mockResolvedValue(false)
  })

  it('state transition emits exactly ONE alert via emitTransitionAlert (not two)', async () => {
    seedSource('cowswap', 'active')

    // Force-disable triggers active → disabled transition
    await forceDisable('cowswap', 'test-single-alert')

    // emitTransitionAlert should be called exactly once for this transition
    const transitionCalls = mockEmitTransitionAlert.mock.calls.filter(
      (args: unknown[]) => args[0] === 'cowswap',
    )
    expect(transitionCalls.length).toBe(1)
    expect(transitionCalls[0][1]).toBe('active')  // from
    expect(transitionCalls[0][2]).toBe('disabled') // to
    expect(transitionCalls[0][3]).toContain('test-single-alert')
  })

  it('no direct Telegram fetch calls from monitoring-loop (legacy path removed)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    seedSource('cowswap', 'active')

    await forceDisable('cowswap', 'test-no-telegram')

    // There should be NO direct fetch calls to Telegram API.
    // All Telegram alerts go through emitTransitionAlert → alert-channels/telegram
    // which is mocked here.
    const telegramCalls = fetchSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('api.telegram.org'),
    )
    expect(telegramCalls.length).toBe(0)

    fetchSpy.mockRestore()
  })

  it('forceActivate emits alert via emitTransitionAlert', async () => {
    seedSource('cowswap', 'disabled')

    await forceActivate('cowswap')

    const activateCalls = mockEmitTransitionAlert.mock.calls.filter(
      (args: unknown[]) => args[0] === 'cowswap' && args[2] === 'active',
    )
    expect(activateCalls.length).toBe(1)
    expect(activateCalls[0][1]).toBe('disabled') // from
    expect(activateCalls[0][2]).toBe('active')   // to
    expect(activateCalls[0][3]).toContain('force activated')
  })

  it('forceActivate on already-active source does NOT emit alert (no-op transition)', async () => {
    seedSource('cowswap', 'active')

    await forceActivate('cowswap')

    const activateCalls = mockEmitTransitionAlert.mock.calls.filter(
      (args: unknown[]) => args[0] === 'cowswap',
    )
    expect(activateCalls.length).toBe(0)
  })

  it('degraded → disabled transition emits exactly one alert', async () => {
    seedSource('velora', 'degraded')

    await forceDisable('velora', 'consecutive-failures')

    const calls = mockEmitTransitionAlert.mock.calls.filter(
      (args: unknown[]) => args[0] === 'velora',
    )
    expect(calls.length).toBe(1)
    expect(calls[0][1]).toBe('degraded')
    expect(calls[0][2]).toBe('disabled')
  })

  it('auto-recovery (disabled → active) emits exactly one alert', async () => {
    seedSource('sushiswap', 'disabled')
    // Set up the disabled state with non-P0 reason and old timestamp for auto-recovery
    const s = await getStatus('sushiswap')
    s.disabledAt = Date.now() - 11 * 60_000
    s.disabledReason = 'consecutive-failures'
    kvStore.set('teraswap:source-state:sushiswap', s)
    getKvSet('teraswap:source-state:index').add('sushiswap')
    beginTick()

    // Import checkAutoRecovery
    const { checkAutoRecovery } = await import('./source-state-machine')
    await checkAutoRecovery()

    const recoveryCalls = mockEmitTransitionAlert.mock.calls.filter(
      (args: unknown[]) => args[0] === 'sushiswap' && args[2] === 'active',
    )
    expect(recoveryCalls.length).toBe(1)
    expect(recoveryCalls[0][1]).toBe('disabled')
    expect(recoveryCalls[0][2]).toBe('active')
    expect(recoveryCalls[0][3]).toContain('auto-recovery')
  })
})

// ═══════════════════════════════════════════════════════════════
// Cold-start warmup detection
// ═══════════════════════════════════════════════════════════════

describe('cold-start warmup detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
    kvSets.clear()
    beginTick()
    mockShouldRunQuorum.mockResolvedValue(false)
  })

  it('flags warmup when last tick was >5 minutes ago', async () => {
    // Last tick 10 minutes ago → cold start
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
    kvStore.set('teraswap:monitor:lastTick', tenMinAgo)

    const result = await runMonitoringTick()

    expect(result.warmup).toBe(true)
  })

  it('does NOT flag warmup when last tick was 50s ago', async () => {
    // Last tick 50 seconds ago → warm
    const recent = new Date(Date.now() - 50_000).toISOString()
    kvStore.set('teraswap:monitor:lastTick', recent)

    const result = await runMonitoringTick()

    expect(result.warmup).toBeUndefined()
  })

  it('flags warmup on first-ever tick (no lastTick in KV)', async () => {
    // No lastTick key → first tick
    const result = await runMonitoringTick()

    expect(result.warmup).toBe(true)
  })

  it('warmup tick still records success/failure counts', async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
    kvStore.set('teraswap:monitor:lastTick', tenMinAgo)

    // Mock health check returns ok: true
    const mockHC = vi.mocked(runHealthCheck)
    mockHC.mockResolvedValue({ ok: true, latencyMs: 8000 })

    const result = await runMonitoringTick()

    expect(result.warmup).toBe(true)
    expect(result.checksRun).toBe(1)
    expect(result.failures).toBe(0)

    // Verify the source status was updated (success counted) but latency NOT recorded
    beginTick() // clear cache to read from KV
    const status = await getStatus('1inch')
    expect(status.successCount).toBeGreaterThanOrEqual(1)
    // Latency history should be empty — warmup skipped recording
    expect(status.latencyHistory).toEqual([])
  })

  it('warm tick records latency normally', async () => {
    const recent = new Date(Date.now() - 50_000).toISOString()
    kvStore.set('teraswap:monitor:lastTick', recent)

    const mockHC = vi.mocked(runHealthCheck)
    mockHC.mockResolvedValue({ ok: true, latencyMs: 200 })

    const result = await runMonitoringTick()

    expect(result.warmup).toBeUndefined()

    beginTick()
    const status = await getStatus('1inch')
    expect(status.latencyHistory).toContain(200)
  })

  it('writes warmup flag to KV for heartbeat', async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
    kvStore.set('teraswap:monitor:lastTick', tenMinAgo)

    await runMonitoringTick()

    // Pipeline.set should have been called with the warmup key
    const warmupCalls = mockPipelineSet.mock.calls.filter(
      (args) => args[0] === 'teraswap:monitor:lastTickWarmup',
    )
    expect(warmupCalls.length).toBe(1)
    expect(warmupCalls[0][1]).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// [API-M-03] Distributed lock — concurrent tick prevention
// ═══════════════════════════════════════════════════════════════

describe('[API-M-03] distributed tick lock', () => {
  const LOCK_KEY = 'teraswap:monitor:tick-lock'

  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
    kvSets.clear()
    beginTick()
    mockShouldRunQuorum.mockResolvedValue(false)
  })

  it('first tick acquires lock and executes normally', async () => {
    // Seed a recent lastTick so warmup doesn't flag
    kvStore.set('teraswap:monitor:lastTick', new Date(Date.now() - 50_000).toISOString())

    const result = await runMonitoringTick()

    // Should have executed (not skipped)
    expect(result.skipped).toBeUndefined()
    expect(result.checksRun).toBe(1)
    expect(result.timestamp).toBeDefined()

    // Lock key should have been written via kv.set with NX
    const lockCalls = mockKvSet.mock.calls.filter(
      (args) => args[0] === LOCK_KEY,
    )
    expect(lockCalls.length).toBe(1)
    // Should use NX + TTL
    expect(lockCalls[0][2]).toMatchObject({ nx: true, ex: 55 })
  })

  it('concurrent tick while lock held → skipped', async () => {
    // Pre-set the lock key (simulating another tick holding it)
    kvStore.set(LOCK_KEY, Date.now().toString())

    const result = await runMonitoringTick()

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('concurrent-tick-lock')
    expect(result.checksRun).toBe(0)
  })

  it('skipped tick does NOT update lastTick heartbeat', async () => {
    // Set an old lastTick value
    const oldIso = '2026-04-16T00:00:00.000Z'
    kvStore.set('teraswap:monitor:lastTick', oldIso)

    // Pre-set lock to force skip
    kvStore.set(LOCK_KEY, Date.now().toString())

    await runMonitoringTick()

    // The heartbeat pipeline should NOT have been called
    const heartbeatCalls = mockPipelineSet.mock.calls.filter(
      (args) => args[0] === 'teraswap:monitor:lastTick',
    )
    expect(heartbeatCalls.length).toBe(0)

    // lastTick value should be unchanged
    expect(kvStore.get('teraswap:monitor:lastTick')).toBe(oldIso)
  })

  it('lock expires after TTL → next tick proceeds', async () => {
    // First tick acquires lock
    const result1 = await runMonitoringTick()
    expect(result1.skipped).toBeUndefined()

    // Simulate lock expiry by clearing it
    kvStore.delete(LOCK_KEY)
    vi.clearAllMocks()
    beginTick()
    mockShouldRunQuorum.mockResolvedValue(false)

    // Next tick should succeed
    const result2 = await runMonitoringTick()
    expect(result2.skipped).toBeUndefined()
    expect(result2.checksRun).toBe(1)
  })

  it('KV failure on lock acquire → tick proceeds (fail-open)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Make kv.set throw only for the lock key
    mockKvSet.mockImplementation(async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (key === LOCK_KEY) throw new Error('KV connection refused')
      if (opts?.nx && kvStore.has(key)) return null
      kvStore.set(key, value)
      return 'OK'
    })

    const result = await runMonitoringTick()

    // Should NOT be skipped — fail-open proceeds with tick
    expect(result.skipped).toBeUndefined()
    expect(result.checksRun).toBe(1)

    // Should have logged the warning
    const warnLogs = consoleSpy.mock.calls.filter(
      args => typeof args[0] === 'string' && args[0].includes('Lock acquire failed'),
    )
    expect(warnLogs.length).toBe(1)
    consoleSpy.mockRestore()
  })
})
