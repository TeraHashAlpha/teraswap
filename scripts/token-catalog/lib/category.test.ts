/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Category resolution order:
 * seed (hand-curated DEFAULT_TOKENS) > token-category-overrides > symbol heuristic > 'Other'.
 */
import { describe, it, expect } from 'vitest'
import { makeCategoryResolver } from './category'

const PAXG = '0x45804880De22913dAFE09f4980848ECE6EcbAf78'
const GNO = '0x6810e776880C02933D47DB1b9fc05908e5386b96'

describe('makeCategoryResolver', () => {
  const resolver = makeCategoryResolver({
    seedCategories: new Map([[`1:${PAXG.toLowerCase()}`, 'Gold']]),
    overrides: new Map([
      [`1:${PAXG.toLowerCase()}`, 'Other'], // stale override — seed must win
      [`1:${GNO.toLowerCase()}`, 'L2 & Infrastructure'],
    ]),
  })

  it('seed category wins over a stale override (PAXG stays Gold)', () => {
    expect(resolver(1, PAXG, 'PAXG')).toBe('Gold')
  })

  it('override applies when there is no seed category', () => {
    expect(resolver(1, GNO, 'GNO')).toBe('L2 & Infrastructure')
  })

  it('overrides are chain-scoped — the same address on Base does not inherit them', () => {
    expect(resolver(8453, GNO, 'SOMETHING')).toBe('Other')
  })

  it('falls back to the symbol heuristic', () => {
    expect(resolver(1, '0x0000000000000000000000000000000000000001', 'USDC')).toBe('Stablecoin')
    expect(resolver(1, '0x0000000000000000000000000000000000000002', 'cbETH')).toBe('Liquid Staking')
    expect(resolver(1, '0x0000000000000000000000000000000000000003', 'cbBTC')).toBe('Wrapped BTC')
    expect(resolver(1, '0x0000000000000000000000000000000000000004', 'WETH')).toBe('Native')
  })

  it('unknown symbol resolves to Other', () => {
    expect(resolver(1, '0x0000000000000000000000000000000000000005', 'ZZZZ')).toBe('Other')
  })
})
