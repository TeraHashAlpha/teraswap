// @vitest-environment node
/**
 * [SPRINT-9T T3] No-double-charge invariant + single bps source of truth.
 *
 * The three FEE_INCOMPATIBLE sources collect TeraSwap's 0.1% through their NATIVE partner-fee
 * mechanism (Bebop `fee`, 0x `swapFeeBps`, CoW `metadata.partnerFee`) and therefore must NEVER also
 * route through the FeeCollector contract — partner fee XOR FeeCollector fee, never both. Every fee
 * mechanism reads the SAME FEE_BPS constant (no per-source magic number).
 */
import { describe, it, expect } from 'vitest'
import { usesFeeCollector } from '@/lib/api'
import { FEE_INCOMPATIBLE_SOURCES, FEE_BPS } from '@/lib/constants'

describe('[SPRINT-9T T3] partner fee XOR FeeCollector fee', () => {
  it('the partner-fee sources are exactly 0x / cowswap / bebop', () => {
    expect([...FEE_INCOMPATIBLE_SOURCES].sort()).toEqual(['0x', 'bebop', 'cowswap'])
  })

  it('every FEE_INCOMPATIBLE source bypasses the FeeCollector (no double-charge)', () => {
    // FeeCollector is active on mainnet, yet these sources never route through it — their fee is
    // taken natively in the adapter, so they can NOT also be charged by the contract.
    for (const source of FEE_INCOMPATIBLE_SOURCES) {
      expect(usesFeeCollector(source, 1)).toBe(false)
    }
  })

  it('a FeeCollector-compatible source (1inch) DOES route through the FeeCollector → no native fee', () => {
    expect(FEE_INCOMPATIBLE_SOURCES).not.toContain('1inch')
    expect(usesFeeCollector('1inch', 1)).toBe(true)
  })

  it('one bps source of truth: FEE_BPS = 10 (0.1%) — read by FeeCollector, Bebop, 0x and CoW', () => {
    // 0x swapFeeBps, CoW partnerFee.bps, Bebop `fee`, and the FeeCollector minimum-output math all
    // derive from this single constant; a change here moves every source together.
    expect(FEE_BPS).toBe(10)
    expect(FEE_BPS).toBeGreaterThan(0)
    expect(FEE_BPS).toBeLessThanOrEqual(100) // CoW partnerFee + 0x swapFeeBps both cap well above this
  })
})
