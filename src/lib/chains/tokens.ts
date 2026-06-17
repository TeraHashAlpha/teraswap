/**
 * [P221 / ADR-009 / SPRINT-9Y] Per-chain token catalog.
 *
 * Mainnet (chainId 1) is DERIVED from the existing DEFAULT_TOKENS catalog in
 * src/lib/tokens.ts — it can't drift and the mainnet UI stays byte-identical.
 * Base (8453) is built from the PINNED Uniswap Labs Default snapshot baked into
 * token-catalog.generated.ts (+ one CoinGecko bridged-USDT entry) — every address
 * is sourced + validated (EIP-55, chainId, decimals), NEVER hand-typed.
 *
 * Two layers (Matcha-style, SPRINT-9Y):
 *  - getChainTokenList / getPopularTokens → the curated "Suggested" set shown by
 *    default (~20-30 majors), categorised.
 *  - getFullCatalog / getSearchCatalog → the full pinned long tail used by search
 *    and the verified-✓ badge. import-by-address (non-catalog) stays ⚠.
 *
 * Logos: core majors point to bundled local assets in public/tokens/ (validated, no
 * 404); the long tail uses DefiLlama's chainId-aware CDN (token-icons.llamao.fi),
 * which serves Base + mainnet logos reliably. The UI's generated-initials avatar stays
 * the FINAL onError fallback. Native ETH uses the local /tokens/eth.png asset.
 */
import { DEFAULT_TOKENS, findTokenByAddress, getCustomTokens, type Token, type TokenCategory } from '@/lib/tokens'
import { NATIVE_ETH } from '@/lib/constants'
import { DEFAULT_CHAIN_ID, getChainConfig } from '@/lib/chains/registry'
import { GENERATED_TOKEN_CATALOG } from './token-catalog.generated'

export interface ChainToken {
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  logoURI: string
  /** Show in the default/popular quick-select chips. */
  popular?: boolean
  /** Part of the curated "Suggested" set shown by default (no search). */
  suggested?: boolean
}

/** [SPRINT-9Y] Max search results rendered at once — keeps a broad query snappy. */
export const SEARCH_RESULT_LIMIT = 80

/**
 * [SPRINT-9Y / token-selector-ux] Per-chain logo URL. DefiLlama's token-icons CDN is
 * chainId-aware and keyed by the LOWERCASE address (no EIP-55 checksum-casing pitfall),
 * verified 200 on BOTH mainnet (1) and Base (8453) — unlike the old mainnet-only
 * `tokens.1inch.io/<addr>.png` (404 on Base, 403 on some mainnet entries). Long-tail
 * entries use this; the verified core majors point to bundled local assets (see
 * CORE_LOCAL_LOGO) so they NEVER 404.
 */
function logo(addr: string, chainId: number): string {
  return `https://token-icons.llamao.fi/icons/tokens/${chainId}/${addr.toLowerCase()}?h=48&w=48`
}

// [token-selector-ux] Core brand logos bundled into public/tokens/ (validated, 100%
// reliable, no 404). The brand mark is identical across chains, so map BY SYMBOL — a
// core token on ANY chain catalog here points to its local file instead of a remote CDN.
const CORE_LOCAL_LOGO: Record<string, string> = {
  ETH: '/tokens/eth.png',
  WETH: '/tokens/weth.png',
  USDC: '/tokens/usdc.png',
  USDT: '/tokens/usdt.png',
  DAI: '/tokens/dai.png',
  cbETH: '/tokens/cbeth.png',
  WBTC: '/tokens/wbtc.png',
  LINK: '/tokens/link.png',
  UNI: '/tokens/uni.png',
  USDbC: '/tokens/usdbc.png',
}

// Mirrors TokenSelector's existing POPULAR_SYMBOLS so the derived mainnet
// catalog flags the same popular tokens.
const MAINNET_POPULAR = new Set(['ETH', 'USDC', 'USDT', 'WBTC', 'DAI', 'WETH', 'LINK', 'UNI'])

// Native ETH uses the bundled local asset (same visual on every chain, never 404s).
const ETH_LOGO = CORE_LOCAL_LOGO.ETH

// [SPRINT-9Y] Base curated "Suggested" majors shown by default (no search). The
// SYMBOLS are a curation choice; the ADDRESSES come only from the validated
// generated catalog (token-catalog.generated.ts) — never hand-typed.
const BASE_SUGGESTED_SYMBOLS = new Set([
  'ETH', 'WETH', 'USDC', 'USDbC', 'USDT', 'DAI', 'EURC', 'cbETH', 'cbBTC', 'AERO',
  'VIRTUAL', 'DEGEN', 'TOSHI', 'MORPHO', 'WELL', 'ZORA', 'MOG', 'SPX', 'KAITO',
  'AIXBT', 'UNI', 'COMP', 'YFI', 'ZRO',
])
const BASE_POPULAR_SYMBOLS = new Set(['ETH', 'WETH', 'USDC', 'USDbC', 'DAI', 'cbETH', 'cbBTC', 'AERO'])

// Full Base (8453) catalog: native ETH (sentinel) + the pinned generated list.
// `suggested`/`popular` flag the curated subset shown by default; the rest is the
// searchable long tail (all of it renders the verified ✓ on Base).
const BASE_FULL: ChainToken[] = [
  { address: NATIVE_ETH, symbol: 'ETH', name: 'Ethereum', decimals: 18, logoURI: ETH_LOGO, popular: true, suggested: true },
  ...GENERATED_TOKEN_CATALOG[8453].map((t): ChainToken => ({
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    // [token-selector-ux] Core majors → bundled local asset (no 404). Long tail →
    // DefiLlama's chainId-aware CDN (8453), which serves Base logos the old generated
    // logoURI (mainnet-keyed 1inch / dead optimism mirrors) frequently 404'd on Base.
    logoURI: CORE_LOCAL_LOGO[t.symbol] ?? logo(t.address, 8453),
    popular: BASE_POPULAR_SYMBOLS.has(t.symbol),
    suggested: BASE_SUGGESTED_SYMBOLS.has(t.symbol),
  })),
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
  // [SPRINT-9Y] Base default view = the curated "Suggested" subset of the full
  // catalog. The long tail stays reachable via getSearchCatalog / getFullCatalog.
  8453: BASE_FULL.filter((t) => t.suggested),
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
  if (['USDC', 'USDT', 'DAI', 'USDbC', 'USDe', 'FRAX', 'LUSD', 'EURC'].includes(symbol)) return 'Stablecoin'
  if (symbol === 'cbETH' || symbol === 'wstETH' || symbol === 'rETH') return 'Liquid Staking'
  if (symbol.includes('BTC')) return 'Wrapped BTC'
  // [SPRINT-9Y] light grouping for the curated Base suggested view (cosmetic only).
  if (['AERO', 'MORPHO', 'WELL', 'UNI', 'COMP', 'YFI'].includes(symbol)) return 'DeFi'
  if (['VIRTUAL', 'AIXBT', 'KAITO'].includes(symbol)) return 'AI & Data'
  if (['DEGEN', 'TOSHI', 'MOG', 'SPX'].includes(symbol)) return 'Memecoin'
  return 'Other'
}

/**
 * The chain's catalog as the rich `Token` type the TokenSelector renders.
 * chainId 1 returns the full mainnet DEFAULT_TOKENS unchanged; other chains map
 * their ChainToken list with an inferred category.
 */
export function getChainTokenList(chainId: number): Token[] {
  if (chainId === 1) return DEFAULT_TOKENS
  return (CHAIN_TOKENS[chainId] ?? []).map(chainTokenToToken)
}

// [SPRINT-9Y] Map a ChainToken to the rich Token the selector renders.
function chainTokenToToken(t: ChainToken): Token {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    logoURI: t.logoURI,
    category: inferCategory(t.symbol),
  }
}

// Pinned mainnet long tail = generated chain-1 list minus what DEFAULT_TOKENS already
// curates (DEFAULT_TOKENS wins, so existing entries stay byte-identical).
const MAINNET_DEFAULT_ADDR = new Set(DEFAULT_TOKENS.map((t) => t.address.toLowerCase()))
const MAINNET_LONGTAIL: Token[] = GENERATED_TOKEN_CATALOG[1]
  .filter((t) => !MAINNET_DEFAULT_ADDR.has(t.address.toLowerCase()))
  .map(chainTokenToToken)

// Precomputed full catalogs (stable references → cheap memoisation downstream).
const MAINNET_FULL: Token[] = [...DEFAULT_TOKENS, ...MAINNET_LONGTAIL]
const BASE_FULL_TOKENS: Token[] = BASE_FULL.map(chainTokenToToken)

/**
 * [SPRINT-9Y] The FULL pinned catalog for a chain (curated + long tail), as Token[].
 * Backs search and the verified-✓ badge. Excludes user-imported custom tokens (those
 * stay ⚠). chainId 1 = DEFAULT_TOKENS ∪ Uniswap long tail; 8453 = Base full catalog.
 */
export function getFullCatalog(chainId: number): Token[] {
  if (chainId === DEFAULT_CHAIN_ID) return MAINNET_FULL
  if (chainId === 8453) return BASE_FULL_TOKENS
  return getChainTokenList(chainId)
}

/**
 * [SPRINT-9Y] What the TokenSelector search filters over: the full pinned catalog plus
 * any custom tokens imported ON THIS chain (chain-scoped, 9P). Returns the stable
 * catalog reference unchanged when there are no custom tokens for the chain.
 */
export function getSearchCatalog(chainId: number): Token[] {
  const base = getFullCatalog(chainId)
  const custom = getCustomTokens().filter((t) => (t.chainId ?? DEFAULT_CHAIN_ID) === chainId)
  if (custom.length === 0) return base
  const seen = new Set(base.map((t) => t.address.toLowerCase()))
  const extra = custom.filter((t) => !seen.has(t.address.toLowerCase()))
  return extra.length === 0 ? base : [...base, ...extra]
}

// Verified-✓ membership: O(1) lowercase-address lookups over the pinned catalogs.
const MAINNET_CATALOG_ADDR = new Set(GENERATED_TOKEN_CATALOG[1].map((t) => t.address.toLowerCase()))
const BASE_CATALOG_ADDR = new Set(BASE_FULL.map((t) => t.address.toLowerCase()))

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

/**
 * [SPRINT-9P] Chain-scoped token lookup for the import early-return: the chain's
 * catalog first, then custom tokens imported ON THAT chain. A token imported on
 * Base never resolves on mainnet (and vice-versa); the same address can be a
 * different token per chain. chainId 1 stays byte-identical for mainnet-only use.
 */
export function findChainToken(address: string, chainId: number): Token | null {
  const addr = address.toLowerCase()
  // [SPRINT-9Y] match against the FULL catalog (not just the suggested set) so a pasted
  // long-tail catalog address resolves to the verified ✓ token instead of re-importing.
  const inCatalog = getFullCatalog(chainId).find((t) => t.address.toLowerCase() === addr)
  if (inCatalog) return inCatalog
  const custom = getCustomTokens().find(
    (t) => t.address.toLowerCase() === addr && (t.chainId ?? DEFAULT_CHAIN_ID) === chainId,
  )
  return custom ?? null
}

/**
 * [SPRINT-9P] Verified-badge auto-detect, chain-aware. Mainnet keeps
 * `findTokenByAddress` verbatim (byte-identical); other chains verify against
 * that chain's CATALOG, so the Base catalog (WETH/USDC/DAI/cbETH/USDbC) shows ✓
 * while genuinely imported tokens keep the ⚠.
 */
export function isVerifiedToken(address: string, chainId: number): boolean {
  const addr = address.toLowerCase()
  // [SPRINT-9Y] Verified ✓ = membership in the chain's FULL pinned catalog (curated +
  // long tail). Mainnet keeps findTokenByAddress (DEFAULT_TOKENS + customs, byte-identical)
  // and OR-s in the Uniswap long tail. Base checks its full catalog. Genuine imports
  // (not in any list) stay ⚠. Other chains keep the existing suggested-set behaviour.
  if (chainId === DEFAULT_CHAIN_ID) return !!findTokenByAddress(address) || MAINNET_CATALOG_ADDR.has(addr)
  if (chainId === 8453) return BASE_CATALOG_ADDR.has(addr)
  return !!getChainToken(address, chainId)
}

/**
 * [SPRINT-9P] Chain-aware block-explorer token URL (etherscan.io / basescan.org).
 * Falls back to mainnet's explorer for an unknown chain rather than throwing.
 */
export function explorerTokenUrl(address: string, chainId: number): string {
  return `${explorerBase(chainId)}/token/${address}`
}

/** [SPRINT-9S S3] Chain-aware explorer base (etherscan.io ↔ basescan.org), mainnet-default. */
function explorerBase(chainId: number): string {
  try {
    return getChainConfig(chainId).blockExplorer
  } catch {
    return 'https://etherscan.io' // unsupported chain — default to mainnet explorer
  }
}

/** [SPRINT-9S S3] Chain-aware transaction explorer URL (etherscan.io ↔ basescan.org). */
export function explorerTxUrl(txHash: string, chainId: number): string {
  return `${explorerBase(chainId)}/tx/${txHash}`
}

/** [SPRINT-9S S3] Chain-aware address explorer URL (etherscan.io ↔ basescan.org). */
export function explorerAddressUrl(address: string, chainId: number): string {
  return `${explorerBase(chainId)}/address/${address}`
}
