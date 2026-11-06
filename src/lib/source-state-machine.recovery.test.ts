/**
 * State machine: probe-failed vs source-unhealthy, minimum failing window before `disabled`, and
 * probe-verified recovery (fix/monitor-self-source-alerts).
 *
 * Lifecycle under test: active -> degraded -> disabled -> (probe ok) degraded -> active.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const kvStore = new Map<string, unknown>()
const kvSets = new Set<string>()

vi.mock('@/lib/kv', () => ({
  kv: {
    get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { kvStore.set(key, value) }),
    smembers: vi.fn(async (key: string) => (key === 'teraswap:source-state:index' ? Array.from(kvSets) : [])),
    pipeline: () => {
      const p = {
        set: (key: string, value: unknown) => { kvStore.set(key, value); return p },
        sadd: (_key: string, id: string) => { kvSets.add(id); return p },
        del: () => p,
        exec: async () => [],
      }
      return p
    },
  },
}))

const mockEmitTransitionAlert = vi.fn().mockResolvedValue(undefined)
vi.mock('./alert-wrapper', () => ({
  emitTransitionAlert: (...args: unknown[]) => mockEmitTransitionAlert(...args),
}))

import {
  recordHealthCheck,
  getStatus,
  beginTick,
  forceDisable,
  checkAutoRecovery,
  shouldProbeNow,
  getThresholds,
  _resetThresholdsCache,
  DISABLED_REPROBE_MS,
} from './source-state-machine'

const OK = { ok: true, latencyMs: 100 }
const FAIL = { ok: false, latencyMs: 100, error: 'HTTP 503' }
const INFRA = { ok: false, latencyMs: 8000, error: 'transport: fetch failed', kind: 'infra' as const }
const MIN = 60_000

/** One probe per simulated 60 s tick. */
async function tick(id: string, result: { ok: boolean; latencyMs: number; error?: string; kind?: 'infra' }, advanceMs = MIN) {
  vi.advanceTimersByTime(advanceMs)
  beginTick()
  await recordHealthCheck(id, result)
  beginTick()
  return getStatus(id)
}

describe('state machine — teraswap-self lifecycle (2 degrade / 5 disable / 5 min window)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-30T10:00:00Z'))
    vi.clearAllMocks()
    _resetThresholdsCache()
    kvStore.clear()
    kvSets.clear()
  })
  afterEach(() => vi.useRealTimers())

  it('ok -> degraded -> disabled -> recovered (degraded) -> active, with no human and no blind timer', async () => {
    const id = 'teraswap-self'
    expect((await tick(id, OK)).state).toBe('active')

    expect((await tick(id, FAIL)).state).toBe('active') // 1 failure
    expect((await tick(id, FAIL)).state).toBe('degraded') // 2 -> degraded
    expect((await tick(id, FAIL)).state).toBe('degraded') // 3
    expect((await tick(id, FAIL)).state).toBe('degraded') // 4
    const disabled = await tick(id, FAIL) // 5 failures, streak spans 4 min -> window (5 min) NOT met
    expect(disabled.state).toBe('degraded')
    const d2 = await tick(id, FAIL) // 6th, streak spans 5 min -> window met
    expect(d2.state).toBe('disabled')
    expect(d2.disabledBy).toBe('health')

    // blind 10-min timer must NOT revive a health-disabled source
    vi.advanceTimersByTime(11 * MIN)
    beginTick()
    expect(await checkAutoRecovery()).toEqual([])

    // first good probe: disabled -> degraded (not straight to active)
    const rec = await tick(id, OK)
    expect(rec.state).toBe('degraded')
    expect(rec.disabledBy).toBeUndefined()
    expect(rec.disabledReason).toBeUndefined()

    expect((await tick(id, OK)).state).toBe('degraded')
    expect((await tick(id, OK)).state).toBe('active') // 3 consecutive successes

    const transitions = mockEmitTransitionAlert.mock.calls.map(c => `${c[1]}->${c[2]}`)
    expect(transitions).toEqual(['active->degraded', 'degraded->disabled', 'disabled->degraded', 'degraded->active'])
  })

  it('a failed re-probe leaves a disabled source disabled', async () => {
    const id = 'teraswap-self'
    for (let i = 0; i < 7; i++) await tick(id, FAIL)
    expect((await getStatus(id)).state).toBe('disabled')
    expect((await tick(id, FAIL)).state).toBe('disabled')
  })

  it('infra (probe-path) errors never count: any number of them keeps the source active', async () => {
    const id = 'teraswap-self'
    for (let i = 0; i < 30; i++) {
      const s = await tick(id, INFRA)
      expect(s.state).toBe('active')
      expect(s.failureCount).toBe(0)
    }
    const s = await getStatus(id)
    expect(s.infraFailures).toBe(30)
    expect(s.latencyHistory).toEqual([]) // an 8 s timeout must not poison p95
  })

  it('infra errors do not reset or extend a real failure streak, and a real result clears the infra counter', async () => {
    const id = 'teraswap-self'
    await tick(id, FAIL)
    await tick(id, INFRA)
    const s = await tick(id, FAIL)
    expect(s.failureCount).toBe(2)
    expect(s.state).toBe('degraded')
    expect((await tick(id, OK)).infraFailures).toBe(0)
  })

  it('a persistent infra streak is not silent: exactly one probe-infra-failure alert per streak', async () => {
    const id = 'teraswap-self'
    for (let i = 0; i < 25; i++) await tick(id, INFRA)
    const infraAlerts = mockEmitTransitionAlert.mock.calls.filter(c => String(c[3]).startsWith('probe-infra-failure'))
    expect(infraAlerts).toHaveLength(1)
    expect(infraAlerts[0].slice(0, 3)).toEqual([id, 'active', 'active'])
  })

  it('minimum failing window: failures bunched into seconds cannot disable the source', async () => {
    const id = 'teraswap-self'
    for (let i = 0; i < 8; i++) await tick(id, FAIL, 1_000) // 8 failures within 8 s
    expect((await getStatus(id)).state).toBe('degraded')
    await tick(id, FAIL, 5 * MIN) // streak now spans > 5 min
    expect((await getStatus(id)).state).toBe('disabled')
  })

  it('a success resets the streak start (window restarts)', async () => {
    const id = 'teraswap-self'
    for (let i = 0; i < 4; i++) await tick(id, FAIL)
    await tick(id, OK)
    expect((await getStatus(id)).failingSince).toBeUndefined()
    for (let i = 0; i < 5; i++) await tick(id, FAIL) // 5 failures but only 4 min
    expect((await getStatus(id)).state).not.toBe('disabled')
  })
})

describe('state machine — what stays unchanged', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-30T10:00:00Z'))
    vi.clearAllMocks()
    _resetThresholdsCache()
    kvStore.clear()
    kvSets.clear()
  })
  afterEach(() => vi.useRealTimers())

  it('default sources have no window (existing thresholds behave as before)', async () => {
    expect(getThresholds('velora').minFailingWindowMs).toBeUndefined()
    for (let i = 0; i < 5; i++) await tick('velora', FAIL, 1_000)
    expect((await getStatus('velora')).state).toBe('disabled')
  })

  it('forceDisable-d sources (quorum-deviation etc.) keep the old blind 10-min recovery and are never probe-recovered', async () => {
    await forceDisable('sushiswap', 'quorum-deviation')
    beginTick()
    const s = await getStatus('sushiswap')
    expect(s.disabledBy).toBeUndefined()
    await recordHealthCheck('sushiswap', OK) // a healthy HTTP probe says nothing about price deviation
    beginTick()
    expect((await getStatus('sushiswap')).state).toBe('disabled')

    vi.advanceTimersByTime(11 * MIN)
    beginTick()
    expect(await checkAutoRecovery()).toContain('sushiswap')
  })

  it('infra results are ignored by sources whose probe never emits them (aggregators unchanged)', async () => {
    for (let i = 0; i < 3; i++) await tick('cowswap', { ok: false, latencyMs: 8000, error: 'The operation was aborted' }, 1_000)
    expect((await getStatus('cowswap')).state).toBe('degraded')
  })
})

describe('shouldProbeNow — disabled sources are re-probed every K ticks', () => {
  const base = { id: 'x', lastCheckAt: 1_000_000, failureCount: 0, successCount: 0, latencyHistory: [], lastTransitionAt: 0 }

  it('probes active/degraded and non-health-disabled sources every tick', () => {
    expect(shouldProbeNow({ ...base, state: 'active' }, 1_000_001)).toBe(true)
    expect(shouldProbeNow({ ...base, state: 'degraded' }, 1_000_001)).toBe(true)
    expect(shouldProbeNow({ ...base, state: 'disabled' }, 1_000_001)).toBe(true)
  })

  it('throttles a health-disabled source to one probe per DISABLED_REPROBE_MS (with tick jitter allowance)', () => {
    const s = { ...base, state: 'disabled' as const, disabledBy: 'health' as const }
    expect(shouldProbeNow(s, s.lastCheckAt + 60_000)).toBe(false)
    expect(shouldProbeNow(s, s.lastCheckAt + 120_000)).toBe(false)
    expect(shouldProbeNow(s, s.lastCheckAt + DISABLED_REPROBE_MS - 1_000)).toBe(true) // 179 s tick jitter
    expect(shouldProbeNow(s, s.lastCheckAt + DISABLED_REPROBE_MS)).toBe(true)
  })
})
