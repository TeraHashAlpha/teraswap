/**
 * [chore/oracle-less-advisory] resolveOracleCoverage — pure decision for the
 * creation-time "no price oracle" note. A token is oracle-less ONLY when it has
 * NO Chainlink feed on the active chain AND DefiLlama definitively returns no
 * price. A transient/failed DefiLlama probe ('unknown') FAILS OPEN (treated as
 * covered) so a blip never shows a false note. Informational only — never blocks.
 */
import { describe, it, expect } from 'vitest'
import { resolveOracleCoverage } from './oracle-coverage'

describe('resolveOracleCoverage', () => {
  it('Chainlink feed present → has oracle (DefiLlama irrelevant / not probed)', () => {
    expect(resolveOracleCoverage(true, 'unknown').hasOracle).toBe(true)
    expect(resolveOracleCoverage(true, 'none').hasOracle).toBe(true)
    expect(resolveOracleCoverage(true, 'covered').hasOracle).toBe(true)
  })

  it('no Chainlink but DefiLlama covers it → has oracle (no note)', () => {
    expect(resolveOracleCoverage(false, 'covered').hasOracle).toBe(true)
  })

  it('no Chainlink AND DefiLlama definitively has no price → oracle-LESS (note shows)', () => {
    expect(resolveOracleCoverage(false, 'none').hasOracle).toBe(false)
  })

  it("no Chainlink and DefiLlama probe FAILED ('unknown') → fail OPEN, no false note", () => {
    expect(resolveOracleCoverage(false, 'unknown').hasOracle).toBe(true)
  })

  it('carries the inputs through for diagnostics', () => {
    const r = resolveOracleCoverage(false, 'none')
    expect(r).toEqual({ hasOracle: false, hasChainlink: false, defillama: 'none' })
  })
})
