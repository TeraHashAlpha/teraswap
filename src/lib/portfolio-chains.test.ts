// @vitest-environment node
/**
 * [CHORE-POLISH-3 P2 / E3-L-01] Single source of truth for portfolio chain
 * support. Before this, the allowlist was defined TWICE — prices/route.ts via
 * getSupportedChainIds() and tokens/route.ts via the hardcoded Alchemy map
 * keys — so a future chain could be added to one route but not the other.
 * Both routes now consume THIS module; these tests pin the invariants.
 */
import { describe, it, expect } from 'vitest'
import { PORTFOLIO_SUPPORTED_CHAINS, ALCHEMY_BASE_BY_CHAIN, isPortfolioSupportedChain } from './portfolio-chains'
import { getSupportedChainIds, getChainConfig } from '@/lib/chains/registry'

describe('portfolio-chains [CHORE-POLISH-3 P2]', () => {
  it('supports exactly mainnet + Base today (behaviour-identical pin)', () => {
    expect([...PORTFOLIO_SUPPORTED_CHAINS].sort((a, b) => a - b)).toEqual([1, 8453])
  })

  it('the chain list and the Alchemy endpoint map are the SAME set (no drift possible)', () => {
    // The list is DERIVED from the map keys — if this fails, the derivation
    // was broken (e.g. someone reintroduced a separate hardcoded list).
    const mapKeys = Object.keys(ALCHEMY_BASE_BY_CHAIN).map(Number).sort((a, b) => a - b)
    expect([...PORTFOLIO_SUPPORTED_CHAINS].sort((a, b) => a - b)).toEqual(mapKeys)
  })

  it('every portfolio chain is registry-supported with a DefiLlama slug (prices route precondition)', () => {
    // prices/route.ts resolves getChainConfig(chainId).slug for any accepted
    // chain — a portfolio chain missing from the registry would throw at
    // request time. Guard the containment here.
    const registryChains = getSupportedChainIds()
    for (const chainId of PORTFOLIO_SUPPORTED_CHAINS) {
      expect(registryChains).toContain(chainId)
      expect(getChainConfig(chainId).slug).toBeTruthy()
    }
  })

  it('every portfolio chain has a well-formed Alchemy endpoint (tokens route precondition)', () => {
    for (const chainId of PORTFOLIO_SUPPORTED_CHAINS) {
      expect(ALCHEMY_BASE_BY_CHAIN[chainId]).toMatch(/^https:\/\/[a-z0-9-]+\.g\.alchemy\.com\/v2$/)
    }
  })

  it('isPortfolioSupportedChain accepts the set and rejects everything else', () => {
    for (const chainId of PORTFOLIO_SUPPORTED_CHAINS) {
      expect(isPortfolioSupportedChain(chainId)).toBe(true)
    }
    expect(isPortfolioSupportedChain(999999)).toBe(false)
    expect(isPortfolioSupportedChain(NaN)).toBe(false)
    expect(isPortfolioSupportedChain(1.5)).toBe(false)
  })
})
