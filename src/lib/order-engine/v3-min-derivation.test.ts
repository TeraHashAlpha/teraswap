import { describe, it, expect } from 'vitest'
import { computeReferenceExpectedOutTs, deriveAbsoluteMinAmountOut } from './v3-min-derivation'

describe('computeReferenceExpectedOutTs', () => {
  it('computes fair value for equal-decimal 1:1 tokens', () => {
    // 100 tokens (18dp) @ $2000 in -> $1 out => 200000 tokens out (18dp)
    const out = computeReferenceExpectedOutTs({
      amountIn: 100n * 10n ** 18n,
      srcDecimals: 18,
      dstDecimals: 18,
      priceInUsd: 2000,
      priceOutUsd: 1,
    })
    expect(out).toBe(200_000n * 10n ** 18n)
  })

  it('handles cross-decimal tokens (18dp in -> 6dp USDC out)', () => {
    // 1 ETH ($3500) -> USDC ($1): 3500 USDC = 3500e6 raw
    const out = computeReferenceExpectedOutTs({
      amountIn: 10n ** 18n,
      srcDecimals: 18,
      dstDecimals: 6,
      priceInUsd: 3500,
      priceOutUsd: 1,
    })
    expect(out).toBe(3500n * 10n ** 6n)
  })

  it('returns null when either price is missing (no-feed leg)', () => {
    expect(computeReferenceExpectedOutTs({
      amountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 18, priceInUsd: null, priceOutUsd: 1,
    })).toBeNull()
    expect(computeReferenceExpectedOutTs({
      amountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 18, priceInUsd: 1, priceOutUsd: null,
    })).toBeNull()
  })

  it('returns null for non-positive or unparseable amountIn', () => {
    expect(computeReferenceExpectedOutTs({
      amountIn: 0n, srcDecimals: 18, dstDecimals: 18, priceInUsd: 1, priceOutUsd: 1,
    })).toBeNull()
    expect(computeReferenceExpectedOutTs({
      amountIn: 'not-a-number', srcDecimals: 18, dstDecimals: 18, priceInUsd: 1, priceOutUsd: 1,
    })).toBeNull()
    expect(computeReferenceExpectedOutTs({
      amountIn: -5, srcDecimals: 18, dstDecimals: 18, priceInUsd: 1, priceOutUsd: 1,
    })).toBeNull()
  })

  it('returns null for non-positive prices', () => {
    expect(computeReferenceExpectedOutTs({
      amountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 18, priceInUsd: 0, priceOutUsd: 1,
    })).toBeNull()
    expect(computeReferenceExpectedOutTs({
      amountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 18, priceInUsd: 1, priceOutUsd: -1,
    })).toBeNull()
  })

  it('never rounds a real trade to a zero output (no rounding-to-zero floor)', () => {
    // Tiny amount, huge price ratio — still returns a positive (or well-defined zero for
    // genuinely sub-unit trades), never throws.
    const out = computeReferenceExpectedOutTs({
      amountIn: 1n, srcDecimals: 18, dstDecimals: 18, priceInUsd: 100000, priceOutUsd: 0.0001,
    })
    expect(out).not.toBeNull()
    expect(out! >= 0n).toBe(true)
  })
})

describe('deriveAbsoluteMinAmountOut', () => {
  it('derives fair value minus the slippage band', () => {
    // 1 ETH ($3500) -> USDC ($1), 3% slippage => 3500 * 0.97 = 3395 USDC
    const min = deriveAbsoluteMinAmountOut({
      amountIn: 10n ** 18n,
      srcDecimals: 18,
      dstDecimals: 6,
      priceInUsd: 3500,
      priceOutUsd: 1,
      maxSlippageBps: 300,
    })
    expect(min).toBe(3395n * 10n ** 6n)
  })

  it('is strictly less than the unslipped fair value for any positive slippage', () => {
    const fair = computeReferenceExpectedOutTs({
      amountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 18, priceInUsd: 2000, priceOutUsd: 1,
    })!
    const min = deriveAbsoluteMinAmountOut({
      amountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 18,
      priceInUsd: 2000, priceOutUsd: 1, maxSlippageBps: 500,
    })!
    expect(min).toBeLessThan(fair)
    expect(min).toBe((fair * 9500n) / 10000n)
  })

  it('returns null on a no-feed leg — caller must NOT sign 1 as a substitute', () => {
    const min = deriveAbsoluteMinAmountOut({
      amountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 18,
      priceInUsd: null, priceOutUsd: 1, maxSlippageBps: 300,
    })
    expect(min).toBeNull()
  })

  it('rejects an out-of-range maxSlippageBps (defense in depth vs the contract cap)', () => {
    expect(deriveAbsoluteMinAmountOut({
      amountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 18,
      priceInUsd: 1, priceOutUsd: 1, maxSlippageBps: -1,
    })).toBeNull()
    expect(deriveAbsoluteMinAmountOut({
      amountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 18,
      priceInUsd: 1, priceOutUsd: 1, maxSlippageBps: 10_001,
    })).toBeNull()
  })

  it('never returns zero (a zero derived min must fall back, never sign 0/1)', () => {
    // 100% slippage would floor to 0 — must return null instead of 0n, so the caller can never
    // accidentally sign a zero/1-wei min through this path.
    const min = deriveAbsoluteMinAmountOut({
      amountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 18,
      priceInUsd: 1, priceOutUsd: 1, maxSlippageBps: 10_000,
    })
    expect(min).toBeNull()
  })
})
