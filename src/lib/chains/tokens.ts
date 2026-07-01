/**
 * [P221 / ADR-009 / SPRINT-9Y / CHORE-TOKEN-CATALOG-PIPELINE] Per-chain token catalog.
 *
 * Mainnet (chainId 1) keeps DEFAULT_TOKENS (src/lib/tokens.ts) as the curated view; the
 * long tail and BOTH chains' verified state come from the CROSS-VERIFIED generated
 * catalogs (src/config/generated/token-catalog.<chainId>.json via
 * token-catalog.generated.ts, built by `npm run tokens:sync`): >=2 independent sources
 * agreeing on the (chainId, EIP-55 address) + a catalog-guard PASS. Every address is
 * sourced + validated, NEVER hand-typed.
 *
 * Two layers (Matcha-style, SPRINT-9Y):
 *  - getChainTokenList / getPopularTokens → the curated "Suggested" set shown by
 *    default (~20-30 majors), categorised.
 *  - getFullCatalog / getSearchCatalog → the full generated catalog used by search
 *    and the ✓ badge.
 *
 * Verified ✓ is a REAL per-token field now (verified + sources from the pipeline) —
 * catalog membership does NOT imply ✓ (unverified curated seeds show ⚠ honestly), and
 * session imports are NEVER ✓ (the old mainnet quirk where an import turned ✓ is gone).
 *
 * Logos: core majors point to bundled local assets in public/tokens/ (validated, no
 * 404); the long tail uses our read-only /api/token-logo route, which resolves
 * CoinGecko's comprehensive per-chain list server-side first (near-universal real logos)
 * and falls back to DefiLlama by-address. The UI's generated-initials avatar stays the
 * FINAL onError fallback. Native ETH uses the local /tokens/eth.png asset. The generated
 * logoURIs are exactly those two forms (both CSP 'self') — enforced by
 * token-catalog-json.test.ts.
 */
import { DEFAULT_TOKENS, getCustomTokens, type Token, type TokenCategory } from '@/lib/tokens'
import { DEFAULT_CHAIN_ID, getChainConfig } from '@/lib/chains/registry'
import { GENERATED_TOKEN_CATALOG, type GeneratedToken } from './token-catalog.generated'

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
  /** [CHORE-TOKEN-CATALOG-PIPELINE] Real cross-verification flag from the pipeline. */
  verified?: boolean
  /** Sources that agreed on this (chainId, address) at build time. */
  sources?: string[]
  /** Pipeline-resolved category (curated > overrides > heuristic). */
  category?: TokenCategory
}

/** [SPRINT-9Y] Max search results rendered at once — keeps a broad query snappy. */
export const SEARCH_RESULT_LIMIT = 80

// [CHORE-TOKEN-CATALOG-PIPELINE] Long-tail logo URLs (the read-only /api/token-logo
// route: CoinGecko-first server-side, DefiLlama fallback, keyed by chainId + LOWERCASE
// address) are now BAKED into the generated catalog by the pipeline's logoFor — same
// byte format as before, so <TokenLogo> keeps deduping its candidate chain.

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

// [SPRINT-9Y] Base curated "Suggested" majors shown by default (no search). The
// SYMBOLS are a curation choice; the ADDRESSES come only from the validated
// generated catalog (token-catalog.generated.ts) — never hand-typed.
const BASE_SUGGESTED_SYMBOLS = new Set([
  'ETH', 'WETH', 'USDC', 'USDbC', 'USDT', 'DAI', 'EURC', 'cbETH', 'cbBTC', 'AERO',
  'VIRTUAL', 'DEGEN', 'TOSHI', 'MORPHO', 'WELL', 'ZORA', 'MOG', 'SPX', 'KAITO',
  'AIXBT', 'UNI', 'COMP', 'YFI', 'ZRO',
])
const BASE_POPULAR_SYMBOLS = new Set(['ETH', 'WETH', 'USDC', 'USDbC', 'DAI', 'cbETH', 'cbBTC', 'AERO'])

const KNOWN_CATEGORIES = new Set<TokenCategory>([
  'Native', 'Stablecoin', 'Wrapped BTC', 'Liquid Staking', 'DeFi',
  'L2 & Infrastructure', 'AI & Data', 'Memecoin', 'Gaming & Metaverse',
  'Gold', 'Stocks', 'Other', 'Imported',
])

// Pipeline category, treated as advisory: 'Other' means "no curated opinion", so we
// return undefined and let the runtime inferCategory heuristic refine it (review finding:
// trusting the pipeline's 'Other' verbatim collapsed the Base selector grouping).
function generatedCategory(t: GeneratedToken): TokenCategory | undefined {
  if (!KNOWN_CATEGORIES.has(t.category as TokenCategory) || t.category === 'Other') return undefined
  return t.category as TokenCategory
}

// Case-insensitive symbol-set membership: the pipeline's consensus casing follows the
// on-chain symbol (e.g. Base "Mog", not "MOG"), so curation sets must not be casing-bound
// (review finding: the Mog chip silently dropped from the suggested set).
const upper = (set: Set<string>) => new Set([...set].map((s) => s.toUpperCase()))
const BASE_SUGGESTED_UPPER = upper(BASE_SUGGESTED_SYMBOLS)
const BASE_POPULAR_UPPER = upper(BASE_POPULAR_SYMBOLS)

// Full Base (8453) catalog — straight from the cross-verified generated catalog (which
// includes the native-ETH sentinel row and CSP-'self' logoURIs: bundled core assets or
// the /api/token-logo route). `suggested`/`popular` flag the curated subset shown by
// default; the rest is the searchable long tail with REAL per-token verified state.
const BASE_FULL: ChainToken[] = GENERATED_TOKEN_CATALOG[8453].map((t): ChainToken => ({
  address: t.address,
  symbol: t.symbol,
  name: t.name,
  decimals: t.decimals,
  logoURI: CORE_LOCAL_LOGO[t.symbol] ?? t.logoURI,
  popular: BASE_POPULAR_UPPER.has(t.symbol.toUpperCase()),
  suggested: BASE_SUGGESTED_UPPER.has(t.symbol.toUpperCase()),
  verified: t.verified,
  sources: t.sources,
  category: generatedCategory(t),
}))

function toChainToken(t: Token): ChainToken {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    logoURI: t.logoURI,
    popular: MAINNET_POPULAR.has(t.symbol),
    verified: t.verified,
    sources: t.sources,
    category: t.category,
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
    category: t.category ?? inferCategory(t.symbol),
    verified: t.verified,
    sources: t.sources,
  }
}

// [CHORE-TOKEN-CATALOG-PIPELINE] Real per-token verification, straight from the generated
// catalogs: (chainId, lowercase address) → {verified, sources}.
const GENERATED_BY_ADDR: Record<number, Map<string, GeneratedToken>> = Object.fromEntries(
  Object.entries(GENERATED_TOKEN_CATALOG).map(([cid, list]) => [
    Number(cid),
    new Map(list.map((t) => [t.address.toLowerCase(), t])),
  ]),
)

// Mainnet long tail = generated chain-1 catalog minus what DEFAULT_TOKENS already curates
// (DEFAULT_TOKENS wins on metadata/ordering; verified/sources come from the pipeline).
const MAINNET_DEFAULT_ADDR = new Set(DEFAULT_TOKENS.map((t) => t.address.toLowerCase()))
const MAINNET_LONGTAIL: Token[] = GENERATED_TOKEN_CATALOG[1]
  .filter((t) => !MAINNET_DEFAULT_ADDR.has(t.address.toLowerCase()))
  .map((t): Token => ({
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    logoURI: CORE_LOCAL_LOGO[t.symbol] ?? t.logoURI,
    category: generatedCategory(t) ?? inferCategory(t.symbol),
    verified: t.verified,
    sources: t.sources,
  }))

// DEFAULT_TOKENS annotated with the pipeline's verified/sources (the hand list keeps its
// metadata/order; a curated entry the pipeline could NOT verify stays honestly ⚠).
const MAINNET_CURATED: Token[] = DEFAULT_TOKENS.map((t) => {
  const g = GENERATED_BY_ADDR[1]?.get(t.address.toLowerCase())
  return { ...t, verified: g?.verified === true, sources: g?.sources }
})

// Precomputed full catalogs (stable references → cheap memoisation downstream).
const MAINNET_FULL: Token[] = [...MAINNET_CURATED, ...MAINNET_LONGTAIL]
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
  // Case-insensitive symbol match: the pipeline's consensus casing follows the on-chain
  // symbol per chain (mainnet 'MOG' ↔ Base 'Mog' are the same asset).
  const sym = token.symbol.toLowerCase()
  const match = getChainTokenList(chainId).find(
    (t) => t.symbol.toLowerCase() === sym && t.address.toLowerCase() !== token.address.toLowerCase(),
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
 * [SPRINT-9P → CHORE-TOKEN-CATALOG-PIPELINE] Verified-badge auto-detect, chain-aware.
 *
 * ✓ now reads the REAL per-token `verified` field persisted by the catalog pipeline
 * (>=2 independent sources agreed on this (chainId, EIP-55 address) AND the catalog
 * guard passed it on-chain) — NOT catalog membership. Consequences:
 *  - an unverified curated seed in the catalog shows the honest ⚠;
 *  - session imports are NEVER ✓ (fixes the 9P-era mainnet quirk where an imported
 *    token flipped to ✓ because findTokenByAddress scanned the custom-token cache);
 *  - chains without a generated catalog have no verified tokens (fail-closed).
 */
export function isVerifiedToken(address: string, chainId: number): boolean {
  return GENERATED_BY_ADDR[chainId]?.get(address.toLowerCase())?.verified === true
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
