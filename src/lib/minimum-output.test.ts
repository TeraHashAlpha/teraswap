/**
 * [AUDIT-W2 / W2-L-01] deriveMinimumOutput — the FeeCollector minimumOutput
 * floor derivation shared by useSwap, useSplitSwap and buildSimulationTx.
 *
 * Pins the W2-L-01 remediation: an unusable quote toAmount (malformed / zero /
 * unparseable / negative) THROWS UnusableQuoteError — refusing the swap —
 * instead of the old 10-L-01 fallback to minimumOutput = 0n, which silently
 * disabled the deployed FeeCollector's on-chain InsufficientOutput check
 * (mainnet 0x47f2…7459 / Base 0xeFC3…f130 — see docs/security/DEPLOYED-SOURCES.md).
 *
 * Gated in CI by the minimum-output-guard job (the full vitest suite does not
 * run in CI — single-file guards only).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { deriveMinimumOutput, UnusableQuoteError } from './minimum-output'

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  // safeBigInt logs a diagnostic warn on malformed input — keep test output clean.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warnSpy.mockRestore())

describe('deriveMinimumOutput — valid quotes keep a real floor (unchanged behaviour)', () => {
  it('1% slippage → toAmount * 9900 / 10000', () => {
    expect(deriveMinimumOutput('1000000', 1)).toBe(990_000n)
  })

  it('0.5% slippage → toAmount * 9950 / 10000', () => {
    expect(deriveMinimumOutput('1000000000', 0.5)).toBe(995_000_000n)
  })

  it('0% slippage → toAmount unchanged', () => {
    expect(deriveMinimumOutput('1000000', 0)).toBe(1_000_000n)
  })

  it('negative slippage is clamped to 0 (Math.max guard)', () => {
    expect(deriveMinimumOutput('1000000', -0.5)).toBe(1_000_000n)
  })

  it('99.99% slippage → floor of 1/10000 of toAmount (NOT zero)', () => {
    expect(deriveMinimumOutput('1000000', 99.99)).toBe(100n)
  })

  it('slippage >= 100% with a VALID toAmount → 0n (explicit user setting, not a malformed quote)', () => {
    expect(deriveMinimumOutput('1000000', 100)).toBe(0n)
  })
})

describe('deriveMinimumOutput — unusable quotes REFUSE the swap [W2-L-01]', () => {
  const cases: Array<[string, unknown]> = [
    ['non-numeric string', 'not-a-number'],
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['decimal string', '1.5'],
    ['hex-ish junk', '0xdeadbeef'],
    ['zero', '0'],
    ['negative', '-5'],
  ]

  it.each(cases)('toAmount = %s → throws UnusableQuoteError (never minimumOutput 0n)', (_label, toAmount) => {
    expect(() => deriveMinimumOutput(toAmount, 0.5)).toThrow(UnusableQuoteError)
  })

  it('the error is a clear refusal, not a formatting crash', () => {
    try {
      deriveMinimumOutput('not-a-number', 0.5)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UnusableQuoteError)
      const e = err as UnusableQuoteError
      expect(e.name).toBe('UnusableQuoteError')
      expect(e.message).toMatch(/unusable quote/i)
      expect(e.message).toMatch(/refused/i)
      expect(e.rawToAmount).toBe('not-a-number')
    }
  })

  it('zero toAmount refuses even at 0% slippage (a 0-output quote is never executable)', () => {
    expect(() => deriveMinimumOutput('0', 0)).toThrow(UnusableQuoteError)
  })
})
