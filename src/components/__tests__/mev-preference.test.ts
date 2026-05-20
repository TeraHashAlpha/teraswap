/**
 * [P140] Regression coverage for src/lib/mev-preference.ts.
 *
 * The bug behind P138 was that CoW could be promoted into best whenever
 * the price shortfall was within 30 bps, even when the gasless engine
 * said the user nets out negative. These tests pin the new contract:
 *
 *   - promotion requires shortfall ≤ threshold AND gasless.recommended
 *   - threshold itself defaults to 15 bps (callers pass it explicitly)
 *
 * Plus the previously-implicit behaviours: forced MEV filter, the
 * already-best-is-CoW path, and the no-CoW-available fallback.
 */
import { describe, it, expect } from 'vitest'
import { selectBestWithMevPreference } from '@/lib/mev-preference'
import { AGGREGATOR_META, MEV_PREFERENCE_THRESHOLD } from '@/lib/constants'
import type { MetaQuoteResult, NormalizedQuote } from '@/lib/api'

// ── Helpers ──────────────────────────────────────────────

function quote(source: NormalizedQuote['source'], toAmount: string): NormalizedQuote {
  return {
    source,
    toAmount,
    estimatedGas: 100_000,
    gasUsd: 5,
    routes: [],
  }
}

function meta(
  best: NormalizedQuote,
  rest: NormalizedQuote[],
  gasless?: { recommended: boolean; available?: boolean },
): MetaQuoteResult {
  const result: MetaQuoteResult = {
    best,
    all: [best, ...rest.filter(q => q.source !== best.source)],
    fetchedAt: Date.now(),
  }
  if (gasless) {
    result.gasless = {
      available: gasless.available ?? true,
      recommended: gasless.recommended,
      reason: '',
      gasSavingsUsd: 7.5,
      priceDifferencePercent: 0,
      bestNonCowSource: '1inch',
    }
  }
  return result
}

// bestAmount = 10_000n makes shortfallBps = 10_000 - cowAmount, so a CoW
// amount of 9_985n is exactly 15 bps short. Easy to reason about boundaries.
const BEST_AMOUNT = '10000'
const COW_15_BPS = '9985'   // exactly at threshold
const COW_14_BPS = '9986'   // 1 bp under threshold
const COW_16_BPS = '9984'   // 1 bp over threshold

// ── Path 2: smart preference (mevProtected=false) ────────

describe('selectBestWithMevPreference — smart promotion gating', () => {
  it('promotes CoW when within 15 bps AND gasless.recommended=true', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const cow = quote('cowswap', COW_15_BPS)
    const result = selectBestWithMevPreference(
      meta(oneInch, [cow], { recommended: true }),
      false,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.smartMevApplied).toBe(true)
    expect(result.meta?.best.source).toBe('cowswap')
    expect(result.mevExposedBest).toBe(false)
  })

  it('does NOT promote CoW when within 15 bps but gasless.recommended=false', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const cow = quote('cowswap', COW_15_BPS)
    const result = selectBestWithMevPreference(
      meta(oneInch, [cow], { recommended: false }),
      false,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.smartMevApplied).toBe(false)
    expect(result.meta?.best.source).toBe('1inch')
    expect(result.mevExposedBest).toBe(true)
  })

  it('does NOT promote CoW when beyond 15 bps even if gasless.recommended=true', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const cow = quote('cowswap', COW_16_BPS)
    const result = selectBestWithMevPreference(
      meta(oneInch, [cow], { recommended: true }),
      false,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.smartMevApplied).toBe(false)
    expect(result.meta?.best.source).toBe('1inch')
    expect(result.mevExposedBest).toBe(true)
  })

  it('does NOT promote CoW when beyond 15 bps AND gasless.recommended=false', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const cow = quote('cowswap', COW_16_BPS)
    const result = selectBestWithMevPreference(
      meta(oneInch, [cow], { recommended: false }),
      false,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.smartMevApplied).toBe(false)
    expect(result.meta?.best.source).toBe('1inch')
    expect(result.mevExposedBest).toBe(true)
  })

  it('does NOT promote CoW when gasless overlay is absent', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const cow = quote('cowswap', COW_15_BPS)
    const result = selectBestWithMevPreference(
      meta(oneInch, [cow] /* no gasless */),
      false,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.smartMevApplied).toBe(false)
    expect(result.meta?.best.source).toBe('1inch')
    expect(result.mevExposedBest).toBe(true)
  })
})

// ── Boundary conditions ──────────────────────────────────

describe('selectBestWithMevPreference — boundary conditions', () => {
  it('promotes at exactly 15 bps shortfall (≤ threshold, not <)', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const cow = quote('cowswap', COW_15_BPS)
    const result = selectBestWithMevPreference(
      meta(oneInch, [cow], { recommended: true }),
      false,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.smartMevApplied).toBe(true)
    expect(result.meta?.best.source).toBe('cowswap')
  })

  it('promotes at 14 bps (1 bp inside threshold)', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const cow = quote('cowswap', COW_14_BPS)
    const result = selectBestWithMevPreference(
      meta(oneInch, [cow], { recommended: true }),
      false,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.smartMevApplied).toBe(true)
    expect(result.meta?.best.source).toBe('cowswap')
  })

  it('does NOT promote at 16 bps (1 bp over threshold)', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const cow = quote('cowswap', COW_16_BPS)
    const result = selectBestWithMevPreference(
      meta(oneInch, [cow], { recommended: true }),
      false,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.smartMevApplied).toBe(false)
    expect(result.meta?.best.source).toBe('1inch')
  })
})

// ── Already-best paths ───────────────────────────────────

describe('selectBestWithMevPreference — already-best paths', () => {
  it('keeps CoW as best (no promotion needed) when it has 0 bps shortfall', () => {
    const cow = quote('cowswap', BEST_AMOUNT)
    const oneInch = quote('1inch', BEST_AMOUNT)
    const result = selectBestWithMevPreference(
      // cow is already best — bestIsMevProtected short-circuit
      meta(cow, [oneInch], { recommended: false }),
      false,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    // smartMevApplied=false because no promotion happened — best was
    // already MEV-protected. The key guarantee: meta.best stays as CoW
    // regardless of gasless.recommended.
    expect(result.smartMevApplied).toBe(false)
    expect(result.mevExposedBest).toBe(false)
    expect(result.meta?.best.source).toBe('cowswap')
  })

  it('falls through to MEV-exposed when no CoW quote is in the set', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const odos = quote('odos', '9990')
    const result = selectBestWithMevPreference(
      meta(oneInch, [odos], { recommended: false }),
      false,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.smartMevApplied).toBe(false)
    expect(result.mevExposedBest).toBe(true)
    expect(result.meta?.best.source).toBe('1inch')
  })
})

// ── Path 1: forced MEV filter ────────────────────────────

describe('selectBestWithMevPreference — forced MEV filter', () => {
  it('with mevProtected=true: returns only MEV-protected sources', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const cow = quote('cowswap', COW_16_BPS)
    const result = selectBestWithMevPreference(
      meta(oneInch, [cow], { recommended: true }),
      true, // force toggle
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.smartMevApplied).toBe(false) // user forced, not smart
    expect(result.meta?.best.source).toBe('cowswap')
    expect(result.meta?.all.every(q => AGGREGATOR_META[q.source]?.mevProtected)).toBe(true)
  })

  it('with mevProtected=true and no CoW available: returns meta=null', () => {
    const oneInch = quote('1inch', BEST_AMOUNT)
    const odos = quote('odos', '9990')
    const result = selectBestWithMevPreference(
      meta(oneInch, [odos], { recommended: false }),
      true,
      AGGREGATOR_META,
      MEV_PREFERENCE_THRESHOLD,
    )
    expect(result.meta).toBeNull()
    expect(result.smartMevApplied).toBe(false)
    expect(result.mevExposedBest).toBe(false)
  })
})

// ── Null input ───────────────────────────────────────────

describe('selectBestWithMevPreference — null input', () => {
  it('returns null meta with both flags false when rawMeta is null', () => {
    const result = selectBestWithMevPreference(null, false, AGGREGATOR_META, MEV_PREFERENCE_THRESHOLD)
    expect(result.meta).toBeNull()
    expect(result.smartMevApplied).toBe(false)
    expect(result.mevExposedBest).toBe(false)
  })
})
