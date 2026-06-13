// @vitest-environment node
/**
 * [CHORE-POLISH-4 P2] H2 baseline fail-closed contract.
 *
 * H2 (TLS + DNS drift watcher) validates each monitored endpoint against a committed
 * baseline (data/endpoint-baseline.json). The committed file is a PLACEHOLDER
 * ({generatedAt:null, endpoints:{}}) pending a post-Cloudflare-migration capture, so
 * loadBaseline() returns null and the H2 block in monitoring-loop was SILENTLY SKIPPED —
 * H2 validated nothing and still looked healthy (vacuous pass).
 *
 * These tests lock the fail-closed contract: an empty/placeholder baseline is NEVER
 * considered populated/healthy. They are pure (no fs) so they stay green once the operator
 * seeds a real baseline, while still failing if anyone reintroduces the vacuous-pass logic.
 */
import { describe, it, expect } from 'vitest'
import { isBaselinePopulated, evaluateBaselineHealth, classifyBaseline, getBaselineState, resetBaseline } from './fingerprint-validator'

const PLACEHOLDER = { generatedAt: null, endpoints: {} }
const SEEDED = {
  generatedAt: '2026-06-13T00:00:00.000Z',
  endpoints: { '1inch': { hostname: 'api.1inch.dev', critical: true, tls: null, dns: { a: [], aaaa: [], ns: [] } } },
}

describe('H2 baseline fail-closed [CHORE-POLISH-4 P2]', () => {
  it('the committed-placeholder shape is NOT populated (the vacuous-pass guard)', () => {
    expect(isBaselinePopulated(PLACEHOLDER)).toBe(false)
  })

  it('null / undefined baseline is NOT populated', () => {
    expect(isBaselinePopulated(null)).toBe(false)
    expect(isBaselinePopulated(undefined)).toBe(false)
  })

  it('a generatedAt with ZERO endpoints is NOT populated (empty set ≠ validated)', () => {
    expect(isBaselinePopulated({ generatedAt: '2026-06-13T00:00:00.000Z', endpoints: {} })).toBe(false)
  })

  it('a real seeded baseline (timestamp + ≥1 endpoint) IS populated', () => {
    expect(isBaselinePopulated(SEEDED)).toBe(true)
  })

  it('evaluateBaselineHealth reports UNHEALTHY + a seeding reason on the placeholder', () => {
    const status = evaluateBaselineHealth(PLACEHOLDER)
    expect(status.healthy).toBe(false)
    expect(status.reason).toMatch(/baseline/i)
    expect(status.reason).toMatch(/capture/i) // points the operator at the seeding step
  })

  it('evaluateBaselineHealth reports HEALTHY on a seeded baseline', () => {
    expect(evaluateBaselineHealth(SEEDED).healthy).toBe(true)
  })
})

/**
 * [CHORE-HYGIENE-1 A] 3-state H2 baseline classification. Investigation (see FEEDBACK) confirmed
 * the P2 H2-degraded state is already NON-PAGING (informational only). This item is therefore
 * minimal LABELLING: distinguish the intentional placeholder (pending-baseline, EXPECTED) from a
 * genuine fault (missing / unparseable / malformed → degraded, fail-closed), so the known-pending
 * state is never confused with a real fault.
 */
describe('H2 baseline 3-state classification [CHORE-HYGIENE-1 A]', () => {
  it('MISSING file → degraded (genuine fault, fail-closed)', () => {
    expect(classifyBaseline({ exists: false }).state).toBe('degraded')
  })

  it('UNPARSEABLE file → degraded', () => {
    expect(classifyBaseline({ exists: true, parseError: true }).state).toBe('degraded')
  })

  it('MALFORMED (no/invalid endpoints object) → degraded — NOT confused with the placeholder', () => {
    expect(classifyBaseline({ exists: true, raw: { generatedAt: null } }).state).toBe('degraded')
    expect(classifyBaseline({ exists: true, raw: { generatedAt: null, endpoints: [] } }).state).toBe('degraded')
    expect(classifyBaseline({ exists: true, raw: 'not-an-object' }).state).toBe('degraded')
  })

  it('the intentional placeholder (generatedAt:null, endpoints:{}) → pending-baseline (EXPECTED, non-paging)', () => {
    const c = classifyBaseline({ exists: true, raw: { generatedAt: null, endpoints: {} } })
    expect(c.state).toBe('pending-baseline')
    expect(c.reason).toMatch(/placeholder/i)
    expect(c.reason).toMatch(/capture/i) // documents the exit trigger (seed post-migration)
  })

  it('valid structure with a timestamp but 0 endpoints → still pending-baseline (the "and/or")', () => {
    expect(classifyBaseline({ exists: true, raw: { generatedAt: '2026-06-13T00:00:00.000Z', endpoints: {} } }).state).toBe('pending-baseline')
  })

  it('a populated baseline → ok (normal validation runs)', () => {
    expect(classifyBaseline({ exists: true, raw: SEEDED }).state).toBe('ok')
  })

  it('the REAL committed data/endpoint-baseline.json is currently pending-baseline, NOT degraded', () => {
    // The committed file is the placeholder → pending-baseline (informational, non-paging).
    // Flips to 'ok' once the operator seeds it post-Cloudflare-migration.
    resetBaseline()
    expect(getBaselineState().state).toBe('pending-baseline')
  })
})
