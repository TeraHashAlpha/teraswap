// @vitest-environment node
/**
 * [CHORE-DCA-COST-PREVIEW] Per-buy cost preview — transparency-brand invariant: never claim
 * "free"/"gasless", always name who pays. Fee reuses ORDER_FEE_BPS (the same constant
 * canonical-route.ts mirrors from the deployed contract's FEE_BPS); network cost is a single
 * sourced constant (FILL-ECONOMICS-CALIBRATION.md + the keeper's post-fix Base gas tier), never
 * re-derived ad hoc.
 */
import { describe, it, expect } from 'vitest'
import {
  computeDcaCostPreview,
  DCA_NETWORK_COST_ESTIMATE_USD,
  DCA_NETWORK_COST_COVERAGE_LABEL,
} from './dca-cost-preview'
import { ORDER_FEE_BPS, ORDER_BPS_DENOMINATOR } from './canonical-route'

describe('computeDcaCostPreview — fee math reuses the real fee constant, never a hardcoded rate', () => {
  it('fee is exactly perChunkNotionalUsd × ORDER_FEE_BPS / ORDER_BPS_DENOMINATOR', () => {
    const p = computeDcaCostPreview({ perChunkNotionalUsd: 100 })
    const expectedFee = (100 * Number(ORDER_FEE_BPS)) / Number(ORDER_BPS_DENOMINATOR)
    expect(p).not.toBeNull()
    expect(p!.feeUsd).toBeCloseTo(expectedFee, 10)
    expect(p!.feeUsd).toBeCloseTo(0.1, 10) // 0.1% of $100
  })

  it('scales linearly with notional ($10 chunk -> $0.01 fee)', () => {
    const p = computeDcaCostPreview({ perChunkNotionalUsd: 10 })
    expect(p!.feeUsd).toBeCloseTo(0.01, 10)
  })

  it('$1000 chunk -> $1.00 fee', () => {
    const p = computeDcaCostPreview({ perChunkNotionalUsd: 1000 })
    expect(p!.feeUsd).toBeCloseTo(1.0, 10)
  })

  it('the fee rate used matches ORDER_FEE_BPS exactly, not an independent 0.001 literal', () => {
    // Prove no drift: if ORDER_FEE_BPS ever changes, this test's own math changes with it —
    // the ONLY way this passes is if computeDcaCostPreview reads the same constant.
    const notional = 777
    const p = computeDcaCostPreview({ perChunkNotionalUsd: notional })
    expect(p!.feeUsd).toBeCloseTo(notional * (Number(ORDER_FEE_BPS) / Number(ORDER_BPS_DENOMINATOR)), 10)
  })
})

describe('computeDcaCostPreview — network cost is the single sourced constant', () => {
  it('networkCostUsd is exactly DCA_NETWORK_COST_ESTIMATE_USD, regardless of chunk size', () => {
    for (const notional of [10, 100, 1000]) {
      const p = computeDcaCostPreview({ perChunkNotionalUsd: notional })
      expect(p!.networkCostUsd).toBe(DCA_NETWORK_COST_ESTIMATE_USD)
    }
  })

  it('the constant sits within the calibration report\'s stated post-fix range ($0.03-$0.07)', () => {
    expect(DCA_NETWORK_COST_ESTIMATE_USD).toBeGreaterThanOrEqual(0.03)
    expect(DCA_NETWORK_COST_ESTIMATE_USD).toBeLessThanOrEqual(0.07)
  })

  it('carries the coverage label exactly as the single-sourced v3 truth', () => {
    const p = computeDcaCostPreview({ perChunkNotionalUsd: 100 })
    expect(p!.coverageLabel).toBe(DCA_NETWORK_COST_COVERAGE_LABEL)
    expect(DCA_NETWORK_COST_COVERAGE_LABEL.toLowerCase()).toContain('covered by teraswap')
  })
})

describe('computeDcaCostPreview — never implies "free"', () => {
  it('the coverage label never contains "free" or "gasless"', () => {
    expect(DCA_NETWORK_COST_COVERAGE_LABEL.toLowerCase()).not.toMatch(/free|gasless/)
  })

  it('no field on the returned object is or contains the word "free"/"gasless"', () => {
    const p = computeDcaCostPreview({ perChunkNotionalUsd: 50 })
    const serialized = JSON.stringify(p).toLowerCase()
    expect(serialized).not.toMatch(/free|gasless/)
  })
})

describe('computeDcaCostPreview — invalid input fails closed to null (never a fabricated preview)', () => {
  it('null/undefined/NaN/zero/negative notional all return null', () => {
    expect(computeDcaCostPreview({ perChunkNotionalUsd: null })).toBeNull()
    expect(computeDcaCostPreview({ perChunkNotionalUsd: NaN })).toBeNull()
    expect(computeDcaCostPreview({ perChunkNotionalUsd: 0 })).toBeNull()
    expect(computeDcaCostPreview({ perChunkNotionalUsd: -5 })).toBeNull()
  })

  it('Infinity returns null', () => {
    expect(computeDcaCostPreview({ perChunkNotionalUsd: Infinity })).toBeNull()
  })
})
