/**
 * [SPRINT-9W-oracle] Unit tests for the cbETH depeg circuit-breaker verdict + the per-leg round
 * validator. The thresholds (2% consent / 10% block) and fail-open behaviour are the security core.
 */
import { describe, it, expect } from 'vitest'
import { evaluateDepeg, priceFromValidRound } from './depeg-gate'
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

  it('FAIL-OPEN: a null / non-positive leg → ok (a feed outage is NOT a depeg → no false block)', () => {
    expect(evaluateDepeg(null, 1.0, 'cbETH').mode).toBe('ok')
    expect(evaluateDepeg(1.0, null, 'cbETH').mode).toBe('ok')
    expect(evaluateDepeg(0, 1.0, 'cbETH').mode).toBe('ok')
    expect(evaluateDepeg(1.0, 0, 'cbETH').mode).toBe('ok')
    expect(evaluateDepeg(-1, 1.0, 'cbETH').mode).toBe('ok')
  })

  it('tolerance constant exists for the consent auto-revoke (used by SwapBox)', () => {
    expect(DEPEG_CONSENT_TOLERANCE).toBe(0.005)
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
