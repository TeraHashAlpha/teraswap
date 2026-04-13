import type { TokenCategory } from '../src/lib/tokens'

/** Manual overrides — applied BEFORE CoinGecko-based mapping */
export const CATEGORY_OVERRIDES: Record<string, TokenCategory> = {
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': 'Native',     // WETH grouped with ETH
  '0x111111111117dC0aa78b770fA6A738034120C302': 'DeFi',         // 1INCH
  '0x6810e776880C02933D47DB1b9fc05908e5386b96': 'L2 & Infrastructure', // GNO
  '0x92D6C1e31e14520e676a687F0a93788B716BEff5': 'DeFi',         // DYDX
  '0x45804880De22913dAFE09f4980848ECE6EcbAf78': 'Other',        // PAXG (gold)
  '0x6DEA81C8171D0bA574754EF6F8b412F2Ed88c54D': 'DeFi',         // LQTY
  '0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD': 'L2 & Infrastructure', // LRC
  '0x69af81e73A73B40adF4f3d4223Cd9b1ECE623074': 'Other',        // MASK
  '0x090185f2135308BaD17527004364eBcC2D37e5F6': 'DeFi',         // SPELL
}
