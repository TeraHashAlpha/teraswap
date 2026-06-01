/**
 * [P221 / ADR-009] Per-chain popular-token catalog.
 *
 * Mainnet (chainId 1) is DERIVED from the existing DEFAULT_TOKENS catalog in
 * src/lib/tokens.ts — it can't drift and the mainnet UI stays byte-identical.
 * Base (8453) is an explicit list of popular, verified Base tokens. Logos use
 * the 1inch token CDN (keyed by token address) with the UI's generic-icon
 * fallback when a logo is missing.
 */
import { DEFAULT_TOKENS, type Token, type TokenCategory } from '@/lib/tokens'
import { NATIVE_ETH } from '@/lib/constants'

export interface ChainToken {
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  logoURI: string
  /** Show in the default/popular quick-select list. */
  popular?: boolean
}

function logo(addr: string): string {
  return `https://tokens.1inch.io/${addr.toLowerCase()}.png`
}

// Mirrors TokenSelector's existing POPULAR_SYMBOLS so the derived mainnet
// catalog flags the same popular tokens.
const MAINNET_POPULAR = new Set(['ETH', 'USDC', 'USDT', 'WBTC', 'DAI', 'WETH', 'LINK', 'UNI'])

// ETH/WETH reuse the canonical mainnet logos (same visual asset).
const ETH_LOGO = logo('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
const WETH_LOGO = logo('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')

// Verified Base (8453) tokens. Addresses cross-checked against Basescan /
// Circle / Coinbase / MakerDAO official sources.
const BASE_TOKENS: ChainToken[] = [
  { address: NATIVE_ETH, symbol: 'ETH', name: 'Ethereum', decimals: 18, logoURI: ETH_LOGO, popular: true },
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: WETH_LOGO, popular: true },
  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: logo('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), popular: true },
  { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, logoURI: logo('0x50c5725949a6f0c72e6c4a641f24049a917db0cb'), popular: true },
  { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', decimals: 18, logoURI: logo('0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22'), popular: true },
  { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC', name: 'USD Base Coin (Bridged)', decimals: 6, logoURI: logo('0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'), popular: true },
]

function toChainToken(t: Token): ChainToken {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    logoURI: t.logoURI,
    popular: MAINNET_POPULAR.has(t.symbol),
  }
}

export const CHAIN_TOKENS: Record<number, ChainToken[]> = {
  1: DEFAULT_TOKENS.map(toChainToken),
  8453: BASE_TOKENS,
}

/** Popular tokens for a chain (falls back to the whole list if none flagged). */
export function getPopularTokens(chainId: number): ChainToken[] {
  const list = CHAIN_TOKENS[chainId] ?? []
  const popular = list.filter((t) => t.popular)
  return popular.length > 0 ? popular : list
}

/** Look up a token in a chain's catalog by address. */
export function getChainToken(address: string, chainId: number): ChainToken | null {
  const addr = address.toLowerCase()
  return (CHAIN_TOKENS[chainId] ?? []).find((t) => t.address.toLowerCase() === addr) ?? null
}

function inferCategory(symbol: string): TokenCategory {
  if (symbol === 'ETH' || symbol === 'WETH') return 'Native'
  if (['USDC', 'USDT', 'DAI', 'USDbC', 'USDe', 'FRAX', 'LUSD'].includes(symbol)) return 'Stablecoin'
  if (symbol === 'cbETH' || symbol === 'wstETH' || symbol === 'rETH') return 'Liquid Staking'
  if (symbol.includes('BTC')) return 'Wrapped BTC'
  return 'Other'
}

/**
 * The chain's catalog as the rich `Token` type the TokenSelector renders.
 * chainId 1 returns the full mainnet DEFAULT_TOKENS unchanged; other chains map
 * their ChainToken list with an inferred category.
 */
export function getChainTokenList(chainId: number): Token[] {
  if (chainId === 1) return DEFAULT_TOKENS
  return (CHAIN_TOKENS[chainId] ?? []).map((t) => ({
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    logoURI: t.logoURI,
    category: inferCategory(t.symbol),
  }))
}

/**
 * [SPRINT-9E] Re-resolve a selected token to the active chain's catalog BY SYMBOL,
 * so a swap quotes the chain's REAL address (e.g. mainnet USDC 0xA0b8… → Base USDC
 * 0x833589…). Returns the original token unchanged when the same-symbol token on
 * the chain has the SAME address (mainnet → byte-identical no-op) or no match
 * exists — preventing the "mainnet USDC on Base → 1inch 400 not valid token →
 * No valid quotes" class of bug (INC follow-up / SPRINT-9E).
 */
export function remapTokenToChain(token: Token | null, chainId: number): Token | null {
  if (!token) return token
  const match = getChainTokenList(chainId).find(
    (t) => t.symbol === token.symbol && t.address.toLowerCase() !== token.address.toLowerCase(),
  )
  return match ?? token
}
