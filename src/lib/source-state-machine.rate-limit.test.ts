/**
 * [feat/retire-force-mev C3] HTTP 429 = rate-limited: `degraded`, never healthy, never `disabled` (a disabled source would
 * stop being called — CoW stays an ordinary, called source). The degrade is quiet: its alert fires after 30 min
 * (rate-limit-watch.ts), so a blip stays silent end to end.
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
  recordRateLimited,
  clearRateLimited,
  markRateLimitAlerted,
  getStatus,
  beginTick,
  forceDisable,
  getThresholds,
  _resetThresholdsCache,
  type HealthCheckResult,
} from './source-state-machine'

const ID = 'cowswap'
const OK: HealthCheckResult = { ok: true, latencyMs: 100 }
const FAIL: HealthCheckResult = { ok: false, latencyMs: 100, error: 'HTTP 503' }
const R429: HealthCheckResult = { ok: false, latencyMs: 40, error: 'HTTP 429 (rate-limited)', kind: 'rate-limited', retryAfterSec: 30 }
const MIN = 60_000

async function tick(result: HealthCheckResult) {
  vi.advanceTimersByTime(MIN)
  beginTick()
  await recordHealthCheck(ID, result)
  beginTick()
  return getStatus(ID)
}

describe('state machine — HTTP 429 is degraded, never healthy, never disabled', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-06T10:00:00Z'))
    vi.clearAllMocks()
    _resetThresholdsCache()
    kvStore.clear()
    kvSets.clear()
    beginTick() // drop the per-tick cache so no status leaks between tests
  })
  afterEach(() => vi.useRealTimers())

  it('one probe 429 on an active source → degraded at once, QUIETLY (no transition alert), episode recorded', async () => {
    const s = await tick(R429)
    expect(s.state).toBe('degraded')
    expect(s.rateLimit).toEqual({ since: Date.now(), lastSeenAt: Date.now(), via: ['probe'], retryAfterSec: 30 })
    expect(s.quietDegrade).toBe(true)
    expect(s.failureCount).toBe(0)
    expect(mockEmitTransitionAlert).not.toHaveBeenCalled()
  })

  it('two hours of 429s: still degraded (never disabled), failureCount untouched, `since` = the first one', async () => {
    const first = (await tick(R429)).rateLimit!.since
    let s = await getStatus(ID)
    for (let i = 0; i < 120; i++) s = await tick(R429)
    expect(s.state).toBe('degraded')
    expect(s.failureCount).toBe(0)
    expect(s.rateLimit?.since).toBe(first)
    expect(s.rateLimit?.lastSeenAt).toBe(Date.now())
  })

  it('never active while ANY signal still sees a 429; active again once both are clean', async () => {
    const t = getThresholds(ID)
    await tick(R429)
    await recordRateLimited(ID, 'quote')
    beginTick()
    expect((await getStatus(ID)).rateLimit?.via).toEqual(['probe', 'quote'])

    let s = await getStatus(ID)
    for (let i = 0; i < t.successesToActive + 3; i++) s = await tick(OK) // the probe is clean …
    expect(s.rateLimit?.via).toEqual(['quote']) // … but the real quote path still 429s
    expect(s.state).toBe('degraded')

    await clearRateLimited(ID, 'quote')
    beginTick()
    expect((await getStatus(ID)).rateLimit).toBeUndefined()
    for (let i = 0; i < t.successesToActive; i++) s = await tick(OK)
    expect(s.state).toBe('active')
  })

  it('a blip nobody was alerted about ends silently: the quiet degrade → active is not alerted either', async () => {
    const t = getThresholds(ID)
    await tick(R429)
    let s = await getStatus(ID)
    for (let i = 0; i < t.successesToActive; i++) s = await tick(OK)
    expect(s.state).toBe('active')
    expect(s.quietDegrade).toBeUndefined()
    expect(mockEmitTransitionAlert).not.toHaveBeenCalled()
  })

  it('once the 429 alert went out, the later degraded → active IS alerted (the operator was told about the degrade)', async () => {
    const t = getThresholds(ID)
    await tick(R429)
    await markRateLimitAlerted(ID, Date.now())
    beginTick()
    const marked = await getStatus(ID)
    expect(marked.rateLimit?.alertedAt).toBe(Date.now())
    expect(marked.quietDegrade).toBeUndefined()
    let s = marked
    for (let i = 0; i < t.successesToActive; i++) s = await tick(OK)
    expect(s.state).toBe('active')
    expect(mockEmitTransitionAlert).toHaveBeenCalledWith(ID, 'degraded', 'active', expect.stringContaining('consecutive successes'))
  })

  it('a non-429 probe failure clears the probe signal and counts as an ordinary failure', async () => {
    await tick(R429)
    const s = await tick(FAIL)
    expect(s.rateLimit).toBeUndefined()
    expect(s.failureCount).toBe(1)
  })

  it('a quote-path 429 (H5) degrades an active source exactly like a probe 429', async () => {
    await recordRateLimited(ID, 'quote')
    beginTick()
    const s = await getStatus(ID)
    expect(s.state).toBe('degraded')
    expect(s.rateLimit?.via).toEqual(['quote'])
    expect(mockEmitTransitionAlert).not.toHaveBeenCalled()
  })

  it('a source disabled by someone else stays disabled on a 429 (never re-enabled, never "healthy"), the episode is still recorded', async () => {
    await forceDisable(ID, 'manual: test')
    beginTick()
    const s = await tick(R429)
    expect(s.state).toBe('disabled')
    expect(s.rateLimit?.via).toEqual(['probe'])
  })
})
