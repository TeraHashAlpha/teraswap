/**
 * [P94] Tests for the gasless recommendation engine.
 */

import { describe, it, expect } from 'vitest'
import {
  analyzeGasless,
  GASLESS_MIN_SAVINGS_USD,
  GASLESS_PRICE_THRESHOLD_BPS,
} from './gasless-engine'
import type { NormalizedQuote } from './adapters'
import type { AggregatorName } from './constants'

function q(
  source: AggregatorName,
  toAmount: string,
  gasUsd = 0,
  estimatedGas = 200_000,
): NormalizedQuote {
  return {
    source,
    toAmount,
    estimatedGas: source === 'cowswap' ? 0 : estimatedGas,
    gasUsd: source === 'cowswap' ? 0 : gasUsd,
    routes: [source],
  }
}

describe('analyzeGasless', () => {
  it('flags as unavailable when no CoW quote present', () => {
    const out = analyzeGasless([q('1inch', '1000000'), q('odos', '1000000')], 5)
    expect(out.available).toBe(false)
    expect(out.recommended).toBe(false)
    expect(out.gasSavingsUsd).toBe(0)
  })

  it('recommends when CoW gives the best price', () => {
    // CoW 1010, others 1000 → CoW is outright best.
    const out = analyzeGasless(
      [q('cowswap', '1010'), q('1inch', '1000', 5), q('odos', '995', 6)],
      5,
    )
    expect(out.available).toBe(true)
    expect(out.recommended).toBe(true)
    expect(out.reason.toLowerCase()).toContain('best price')
    expect(out.gasSavingsUsd).toBeGreaterThanOrEqual(GASLESS_MIN_SAVINGS_USD)
    expect(out.bestNonCowSource).toBe('1inch')
  })

  it('recommends when CoW slightly worse but within threshold and gas savings clear the minimum', () => {
    // CoW = 997, best non-CoW = 1000 → 0.3% worse (30 bps, below 50 bps threshold).
    // Gas savings of $5 → recommended.
    const out = analyzeGasless(
      [q('cowswap', '997'), q('1inch', '1000', 5)],
      5,
    )
    expect(out.recommended).toBe(true)
    expect(out.reason).toContain('Save ~$5.00')
    expect(out.priceDifferencePercent).toBeCloseTo(-0.3, 1)
  })

  it('does NOT recommend when CoW is worse beyond the threshold', () => {
    // CoW = 980, best non-CoW = 1000 → 2% worse, well beyond 50 bps.
    const out = analyzeGasless(
      [q('cowswap', '980'), q('1inch', '1000', 5)],
      5,
    )
    expect(out.available).toBe(true)
    expect(out.recommended).toBe(false)
    expect(out.reason).toMatch(/below best route/)
  })

  it('does NOT recommend when gas savings are below $0.50', () => {
    // CoW = 1010 (outright best) but gas estimate is $0.10 → savings noise.
    const out = analyzeGasless(
      [q('cowswap', '1010'), q('1inch', '1000', 0.1)],
      0.1,
    )
    expect(out.available).toBe(true)
    // Still recommended because CoW is the outright best, but the reason
    // shouldn't promise dollar savings.
    expect(out.recommended).toBe(true)
    expect(out.reason).not.toMatch(/\$\d+\.\d{2}/)
  })

  it('respects the threshold constant boundary', () => {
    // Exactly at 50 bps — diff = 0.5% with $1 gas savings → within threshold.
    const out = analyzeGasless(
      [q('cowswap', '995'), q('1inch', '1000', 1)],
      1,
    )
    expect(GASLESS_PRICE_THRESHOLD_BPS).toBe(50)
    expect(out.recommended).toBe(true)
  })

  it('handles CoW as the only available quote', () => {
    const out = analyzeGasless([q('cowswap', '1000')], 0)
    expect(out.available).toBe(true)
    expect(out.recommended).toBe(true)
    expect(out.reason).toMatch(/only/i)
  })

  it('returns invalid output reason when CoW toAmount is malformed', () => {
    const out = analyzeGasless([q('cowswap', 'NaN'), q('1inch', '1000')], 5)
    expect(out.available).toBe(false)
  })

  it('falls back to adapter gasUsd when caller estimate is missing', () => {
    // estimatedGasUsd = 0 but best non-CoW has gasUsd = 4
    const out = analyzeGasless(
      [q('cowswap', '1010'), q('1inch', '1000', 4)],
      0,
    )
    expect(out.recommended).toBe(true)
    expect(out.gasSavingsUsd).toBe(4)
  })
})
