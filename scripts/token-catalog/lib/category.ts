/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Category resolution:
 * seed (hand-curated DEFAULT_TOKENS) > token-category-overrides > symbol heuristic > 'Other'.
 * Both maps are keyed `${chainId}:${lowercaseAddress}` — overrides are chain-scoped so a
 * colliding address on another chain never inherits a mainnet category.
 */

// Light symbol heuristic — cosmetic grouping only (mirrors chains/tokens.ts inferCategory,
// extended with the current DEFAULT_TOKENS stable/staking sets).
const STABLES = new Set([
  'USDC', 'USDT', 'DAI', 'USDbC', 'USDe', 'FRAX', 'LUSD', 'EURC', 'PYUSD', 'USDS', 'GHO', 'crvUSD', 'BOLD', 'TUSD', 'USDP',
])
const LIQUID_STAKING = new Set([
  'cbETH', 'wstETH', 'stETH', 'rETH', 'weETH', 'rsETH', 'sfrxETH', 'ezETH', 'mETH', 'ETHx', 'swETH',
])

function heuristic(symbol: string): string {
  if (symbol === 'ETH' || symbol === 'WETH') return 'Native'
  if (STABLES.has(symbol)) return 'Stablecoin'
  if (LIQUID_STAKING.has(symbol)) return 'Liquid Staking'
  if (symbol.toUpperCase().includes('BTC')) return 'Wrapped BTC'
  return 'Other'
}

export function makeCategoryResolver(opts: {
  seedCategories: Map<string, string>
  overrides: Map<string, string>
}): (chainId: number, address: string, symbol: string) => string {
  const { seedCategories, overrides } = opts
  return (chainId, address, symbol) => {
    const k = `${chainId}:${address.toLowerCase()}`
    return seedCategories.get(k) ?? overrides.get(k) ?? heuristic(symbol)
  }
}
