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
import {
  deriveMinimumOutput,
  UnusableQuoteError,
  assertSwapConsistentWithQuote,
  StaleOrTamperedSwapError,
  SWAP_QUOTE_TOLERANCE_BPS,
} from './minimum-output'
import { AGGREGATOR_META, type AggregatorName } from './constants'

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

/**
 * [fix/swap-toamount-lower-bound-vs-quote — Architect ruling on #524
 * Auditor H-01] assertSwapConsistentWithQuote — the FLOOR counterpart to
 * api.ts's validateFeeIntegrity (a CEILING check, +2%, FEE_NATIVE_SOURCES
 * only). Pins the exact formula:
 *
 *   floor ⟺ quoteToAmount * (10000 - slippageBps - TOLERANCE_BPS) / 10000
 *   throws StaleOrTamperedSwapError ⟺ swapToAmount < floor
 *
 * TOLERANCE_BPS = 50 (0.5%) absorbs quote age (the gap between /price and
 * /swap) and ordinary routing drift, calibrated the same way as the ceiling
 * side's 2% tolerance but far tighter because this is a floor: a legitimate
 * swap should track its own quote closely, while the ceiling has to
 * tolerate an aggregator output landing anywhere up to a real price move.
 */
const NON_SKIP_SOURCE: AggregatorName = '1inch'

function callAssert(
  quoteToAmount: unknown,
  swapToAmount: unknown,
  slippagePercent: number,
  // `null` = the source-agnostic aggregate (a split's total) — never skipped.
  source: AggregatorName | null = NON_SKIP_SOURCE,
) {
  assertSwapConsistentWithQuote({ quoteToAmount, swapToAmount, slippagePercent, source })
}

describe('assertSwapConsistentWithQuote — TOLERANCE_BPS is the pinned constant', () => {
  it('is 50 bps (0.5%)', () => {
    expect(SWAP_QUOTE_TOLERANCE_BPS).toBe(50)
  })
})

describe('assertSwapConsistentWithQuote — boundary, exact bps arithmetic', () => {
  const QUOTED = '1000000' // clean divisor for 10_000 bps arithmetic

  it('0% slippage: floor = quote * 9950/10000 — AT the floor passes', () => {
    expect(() => callAssert(QUOTED, '995000', 0)).not.toThrow()
  })

  it('0% slippage: 1 wei BELOW the floor throws StaleOrTamperedSwapError', () => {
    expect(() => callAssert(QUOTED, '994999', 0)).toThrow(StaleOrTamperedSwapError)
  })

  it('5% slippage: floor = quote * 9450/10000 — AT the floor passes', () => {
    expect(() => callAssert(QUOTED, '945000', 5)).not.toThrow()
  })

  it('5% slippage: 1 wei BELOW the floor throws', () => {
    expect(() => callAssert(QUOTED, '944999', 5)).toThrow(StaleOrTamperedSwapError)
  })

  it('49.99% slippage: floor = quote * 4951/10000 — AT the floor passes', () => {
    expect(() => callAssert(QUOTED, '495100', 49.99)).not.toThrow()
  })

  it('49.99% slippage: 1 wei BELOW the floor throws', () => {
    expect(() => callAssert(QUOTED, '495099', 49.99)).toThrow(StaleOrTamperedSwapError)
  })

  it('one wei ABOVE the floor always passes (only < floor throws, not <=)', () => {
    expect(() => callAssert(QUOTED, '995001', 0)).not.toThrow()
  })

  it('an identical quote/swap amount always passes, at any slippage', () => {
    expect(() => callAssert(QUOTED, QUOTED, 0)).not.toThrow()
    expect(() => callAssert(QUOTED, QUOTED, 49.99)).not.toThrow()
  })

  it('the thrown error carries the deviation percent and the specified copy', () => {
    try {
      callAssert(QUOTED, '500000', 0) // 50% below quote, well past the 0.5% floor
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StaleOrTamperedSwapError)
      const e = err as StaleOrTamperedSwapError
      expect(e.name).toBe('StaleOrTamperedSwapError')
      expect(e.deviationPercent).toBeCloseTo(50, 1)
      expect(e.message).toContain('below the quote you accepted')
      expect(e.message).toContain('50.0%')
      expect(e.message).toMatch(/route was refreshed.*review and try again/i)
    }
  })
})
describe('assertSwapConsistentWithQuote — skip list is uniswapv3 ONLY [Auditor M-01/M-02]', () => {
  // The list no longer mirrors validateFeeIntegrity's. 'cowswap' was dropped
  // as a dead exemption (M-01): execute() dispatches it to executeCowSwap
  // before executeStandardSwap (useSwap.ts:1058-1059) and
  // SPLIT_ELIGIBLE_SOURCES excludes it (split-routing-types.ts:96), so it can
  // never reach this function. 'curve' was dropped because its reason did not
  // hold (M-02): quote and build resolve the SAME statically mapped pool and
  // both read get_dy on it (curve.ts:172 / :234), so its divergence is
  // ordinary market drift. 'uniswapv3' stays on a structural reason: the
  // build RE-DETECTS the fee tier (uniswapv3.ts:247-271), so quote and swap
  // can be measuring two different pools.
  const SKIP_SOURCES: AggregatorName[] = ['uniswapv3']

  it.each(SKIP_SOURCES)('%s bypasses the floor entirely — even a near-zero output passes', (source) => {
    expect(() => callAssert('1000000', '1', 0, source)).not.toThrow()
  })

  it.each(['curve', 'cowswap'] as AggregatorName[])(
    '%s is NO LONGER exempt — a halved swap output blocks',
    (source) => {
      expect(() => callAssert('1000000', '500000', 0.5, source)).toThrow(StaleOrTamperedSwapError)
    },
  )

  it('every OTHER registered source in AGGREGATOR_META IS checked (positive control)', () => {
    for (const source of Object.keys(AGGREGATOR_META) as AggregatorName[]) {
      if (SKIP_SOURCES.includes(source)) continue
      // Identical quote/swap output: never a false positive for any checked source.
      expect(() => callAssert('1000000', '1000000', 0.5, source)).not.toThrow()
      // Tampered to half the quote: every checked source blocks it.
      expect(() => callAssert('1000000', '500000', 0.5, source)).toThrow(StaleOrTamperedSwapError)
    }
  })

  it('the split AGGREGATE (source: null) is never skip-listed', () => {
    expect(() => callAssert('1000000', '500000', 0.5, null)).toThrow(StaleOrTamperedSwapError)
    expect(() => callAssert('1000000', '1000000', 0.5, null)).not.toThrow()
  })
})

const malformedAmounts: Array<[string, unknown]> = [
  ['non-numeric string', 'not-a-number'],
  ['empty string', ''],
  ['undefined', undefined],
  ['null', null],
  ['decimal string', '1.5'],
  ['negative', '-5'],
]

describe('assertSwapConsistentWithQuote — a missing ACCEPTED QUOTE fails closed [Auditor H-01]', () => {
  it.each(malformedAmounts)(
    'quoteToAmount = %s → throws StaleOrTamperedSwapError (nothing to compare against)',
    (_label, bad) => {
      expect(() => callAssert(bad, '1000000', 0.5)).toThrow(StaleOrTamperedSwapError)
    },
  )

  it('zero quoteToAmount → refused (never a 0-based floor every output clears)', () => {
    expect(() => callAssert('0', '1000000', 0.5)).toThrow(StaleOrTamperedSwapError)
  })

  it('the refusal carries deviationPercent null and names the missing quote', () => {
    try {
      callAssert(undefined, '1000000', 0.5)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StaleOrTamperedSwapError)
      const e = err as StaleOrTamperedSwapError
      expect(e.deviationPercent).toBeNull()
      expect(e.message).toMatch(/no accepted quote to compare/i)
      expect(e.message).not.toContain('NaN') // never formats a null deviation
    }
  })
})

describe('assertSwapConsistentWithQuote — an unusable SWAP amount throws UnusableQuoteError, as deriveMinimumOutput does', () => {
  it.each(malformedAmounts)('swapToAmount = %s → throws UnusableQuoteError', (_label, bad) => {
    expect(() => callAssert('1000000', bad, 0.5)).toThrow(UnusableQuoteError)
  })

  it('[Auditor L] the diagnostic carries the SWAP amount that failed to parse', () => {
    try {
      callAssert('1000000', 'not-a-number', 0.5)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UnusableQuoteError)
      expect((err as UnusableQuoteError).rawToAmount).toBe('not-a-number')
    }
  })

  it('a malformed input on a SKIP-listed source still bypasses (skip check runs first)', () => {
    expect(() => callAssert('not-a-number', 'also-not-a-number', 0.5, 'uniswapv3')).not.toThrow()
  })
})
