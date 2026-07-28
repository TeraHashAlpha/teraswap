/**
 * [SPRINT-9W-oracle] Unit tests for the cbETH depeg circuit-breaker verdict + the per-leg round
 * validator. The thresholds (2% consent / 10% block) and the fail-CLOSED behaviour are the security
 * core. [FIX-ORACLE-FAIL-CLOSED] "fail-open" in the original version of this header was the bug.
 */
import { describe, it, expect } from 'vitest'
import { evaluateDepeg, priceFromValidRound, hasReadFailed, PENDING, UNVERIFIED } from './depeg-gate'
import { DEPEG_DIVERGENCE_WARN, DEPEG_DIVERGENCE_BLOCK, DEPEG_CONSENT_TOLERANCE } from './constants'

describe('evaluateDepeg [SPRINT-9W-oracle]', () => {
  it('market ≈ ER (0.3%) → no friction (ok)', () => {
    const r = evaluateDepeg(1.003, 1.0, 'cbETH')
    expect(r.mode).toBe('ok')
    expect(r.divergence).toBeCloseTo(0.003, 6)
    expect(r.message).toBeNull()
  })

  it('market 5% off ER → consent, with the exact spec copy', () => {
    const r = evaluateDepeg(1.05, 1.0, 'cbETH')
    expect(r.mode).toBe('consent')
    expect(r.divergence).toBeCloseTo(0.05, 6)
    expect(r.message).toContain('off its exchange rate')
    expect(r.message).toContain('possible depeg')
    expect(r.message).toContain('5.0%')
  })

  it('market 12% off ER → hard block (no click-through verdict)', () => {
    const r = evaluateDepeg(1.12, 1.0, 'cbETH')
    expect(r.mode).toBe('block')
    expect(r.divergence).toBeCloseTo(0.12, 6)
    expect(r.message).toContain('Swap blocked')
  })

  it('is SYMMETRIC — cbETH cheap (market < ER) trips the same as expensive', () => {
    expect(evaluateDepeg(0.95, 1.0, 'cbETH').mode).toBe('consent') // 5% discount
    expect(evaluateDepeg(0.88, 1.0, 'cbETH').mode).toBe('block')   // 12% discount
    // identical divergence whichever side is larger
    expect(evaluateDepeg(0.95, 1.0, 'cbETH').divergence).toBeCloseTo(evaluateDepeg(1.05, 1.0, 'cbETH').divergence, 6)
  })

  it('threshold boundaries: exactly WARN → consent, exactly BLOCK → block, just under WARN → ok', () => {
    expect(evaluateDepeg(1 + DEPEG_DIVERGENCE_WARN, 1.0, 'cbETH').mode).toBe('consent')   // == 2%
    expect(evaluateDepeg(1 + DEPEG_DIVERGENCE_BLOCK, 1.0, 'cbETH').mode).toBe('block')     // == 10%
    expect(evaluateDepeg(1 + DEPEG_DIVERGENCE_WARN - 0.0001, 1.0, 'cbETH').mode).toBe('ok') // 1.99%
    expect(evaluateDepeg(1 + DEPEG_DIVERGENCE_BLOCK - 0.0001, 1.0, 'cbETH').mode).toBe('consent') // 9.99%
  })

  // [FIX-ORACLE-FAIL-CLOSED] This test previously asserted the OPPOSITE — that a null/non-positive
  // leg returned 'ok'. That was the fail-open hole: a feed outage silently passed the swap through
  // as though the peg had been verified. It is retained (not deleted) and inverted, because the old
  // contract is exactly what must never come back.
  it('FAIL-CLOSED: a null / non-positive leg → unverified (we could not check → block, do not pass)', () => {
    expect(evaluateDepeg(null, 1.0, 'cbETH').mode).toBe('unverified')
    expect(evaluateDepeg(1.0, null, 'cbETH').mode).toBe('unverified')
    expect(evaluateDepeg(0, 1.0, 'cbETH').mode).toBe('unverified')
    expect(evaluateDepeg(1.0, 0, 'cbETH').mode).toBe('unverified')
    expect(evaluateDepeg(-1, 1.0, 'cbETH').mode).toBe('unverified')
  })

  it('unverified copy says we could not CHECK — never that the asset is depegged', () => {
    const r = evaluateDepeg(null, 1.0, 'cbETH')
    expect(r.message).toContain("couldn't verify")
    expect(r.message).toContain('cbETH')
    expect(r.message).not.toMatch(/depeg/i)
    expect(r.message).not.toMatch(/manipulation/i)
    // No divergence was measured, so none is claimed.
    expect(r.divergence).toBe(0)
  })

  it('unverified without a symbol (unresolved chain) still reads as a retry, not a verdict', () => {
    const r = UNVERIFIED('')
    expect(r.mode).toBe('unverified')
    expect(r.message).toContain("couldn't verify")
    expect(r.message).not.toMatch(/depeg/i)
  })

  it('PENDING is frictionless and distinct from UNVERIFIED — an in-flight read is not a failure', () => {
    const p = PENDING('cbETH')
    expect(p.mode).toBe('pending')
    expect(p.message).toBeNull()          // nothing scary on a first render
    expect(p.mode).not.toBe('unverified') // and never conflated with a real failure
  })

  it('tolerance constant exists for the consent auto-revoke (used by SwapBox)', () => {
    expect(DEPEG_CONSENT_TOLERANCE).toBe(0.005)
  })
})

// [FIX-DEPEG-RETRY-WINDOW / M-01] The failure memory that decides whether an in-flight read may be
// treated as a frictionless first render. Unit-tested here, away from React, because it is the whole
// substance of the M-01 fix: `failureCount` alone is resettable by the library and let the gate
// re-open once per 30s poll.
describe('hasReadFailed [FIX-DEPEG-RETRY-WINDOW / M-01]', () => {
  it('a read with no failure history has not failed (first-ever load stays frictionless)', () => {
    expect(hasReadFailed({})).toBe(false)
    expect(hasReadFailed({ failureCount: 0, errorUpdateCount: 0 })).toBe(false)
    expect(hasReadFailed({ failureCount: undefined, errorUpdateCount: undefined })).toBe(false)
  })

  it('mid-retry (failureCount > 0, no error committed yet) counts as failed', () => {
    // The first retry sequence: query-core increments fetchFailureCount but has not dispatched
    // 'error', so errorUpdateCount is still 0. failureCount is the ONLY signal in this window.
    expect(hasReadFailed({ failureCount: 2, errorUpdateCount: 0 })).toBe(true)
  })

  it('THE M-01 CASE: post-error refetch (failureCount reset to 0) still counts as failed', () => {
    // query-core's `fetchState` resets fetchFailureCount to 0 on every new fetch and — when
    // data === undefined — also rewinds error/status. errorUpdateCount is the only survivor, and
    // relying on failureCount alone is exactly what re-opened the gate every 30s.
    expect(hasReadFailed({ failureCount: 0, errorUpdateCount: 1 })).toBe(true)
    expect(hasReadFailed({ failureCount: 0, errorUpdateCount: 7 })).toBe(true)
  })

  it('is monotonic in practice — a later successful FETCH does not clear the error history', () => {
    // errorUpdateCount is never decremented by query-core (only ++ on the 'error' action), so the
    // predicate stays true. Recovery is signalled by DATA arriving, never by this going false.
    expect(hasReadFailed({ failureCount: 0, errorUpdateCount: 3 })).toBe(true)
  })
})

describe('priceFromValidRound [SPRINT-9W-oracle] — per-leg integrity + 9V staleness', () => {
  const now = 1_780_000_000
  const fresh = BigInt(now - 3_600)            // 1h old
  // [roundId, answer, startedAt, updatedAt, answeredInRound]
  const valid: readonly [bigint, bigint, bigint, bigint, bigint] = [10n, 1_134_400_000_000_000_000n, fresh, fresh, 10n]

  it('a valid 18-dp round → decimal-normalised price', () => {
    expect(priceFromValidRound(valid, 18, 129_600, now)).toBeCloseTo(1.1344, 6)
  })

  it('decimals applied per-leg (8-dp feed)', () => {
    const r8: readonly [bigint, bigint, bigint, bigint, bigint] = [10n, 190_686_000_000n, fresh, fresh, 10n]
    expect(priceFromValidRound(r8, 8, 129_600, now)).toBeCloseTo(1906.86, 2)
  })

  it('rejects answer<=0, incomplete round, startedAt=0, and stale (each → null)', () => {
    expect(priceFromValidRound([10n, 0n, fresh, fresh, 10n], 18, 129_600, now)).toBeNull()            // answer 0
    expect(priceFromValidRound([10n, -5n, fresh, fresh, 10n], 18, 129_600, now)).toBeNull()           // answer < 0
    expect(priceFromValidRound([10n, valid[1], fresh, fresh, 9n], 18, 129_600, now)).toBeNull()       // answeredInRound < roundId
    expect(priceFromValidRound([10n, valid[1], 0n, fresh, 10n], 18, 129_600, now)).toBeNull()         // startedAt 0
    const stale = BigInt(now - 130_000)
    expect(priceFromValidRound([10n, valid[1], stale, stale, 10n], 18, 129_600, now)).toBeNull()      // age > staleness
  })

  it('accepts a round exactly at the staleness boundary; rejects 1s past', () => {
    const atBoundary = BigInt(now - 129_600)
    expect(priceFromValidRound([10n, valid[1], atBoundary, atBoundary, 10n], 18, 129_600, now)).not.toBeNull()
    const justPast = BigInt(now - 129_601)
    expect(priceFromValidRound([10n, valid[1], justPast, justPast, 10n], 18, 129_600, now)).toBeNull()
  })

  it('undefined round / decimals → null (feed not yet loaded)', () => {
    expect(priceFromValidRound(undefined, 18, 129_600, now)).toBeNull()
    expect(priceFromValidRound(valid, undefined, 129_600, now)).toBeNull()
  })
})
