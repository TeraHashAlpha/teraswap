/**
 * [CHORE-STABLECOIN-CONSTANT] Chain-keyed stablecoin membership — the single source of
 * truth (AZ review FE5: 6 divergent inline lists; USDbC counted as ~$1 in one gate but
 * not another).
 *
 * USD_STABLECOINS_BY_CHAIN — symbols the UI gates treat as ~$1 USD: auto-slippage
 * (SlippageModal), execution-price derivation for the Chainlink deviation check and the
 * input-USD estimate for the unverified-swap gate (SwapBox), and the split-routing USD
 * threshold (useSplitRoute).
 *
 * Membership rules (correctness, not style — drift is enforced by stablecoins.test.ts):
 *  - CURATED stables only. Mainnet: exactly the DEFAULT_TOKENS 'Stablecoin' category.
 *    Base: the curated suggested USD stables. Long-tail catalog stables (e.g. Base
 *    LUSD/USDS/crvUSD) are deliberately NOT ~$1-trusted — the same trust boundary the
 *    historical gate lists drew.
 *  - EXACT on-chain symbol match (case-sensitive): an imported lookalike ("usdc") must
 *    not gain ~$1 trust.
 *  - EUR-pegged stables (EURC trades at EUR/USD FX, not $1) belong to the 'Stablecoin'
 *    UI CATEGORY but never to a USD set — see STABLECOIN_CATEGORY_EXTRAS.
 *  - Unknown chain → empty set (fail-closed: no ~$1 assumption anywhere).
 */

export const USD_STABLECOINS_BY_CHAIN: Record<number, readonly string[]> = {
  // Ethereum mainnet — mirrors DEFAULT_TOKENS' curated 'Stablecoin' category (test-enforced).
  1: ['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'PYUSD', 'USDe', 'USDS', 'GHO', 'crvUSD', 'BOLD'],
  // Base — curated suggested USD stables; USDbC (bridged USDC) IS ~$1 here, and only here.
  8453: ['USDC', 'USDbC', 'USDT', 'DAI'],
  // [SPRINT-46-ARBITRUM-CONFIG] Arbitrum — NATIVE USDC only (curation decision, mirrors the
  // report's flag). USDC.e (bridged) is deliberately excluded from v1's token catalog entirely
  // (registry.ts), so it can't reach this gate anyway; CONFIG-ONLY / dark until activation.
  42161: ['USDC', 'USDT', 'DAI'],
}

/** EUR-pegged (fiat, non-USD) stables per chain: 'Stablecoin' UI category, never ~$1. */
export const STABLECOIN_CATEGORY_EXTRAS: Record<number, readonly string[]> = {
  1: ['EURC'],
  8453: ['EURC'],
}

const EMPTY: readonly string[] = []

/** Per-chain ~$1 USD stable symbols (empty for unknown chains — fail-closed). */
export function getUsdStablecoins(chainId: number): readonly string[] {
  return USD_STABLECOINS_BY_CHAIN[chainId] ?? EMPTY
}

/** True when `symbol` is a curated ~$1 USD stable ON THIS chain (exact-casing match). */
export function isUsdStablecoin(symbol: string | null | undefined, chainId: number): boolean {
  return symbol != null && getUsdStablecoins(chainId).includes(symbol)
}

/** True when `symbol` belongs to the 'Stablecoin' UI category on this chain (USD ∪ EUR-pegged). */
export function isStablecoinCategorySymbol(symbol: string, chainId: number): boolean {
  return isUsdStablecoin(symbol, chainId) || (STABLECOIN_CATEGORY_EXTRAS[chainId] ?? EMPTY).includes(symbol)
}
