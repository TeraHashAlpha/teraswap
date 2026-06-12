/**
 * [CHORE-POLISH-3 P2 / E3-L-01] Single source of truth for which chains the
 * Portfolio feature supports.
 *
 * Before this module, the allowlist lived in TWO places — prices/route.ts
 * validated against getSupportedChainIds() while tokens/route.ts validated
 * against its own hardcoded Alchemy-endpoint map — so a future chain could be
 * enabled on one route but not the other. Both routes now consume this file.
 *
 * The binding constraint is token DISCOVERY: a chain is portfolio-supported
 * iff it has an Alchemy Enhanced-API endpoint below (discovery has no other
 * backend). To add a chain: add its endpoint here AND make sure the chain is
 * registered in chains/registry.ts (the prices route resolves its DefiLlama
 * slug from there — portfolio-chains.test.ts guards the containment).
 */

/** Alchemy Enhanced-API base URL per supported chain (server-side only —
 * the key is appended in the tokens route and never reaches the browser). */
export const ALCHEMY_BASE_BY_CHAIN: Record<number, string> = {
  1: 'https://eth-mainnet.g.alchemy.com/v2',
  8453: 'https://base-mainnet.g.alchemy.com/v2',
}

/** Chains the Portfolio tab supports — derived from the endpoint map so the
 * two can never drift apart. Today: {1, 8453}. */
export const PORTFOLIO_SUPPORTED_CHAINS: readonly number[] = Object.keys(ALCHEMY_BASE_BY_CHAIN)
  .map(Number)
  .sort((a, b) => a - b)

/** Shared chain validation for BOTH portfolio routes (tokens + prices). */
export function isPortfolioSupportedChain(chainId: number): boolean {
  return Number.isInteger(chainId) && PORTFOLIO_SUPPORTED_CHAINS.includes(chainId)
}
