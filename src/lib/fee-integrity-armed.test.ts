// @vitest-environment node
/**
 * [fix/zerox-partner-fee-armed] Is it SAFE to arm the M-01 fee-integrity check
 * for the sources that really do collect a native partner fee?
 *
 * Arming a guard that has never run on a live money path is the risk in this
 * change, so the answer has to be measured, not assumed. These tests pin the
 * validator's exact tolerance, both boundaries, and the per-source behaviour
 * that follows from it.
 *
 * THE TOLERANCE (src/lib/api.ts validateFeeIntegrity):
 *     tolerance = quoted * 2 / 100          // 2% of the quoted output
 *     invalid  ⟺ swapped > quoted + tolerance
 * It is ONE-SIDED. There is no floor: a swap output BELOW the quote never
 * fails, at any distance. Only an implausibly HIGH output blocks.
 *
 * VERDICT — arming is safe (no false positives), but the check is NOT a
 * fee-loss detector at FEE_BPS = 10. See the calibration test at the bottom:
 * dropping a 0.1% fee raises the output ~0.1%, which is ~20x INSIDE a 2% band.
 * Arming still strictly dominates not arming (it costs nothing and catches
 * gross anomalies), but the Auditor should read it as an anomaly tripwire, not
 * as proof the fee was taken.
 */
import { describe, it, expect } from 'vitest'
import { validateFeeIntegrity } from '@/lib/api'
import { FEE_NATIVE_SOURCES, FEE_BPS, type AggregatorName } from '@/lib/constants'

/** Mirrors the production gate in useSwap.ts, reading the REAL constant. */
function callSite(quoteToAmount: string | null, swapToAmount: string, source: AggregatorName) {
  const usesPartnerFee = FEE_NATIVE_SOURCES.includes(source)
  if (quoteToAmount && usesPartnerFee) {
    return { ran: true, valid: validateFeeIntegrity(quoteToAmount, swapToAmount, source).valid }
  }
  return { ran: false, valid: true }
}

// 1 WETH -> USDC around $3,000. 0x applies the 0.1% fee to BOTH the /price
// quote and the /quote build, so both of these are already post-fee.
const QUOTE_POST_FEE = '2997000000' // 2,997.000000 USDC

describe('[acceptance 2] the check now RUNS for a 0x swap', () => {
  it('0x is gated ON (it was gated OFF on origin/main — the list was empty)', () => {
    expect(callSite(QUOTE_POST_FEE, '2997000000', '0x').ran).toBe(true)
  })

  it('a FeeCollector-routed source stays gated OFF (unchanged)', () => {
    expect(callSite(QUOTE_POST_FEE, '9999999999', 'kyberswap').ran).toBe(false)
  })
})

describe('[acceptance 2] no false positives on realistic 0x pairs', () => {
  // Both amounts come from 0x with the fee applied, so they differ only by the
  // routing/liquidity drift between the /price call and the /quote call.
  const cases: Array<[string, string]> = [
    ['identical quote and build', '2997000000'],
    ['+0.30% routing drift up', '3005991000'],
    ['+1.00% routing drift up', '3026970000'],
    ['+1.99% routing drift up', '3056640300'],
    ['-0.50% routing drift down', '2982015000'],
    ['-5.00% drift down (no floor exists)', '2847150000'],
    ['-50% drift down (still valid — one-sided)', '1498500000'],
  ]
  for (const [label, swapAmount] of cases) {
    it(`${label} → passes`, () => {
      expect(callSite(QUOTE_POST_FEE, swapAmount, '0x')).toEqual({ ran: true, valid: true })
    })
  }
})

describe('[acceptance 2] the +2% boundary, both directions', () => {
  const QUOTED = '1000000000' // tolerance = 20,000,000

  it('exactly AT the ceiling (quoted + 2%) → VALID (comparison is > not >=)', () => {
    expect(validateFeeIntegrity(QUOTED, '1020000000', '0x').valid).toBe(true)
  })

  it('ONE unit above the ceiling → INVALID (blocks)', () => {
    const r = validateFeeIntegrity(QUOTED, '1020000001', '0x')
    expect(r.valid).toBe(false)
    expect(r.reason).toContain('Fee integrity check failed for 0x')
  })

  it('one unit BELOW the ceiling → VALID', () => {
    expect(validateFeeIntegrity(QUOTED, '1019999999', '0x').valid).toBe(true)
  })

  it('there is no lower boundary — zero output is still VALID', () => {
    expect(validateFeeIntegrity(QUOTED, '0', '0x').valid).toBe(true)
  })
})

describe('[acceptance 2] the other two armed sources cannot be blocked', () => {
  it("cowswap is inert — validateFeeIntegrity hard-skips it (solver surplus is normal)", () => {
    expect(callSite('1000000', '5000000', 'cowswap')).toEqual({ ran: true, valid: true })
  })

  it('bebop is armed but structurally untrippable: its price quote is GROSS', () => {
    // adapters/bebop.ts sends the fee on the FIRM quote only, so the build
    // output is the gross quote MINUS the fee — always below, never above.
    const gross = '1000000000'
    const firmNetOfFee = String((BigInt(gross) * BigInt(10000 - FEE_BPS)) / 10000n)
    expect(BigInt(firmNetOfFee)).toBeLessThan(BigInt(gross))
    expect(callSite(gross, firmNetOfFee, 'bebop')).toEqual({ ran: true, valid: true })
  })
})

describe('[acceptance 2] CALIBRATION GAP — what arming does NOT buy us', () => {
  it('a silently DROPPED 0.1% partner fee is ~20x inside the 2% band → NOT detected', () => {
    // If 0x honoured swapFeeBps on /price but ignored it on /quote, the build
    // output would be the gross amount: quote / (1 - 0.001).
    const grossIfFeeDropped = String((BigInt(QUOTE_POST_FEE) * 10000n) / BigInt(10000 - FEE_BPS))
    const uplift = (Number(grossIfFeeDropped) / Number(QUOTE_POST_FEE) - 1) * 100
    expect(uplift).toBeCloseTo(0.1, 2)              // ~0.1% signal
    expect(uplift).toBeLessThan(2)                  // ...against a 2% threshold
    // Therefore the guard PASSES the very failure it is named for:
    expect(callSite(QUOTE_POST_FEE, grossIfFeeDropped, '0x')).toEqual({ ran: true, valid: true })
  })

  it('detection would require the fee to exceed the 2% tolerance (FEE_BPS > 200)', () => {
    expect(FEE_BPS).toBe(10)
    expect(FEE_BPS).toBeLessThan(200) // documents WHY the above is undetectable
  })

  it('what it DOES catch: a gross anomaly (5x output) still blocks', () => {
    expect(callSite(QUOTE_POST_FEE, '15000000000', '0x')).toEqual({ ran: true, valid: false })
  })
})
