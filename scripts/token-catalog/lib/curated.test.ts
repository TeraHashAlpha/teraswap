/**
 * [CHORE-OHM-KNC-REMAP] Curated corrections must ALSO apply to SEEDS, not just fetched
 * source entries — the seed baseline pins the pre-remap catalog, so without seed-side
 * correction a remapped deprecated address (OHM v1, KNC legacy) would ride back in as a
 * curated seed, hold the ticker via curated priority, and eject the canonical token.
 */
import { describe, it, expect } from 'vitest'
import type { SeedToken } from './types'
import { applyCuratedCorrections, correctSeed, CURATED_ARBITRUM_SEEDS } from './curated'

const OHM_V1 = '0x383518188C0C6d7730D91b2c03a03C837814a899'
const OHM_V2 = '0x64aa3364F17a4D01c6f1751Fd97C2BD3D7e7f1D5'
const KNC_LEGACY = '0xdd974D5C2e2928deA5F71b9825b8b646686BD200'
const KNC_V2 = '0xdeFA4e8a7bcBA345F687a2f1456F5Edd9CE97202'
const LOOM_REMOVED = '0xA4e8C3Ec456107eA67d3075bF9e3DF3A75823DB0'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

const seed = (address: string, symbol: string, decimals = 18): SeedToken => ({
  address: address as `0x${string}`,
  symbol,
  name: symbol,
  decimals,
})

describe('correctSeed — curated corrections on the seed path', () => {
  it('remaps the deprecated OHM v1 seed to the canonical Olympus v2 (official migration)', () => {
    const s = correctSeed(1, seed(OHM_V1, 'OHM', 9))
    expect(s).toMatchObject({ address: OHM_V2, symbol: 'OHM', decimals: 9 })
  })

  it('remaps the deprecated KNC legacy (KNCL) seed to the canonical KNC v2 (official migration)', () => {
    const s = correctSeed(1, seed(KNC_LEGACY, 'KNC', 18))
    expect(s).toMatchObject({ address: KNC_V2, symbol: 'KNC', decimals: 18 })
  })

  it('drops seeds on the curated REMOVALS list (LOOM)', () => {
    expect(correctSeed(1, seed(LOOM_REMOVED, 'LOOM'))).toBeNull()
  })

  it('returns untouched seeds unchanged (same reference metadata)', () => {
    const s = seed(WETH, 'WETH')
    expect(correctSeed(1, s)).toMatchObject({ address: WETH, symbol: 'WETH' })
  })

  it('remaps are chain-scoped — the same address on Base is untouched', () => {
    const s = correctSeed(8453, seed(OHM_V1, 'OHM', 9))
    expect(s).toMatchObject({ address: OHM_V1 })
  })
})

describe('applyCuratedCorrections — OHM/KNC on the source-entry path', () => {
  it('a stale list still carrying OHM v1 / KNC legacy votes for the CANONICAL address instead', () => {
    const entries = applyCuratedCorrections([
      { chainId: 1, address: OHM_V1 as `0x${string}`, symbol: 'OHM', name: 'Olympus', decimals: 9, source: 'trustwallet' },
      { chainId: 1, address: KNC_LEGACY as `0x${string}`, symbol: 'KNC', name: 'Kyber Network Crystal', decimals: 18, source: 'oneinch' },
    ])
    expect(entries.map((e) => e.address)).toEqual([OHM_V2, KNC_V2])
  })
})

describe('[CHORE-ARBITRUM-TOKEN-CATALOG-PIPELINE] Arbitrum USDT self-remap + USDC.e seed', () => {
  const ARB_USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'

  it('a source tagging the Arbitrum USDT address "USDT0" is corrected to "USDT" (self-remap, same address)', () => {
    const entries = applyCuratedCorrections([
      { chainId: 42161, address: ARB_USDT as `0x${string}`, symbol: 'USDT0', name: 'USDT0', decimals: 6, source: 'uniswap' },
    ])
    expect(entries).toEqual([{ chainId: 42161, address: ARB_USDT, symbol: 'USDT', name: 'Tether USD', decimals: 6, logoURI: undefined, source: 'uniswap' }])
  })

  it('the same self-remap applies on the seed path', () => {
    const s = correctSeed(42161, seed(ARB_USDT, 'USDT0', 6))
    expect(s).toMatchObject({ address: ARB_USDT, symbol: 'USDT' })
  })

  it('the self-remap is chain-scoped — the same address on another chain is untouched', () => {
    const entries = applyCuratedCorrections([
      { chainId: 1, address: ARB_USDT as `0x${string}`, symbol: 'USDT0', name: 'USDT0', decimals: 6, source: 'uniswap' },
    ])
    expect(entries[0].symbol).toBe('USDT0')
  })

  it('CURATED_ARBITRUM_SEEDS pins bridged USDC.e distinct from native USDC (no silent merge)', () => {
    expect(CURATED_ARBITRUM_SEEDS).toHaveLength(1)
    expect(CURATED_ARBITRUM_SEEDS[0]).toMatchObject({
      address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
      symbol: 'USDC.e',
      decimals: 6,
    })
  })
})
