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
import { isBaselinePopulated, evaluateBaselineHealth } from './fingerprint-validator'

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
