// @vitest-environment node
/**
 * [fix/zerox-partner-fee-armed] The fee claim names its actual mechanism.
 *
 * QuoteBreakdown used to compute:
 *     FEE_NATIVE_SOURCES.includes(source) || isFeeCollectorActive()
 * Two unrelated conditions OR-ed together. With FEE_NATIVE_SOURCES empty, a 0x
 * quote's fee claim was carried entirely by the SECOND term — the FeeCollector
 * being deployed — even though 0x is FEE_INCOMPATIBLE and its fee is taken by
 * 0x's own API. The displayed answer was correct; its stated reason was not.
 *
 * The negative control below is the point of this file: on a chain whose
 * FeeCollector is null the second term is FALSE, so anything still reporting a
 * fee must be reporting it through the native mechanism alone.
 */
import { describe, it, expect } from 'vitest'
import { feeMode, isFeeCollected } from './fee-mode'
import { getChainConfig } from '@/lib/chains'

const MAINNET = 1
const BASE = 8453 // FeeCollector is env-driven and unset in test/CI → null

describe('[acceptance 3] feeMode names the collecting mechanism', () => {
  it('PRECONDITION: mainnet has a FeeCollector, Base does not', () => {
    // If this ever fails, the negative control below is no longer isolating
    // anything — fix the fixture chain, do not relax the assertion.
    expect(getChainConfig(MAINNET).contracts.feeCollector).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(getChainConfig(BASE).contracts.feeCollector).toBeNull()
  })

  it("0x → 'native-partner-fee' (its API deducts the fee; no FeeCollector hop)", () => {
    expect(feeMode('0x', MAINNET)).toBe('native-partner-fee')
    expect(isFeeCollected('0x', MAINNET)).toBe(true)
  })

  it("cowswap and bebop → 'native-partner-fee' too", () => {
    expect(feeMode('cowswap', MAINNET)).toBe('native-partner-fee')
    expect(feeMode('bebop', MAINNET)).toBe('native-partner-fee')
  })

  it("a FeeCollector-compatible source → 'fee-collector'", () => {
    expect(feeMode('kyberswap', MAINNET)).toBe('fee-collector')
    expect(feeMode('1inch', MAINNET)).toBe('fee-collector')
    expect(isFeeCollected('1inch', MAINNET)).toBe(true)
  })

  it('the three modes are mutually exclusive and total', () => {
    const modes = ['0x', 'kyberswap'].map((s) => feeMode(s as never, MAINNET))
    expect(new Set(modes).size).toBe(2)
    expect(feeMode('kyberswap', BASE)).toBe('none')
  })
})

describe('[acceptance 3] NEGATIVE CONTROL — isolating the two OR-ed terms', () => {
  it('0x stays fee-collected with the FeeCollector INACTIVE (native term alone)', () => {
    // Base FeeCollector is null → the old expression's second term is false.
    // A true answer here can only come from the native partner-fee mechanism.
    expect(feeMode('0x', BASE)).toBe('native-partner-fee')
    expect(isFeeCollected('0x', BASE)).toBe(true)
  })

  it('a FeeCollector-routed source goes to none on that same chain', () => {
    // Proves the second term really IS off on Base, so the assertion above is
    // not just inheriting a globally-true FeeCollector.
    expect(feeMode('kyberswap', BASE)).toBe('none')
    expect(isFeeCollected('kyberswap', BASE)).toBe(false)
  })

  it('on origin/main both sources answered TRUE on Base — for the wrong reason', () => {
    // The old code called isFeeCollectorActive() with NO chainId, so it always
    // answered for mainnet. Reconstructed here to document what changed:
    const oldExpression = (nativeListed: boolean) => nativeListed || true /* mainnet FC */
    expect(oldExpression(false)).toBe(true)  // kyberswap on Base: claimed a fee
    expect(isFeeCollected('kyberswap', BASE)).toBe(false) // now honest
  })
})
