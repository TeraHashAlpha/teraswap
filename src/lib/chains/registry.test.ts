/**
 * [P220] ChainConfig registry resolution (P216).
 */
import { describe, it, expect } from 'vitest'
import { getChainConfig, getSupportedChainIds, DEFAULT_CHAIN_ID } from './registry'

describe('chains/registry [P216]', () => {
  it('returns the Ethereum mainnet config for chainId 1', () => {
    const c = getChainConfig(1)
    expect(c.chainId).toBe(1)
    expect(c.slug).toBe('ethereum')
    expect(c.gasModel).toBe('eip1559')
    expect(c.nativeCurrency.symbol).toBe('ETH')
    expect(c.contracts.feeCollector).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(c.contracts.permit2).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3')
    // Mainnet is an L1 — no sequencer feed.
    expect(c.sequencerUptimeFeed).toBeUndefined()
  })

  it('returns the Base config for chainId 8453 with feeCollector null', () => {
    const c = getChainConfig(8453)
    expect(c.chainId).toBe(8453)
    expect(c.slug).toBe('base')
    expect(c.gasModel).toBe('op-stack')
    expect(c.contracts.feeCollector).toBeNull() // not deployed yet
    expect(c.sequencerUptimeFeed).toBe('0xBCF85224fc0756B9Fa45aA7892530B47e10b6433')
    expect(c.nativeCurrency.wrappedAddress).toBe('0x4200000000000000000000000000000000000006')
  })

  it('throws on an unsupported chain', () => {
    expect(() => getChainConfig(99999)).toThrow(/unsupported chain/i)
  })

  it('getSupportedChainIds includes 1 and 8453; DEFAULT_CHAIN_ID is mainnet', () => {
    const ids = getSupportedChainIds()
    expect(ids).toContain(1)
    expect(ids).toContain(8453)
    expect(DEFAULT_CHAIN_ID).toBe(1)
  })
})
