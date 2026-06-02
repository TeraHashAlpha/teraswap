/**
 * [SPRINT-9J J1] Unit tests for the price-gate classifier.
 *
 * The client Chainlink check currently hard-blocks the swap whenever the
 * EXECUTION price (which already bakes in the trade's own price impact)
 * deviates >=2% from the Chainlink spot. On an illiquid PMM route a legit
 * ~2.2% price impact therefore trips the "oracle" gate and the swap is paused
 * forever (the re-poll re-computes the same impact every cycle).
 *
 * evaluatePriceGate() separates the two concerns:
 *   - oracle INTEGRITY failure (stale / invalid round / answeredInRound) is a
 *     genuine oracle-safety event → HARD block (cannot be clicked through).
 *   - a deviation on a HEALTHY oracle is price impact (slippage the user
 *     already accepts) → informed CONSENT (the user can accept and proceed).
 *     Genuine cross-source manipulation is still hard-blocked server-side by
 *     the DefiLlama price guard, which this gate does not touch.
 */
import { describe, it, expect } from 'vitest'
import type { PriceCheck } from './chainlink'
import { evaluatePriceGate } from './price-gate'

/** Build a PriceCheck with sensible healthy-oracle defaults. */
function pc(over: Partial<PriceCheck>): PriceCheck {
  return {
    chainlinkPrice: 2000,
    executionPrice: 2000,
    deviation: 0,
    level: 'none',
    message: null,
    oracleUnavailable: false,
    oracleIntegrityFailed: false,
    ...over,
  }
}

describe('evaluatePriceGate [SPRINT-9J J1]', () => {
  it('a high-price-impact small trade on a HEALTHY oracle is CONSENT, not a hard block', () => {
    // 2.2% execution-vs-Chainlink deviation, oracle data is fresh & valid.
    const gate = evaluatePriceGate(pc({ deviation: 0.022, level: 'warn', executionPrice: 1956 }))
    expect(gate.mode).toBe('consent')
    expect(gate.reason).toBe('price-impact')
  })

  it('an even larger price impact (danger band) on a healthy oracle is still CONSENT (server guard is the manipulation backstop)', () => {
    const gate = evaluatePriceGate(pc({ deviation: 0.05, level: 'danger', executionPrice: 1900 }))
    expect(gate.mode).toBe('consent')
    expect(gate.reason).toBe('price-impact')
  })

  it('a STALE / invalid-round oracle hard-BLOCKS (cannot be clicked through)', () => {
    const gate = evaluatePriceGate(pc({ level: 'warn', oracleIntegrityFailed: true, message: 'stale' }))
    expect(gate.mode).toBe('block')
    expect(gate.reason).toBe('oracle-integrity')
  })

  it('within-threshold deviation (<2%) is OK', () => {
    const gate = evaluatePriceGate(pc({ deviation: 0.015, level: 'none', executionPrice: 2030 }))
    expect(gate.mode).toBe('ok')
  })

  it('oracleUnavailable defers to the tiered USD gate — this classifier returns OK (does not block)', () => {
    const gate = evaluatePriceGate(pc({ oracleUnavailable: true, level: 'warn', chainlinkPrice: null }))
    expect(gate.mode).toBe('ok')
  })

  it('integrity failure takes precedence even if a deviation is also present', () => {
    const gate = evaluatePriceGate(pc({ deviation: 0.04, level: 'danger', oracleIntegrityFailed: true }))
    expect(gate.mode).toBe('block')
    expect(gate.reason).toBe('oracle-integrity')
  })

  // [SPRINT-9J review F2] A deviation far beyond any plausible price impact (vs a
  // HEALTHY oracle) is almost certainly manipulation / a broken quote, not
  // slippage — hard-block it (no click-through). Normal impact stays consent.
  it('a normal illiquid-route impact (4%) is still CONSENT, not blocked (spec)', () => {
    expect(evaluatePriceGate(pc({ deviation: 0.04, level: 'danger', executionPrice: 1920 })).mode).toBe('consent')
  })

  it('an EXTREME deviation (>ceiling) on a healthy oracle is a HARD block (possible manipulation)', () => {
    const gate = evaluatePriceGate(pc({ deviation: 0.40, level: 'danger', executionPrice: 1200 }))
    expect(gate.mode).toBe('block')
    expect(gate.reason).toBe('extreme-deviation')
  })

  it('a deviation just under the ceiling stays consentable', () => {
    expect(evaluatePriceGate(pc({ deviation: 0.20, level: 'danger', executionPrice: 1600 })).mode).toBe('consent')
  })
})
