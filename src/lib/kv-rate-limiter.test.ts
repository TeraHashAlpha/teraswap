/**
 * Unit tests for src/lib/kv-rate-limiter.ts — [H-01] in-memory fallback.
 *
 * Tests cover: happy-path passthrough, fallback activation on KV error,
 * 50% limit enforcement, first-failure console.error, recovery logging,
 * window reset, and periodic cleanup of the fallback map.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock KV ─────────────────────────────────────────────

const mockPipelineExec = vi.fn()
const mockZrem = vi.fn().mockResolvedValue(undefined)
const mockZrange = vi.fn().mockResolvedValue([])

function okPipeline(countBeforeAdd: number) {
  // results[1] (ZCARD) is what the code reads
  return [0, countBeforeAdd, 1, 1]
}

vi.mock('@/lib/kv', () => ({
  kv: {
    pipeline: () => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: (...args: unknown[]) => mockPipelineExec(...args),
    }),
    zrem: (...args: unknown[]) => mockZrem(...args),
    zrange: (...args: unknown[]) => mockZrange(...args),
  },
}))

import { checkRateLimit, _internal } from './kv-rate-limiter'

// ── Setup ───────────────────────────────────────────────

describe('checkRateLimit — happy path (KV healthy)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _internal.reset()
  })

  it('allows when under the limit', async () => {
    mockPipelineExec.mockResolvedValueOnce(okPipeline(2)) // 2 existing in window
    const res = await checkRateLimit('test-key', 10, 60_000)
    expect(res.allowed).toBe(true)
    expect(res.remaining).toBe(7) // 10 - 2 - 1 (this request)
  })

  it('blocks when at the limit', async () => {
    mockPipelineExec.mockResolvedValueOnce(okPipeline(10)) // already at 10/10
    mockZrange.mockResolvedValueOnce(['oldest-member', Date.now() - 30_000])
    const res = await checkRateLimit('test-key', 10, 60_000)
    expect(res.allowed).toBe(false)
    expect(res.remaining).toBe(0)
  })

  it('does not touch the fallback map on success', async () => {
    mockPipelineExec.mockResolvedValueOnce(okPipeline(1))
    await checkRateLimit('unused-key', 10, 60_000)
    expect(_internal.getFallbackMap().size).toBe(0)
  })
})

describe('[H-01] in-memory fallback on KV failure', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    _internal.reset()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('enforces 50% of normal limit on KV failure', async () => {
    mockPipelineExec.mockRejectedValue(new Error('KV down'))

    // limit=20 → fallbackLimit=10. First 10 requests allowed, 11th blocked.
    const results: boolean[] = []
    for (let i = 0; i < 11; i++) {
      const r = await checkRateLimit('ip:1.2.3.4', 20, 60_000)
      results.push(r.allowed)
    }
    expect(results.slice(0, 10).every(a => a === true)).toBe(true)
    expect(results[10]).toBe(false)
  })

  it('ceil(limit/2) handles odd limits correctly', async () => {
    mockPipelineExec.mockRejectedValue(new Error('KV down'))

    // limit=5 → ceil(2.5)=3 → allow 3, block 4th
    const results: boolean[] = []
    for (let i = 0; i < 4; i++) {
      const r = await checkRateLimit('ip:odd', 5, 60_000)
      results.push(r.allowed)
    }
    expect(results).toEqual([true, true, true, false])
  })

  it('logs console.error ONLY on first failure per outage', async () => {
    mockPipelineExec.mockRejectedValue(new Error('KV down'))

    await checkRateLimit('k1', 20, 60_000)
    await checkRateLimit('k2', 20, 60_000)
    await checkRateLimit('k3', 20, 60_000)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toMatch(/KV UNAVAILABLE/)
    expect(errorSpy.mock.calls[0][0]).toMatch(/50%/)
  })

  it('logs console.warn for every fallback request (degraded-mode marker)', async () => {
    mockPipelineExec.mockRejectedValue(new Error('KV down'))

    await checkRateLimit('k1', 20, 60_000)
    await checkRateLimit('k2', 20, 60_000)

    expect(warnSpy.mock.calls.some(c => /in-memory fallback/.test(String(c[0])))).toBe(true)
  })

  it('logs BLOCKED warning when fallback limit exceeded', async () => {
    mockPipelineExec.mockRejectedValue(new Error('KV down'))

    // Exhaust the fallback (limit=4 → fallback=2)
    await checkRateLimit('blocker', 4, 60_000)
    await checkRateLimit('blocker', 4, 60_000)
    const blocked = await checkRateLimit('blocker', 4, 60_000)

    expect(blocked.allowed).toBe(false)
    expect(warnSpy.mock.calls.some(c => /BLOCKED/.test(String(c[0])))).toBe(true)
  })

  it('resets kvFailureAlerted flag when KV recovers', async () => {
    // First call: KV fails
    mockPipelineExec.mockRejectedValueOnce(new Error('KV down'))
    await checkRateLimit('k', 20, 60_000)
    expect(_internal.isKvFailureAlerted()).toBe(true)

    // Second call: KV succeeds → flag cleared, recovery logged
    mockPipelineExec.mockResolvedValueOnce(okPipeline(0))
    await checkRateLimit('k', 20, 60_000)
    expect(_internal.isKvFailureAlerted()).toBe(false)
    expect(logSpy.mock.calls.some(c => /KV recovered/.test(String(c[0])))).toBe(true)
  })

  it('error level logged again after recovery + new outage', async () => {
    // Outage 1
    mockPipelineExec.mockRejectedValueOnce(new Error('outage-1'))
    await checkRateLimit('k', 20, 60_000)
    expect(errorSpy).toHaveBeenCalledTimes(1)

    // Recovery
    mockPipelineExec.mockResolvedValueOnce(okPipeline(0))
    await checkRateLimit('k', 20, 60_000)

    // Outage 2 — should log error again
    mockPipelineExec.mockRejectedValueOnce(new Error('outage-2'))
    await checkRateLimit('k', 20, 60_000)
    expect(errorSpy).toHaveBeenCalledTimes(2)
  })

  it('resets the fallback window after windowMs elapses', async () => {
    mockPipelineExec.mockRejectedValue(new Error('KV down'))

    // Exhaust fallback for windowMs=100ms, limit=4 → fallback=2
    await checkRateLimit('clock', 4, 100)
    await checkRateLimit('clock', 4, 100)
    const third = await checkRateLimit('clock', 4, 100)
    expect(third.allowed).toBe(false)

    // Manually fast-forward the window: mutate the entry so windowStart is in the past
    const entry = _internal.getFallbackMap().get('clock')!
    entry.windowStart = Date.now() - 200 // 200ms ago, > 100ms windowMs

    const afterReset = await checkRateLimit('clock', 4, 100)
    expect(afterReset.allowed).toBe(true)
  })

  it('periodic cleanup removes stale entries', async () => {
    mockPipelineExec.mockRejectedValue(new Error('KV down'))

    // Create 3 stale entries with windowStart far in the past
    const map = _internal.getFallbackMap()
    const STALE = Date.now() - 10 * 60_000 // 10 min ago
    map.set('stale-1', { count: 1, windowStart: STALE })
    map.set('stale-2', { count: 1, windowStart: STALE })
    map.set('stale-3', { count: 1, windowStart: STALE })

    // Drive checkCounter to a multiple of CLEANUP_INTERVAL
    for (let i = 0; i < _internal.CLEANUP_INTERVAL; i++) {
      await checkRateLimit(`driver-${i}`, 100, 60_000)
    }

    // Stale entries older than 2 * windowMs = 120s should be removed
    expect(map.has('stale-1')).toBe(false)
    expect(map.has('stale-2')).toBe(false)
    expect(map.has('stale-3')).toBe(false)
  })

  it('returns resetAt based on window start', async () => {
    mockPipelineExec.mockRejectedValue(new Error('KV down'))
    const before = Date.now()
    const r = await checkRateLimit('k', 20, 60_000)
    expect(r.resetAt).toBeGreaterThanOrEqual(before + 60_000)
    expect(r.resetAt).toBeLessThanOrEqual(Date.now() + 60_000)
  })
})
