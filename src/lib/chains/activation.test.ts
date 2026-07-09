/**
 * [P224] Swap activation guard (P223).
 */
import { describe, it, expect } from 'vitest'
import { isChainActive, getChainStatus, getFeeIncompatibleSources } from './activation'

describe('chains/activation [P223]', () => {
  it('mainnet is active (FeeCollector deployed)', () => {
    expect(isChainActive(1)).toBe(true)
  })

  it('Base is coming-soon (FeeCollector not deployed yet)', () => {
    expect(isChainActive(8453)).toBe(false)
  })

  it('getChainStatus returns the correct status for each chain', () => {
    expect(getChainStatus(1)).toBe('active')
    expect(getChainStatus(8453)).toBe('coming-soon')
    expect(getChainStatus(99999)).toBe('unsupported')
  })

  it('an unsupported chain is inactive; fee-incompatible sources fall back to mainnet', () => {
    expect(isChainActive(99999)).toBe(false)
    // [ADR-010] Bebop is fee-incompatible on both chains (JAM partner-fee, not FeeCollector).
    expect(getFeeIncompatibleSources(1)).toEqual(['0x', 'cowswap', 'bebop'])
    expect(getFeeIncompatibleSources(8453)).toEqual(['0x', 'cowswap', 'bebop'])
  })

  it('[SPRINT-46-ARBITRUM-CONFIG] Arbitrum (42161) is coming-soon (feeCollector hard-null, dark launch)', () => {
    expect(isChainActive(42161)).toBe(false)
    expect(getChainStatus(42161)).toBe('coming-soon')
    // Unlisted → falls back to the mainnet fee-incompatible set (existing unknown-chain behavior).
    expect(getFeeIncompatibleSources(42161)).toEqual(['0x', 'cowswap', 'bebop'])
  })
})
