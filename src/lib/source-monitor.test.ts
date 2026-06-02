/**
 * [SPRINT-9F backlog] source-monitor no-route vs failure convention.
 *
 * A legitimate no-route (an adapter resolved `null` — the upstream answered
 * but has no quote for this pair/size) must be recorded as NOT-A-FAILURE:
 * it neither increments the failure / consecutive-failure counters nor counts
 * toward the success rate. This mirrors the circuit breaker, where a resolved
 * null is NEUTRAL. A present-but-unusable amount ('Zero output') and a thrown
 * error remain real failures — the two were previously conflated under the
 * single 'Zero output' label.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordSourcePing,
  recordSourceNoRoute,
  getSourceStats,
  resetMonitoring,
} from './source-monitor'

function statsFor(source: string) {
  return getSourceStats().find((s) => s.source === source)
}

describe('source-monitor — no-route is not a failure [SPRINT-9F backlog]', () => {
  beforeEach(() => {
    resetMonitoring()
  })

  it('records a no-route as neither a success nor a failure', () => {
    recordSourceNoRoute('bebop', 42)
    const s = statsFor('bebop')!
    expect(s.failures).toBe(0)
    expect(s.successes).toBe(0)
    expect(s.consecutiveFailures).toBe(0)
    expect(s.noRoutes).toBe(1)
    expect(s.lastError).toBeNull()
  })

  it('a no-route does NOT reset a prior failure streak', () => {
    recordSourcePing('bebop', false, 10, 'upstream 502')
    recordSourcePing('bebop', false, 10, 'upstream 502')
    expect(statsFor('bebop')!.consecutiveFailures).toBe(2)

    recordSourceNoRoute('bebop', 5)

    const s = statsFor('bebop')!
    expect(s.consecutiveFailures).toBe(2) // streak preserved
    expect(s.failures).toBe(2)
    expect(s.noRoutes).toBe(1)
  })

  it("keeps a present-but-zero output ('Zero output') as a real failure", () => {
    recordSourcePing('odos', false, 10, 'Zero output')
    const s = statsFor('odos')!
    expect(s.failures).toBe(1)
    expect(s.consecutiveFailures).toBe(1)
    expect(s.lastError).toBe('Zero output')
    expect(s.noRoutes).toBe(0)
  })

  it('a real success still counts and resets the failure streak', () => {
    recordSourcePing('velora', false, 10, 'boom')
    recordSourcePing('velora', true, 120)
    const s = statsFor('velora')!
    expect(s.successes).toBe(1)
    expect(s.consecutiveFailures).toBe(0)
  })

  it('successRate excludes no-routes (only success/failure count toward it)', () => {
    recordSourcePing('curve', true, 100)
    recordSourceNoRoute('curve', 5)
    recordSourceNoRoute('curve', 5)
    // 1 success, 0 failures, 2 no-routes → rate is 1.0, not 1/3.
    expect(statsFor('curve')!.successRate).toBe(1)
  })
})
