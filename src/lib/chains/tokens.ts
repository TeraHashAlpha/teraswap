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
import { NATIVE_ETH } from '@/lib/constants'
import { DEFAULT_CHAIN_ID, getChainConfig, getWrappedNative } from '@/lib/chains/registry'
import { GENERATED_TOKEN_CATALOG, type GeneratedToken } from './token-catalog.generated'
import { isStablecoinCategorySymbol } from './stablecoins'

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
export const CORE_LOCAL_LOGO: Record<string, string> = {
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

// [CHORE-ARBITRUM-TOKEN-CATALOG-PIPELINE] Arbitrum (42161) — now the SAME multi-source
// cross-verified pipeline as Base (uniswap / coingecko / 1inch / trustwallet /
// arbitrumBridge[Arbitrum-only, the canonical OffchainLabs bridged-token list] + the
// DefiLlama market signal; >=2-source agreement; catalog-guard PASS — see
// scripts/token-catalog/build.ts). Supersedes the CHORE-47C-ARBITRUM-CATALOG single-source
// manifest pipeline (arbitrum-catalog.ts / arbitrum-catalog.generated.ts /
// scripts/generate-arbitrum-catalog.mjs) — kept, not deleted, and marked superseded there
// (repo convention, never delete). The manifest's 5 on-chain-verified launch tokens are now
// CORE_TOKENS[42161] (scripts/token-catalog/lib/config.ts): ALWAYS present, still
// guard-validated, at the EXACT addresses docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json
// verified — a source outage can never drop them, same guarantee as before. Native ETH is no
// longer special-cased here either: it comes through as CORE_TOKENS[42161]'s native sentinel
// row, exactly like mainnet/Base (assembleCatalog step 4). Chain stays DARK (feeCollector env
// unset, isChainActive(42161) === false) — populating the full catalog is additive only.
//
// Suggested-set rule (mirrors BASE_SUGGESTED_SYMBOLS): the 5 CHORE-47C launch/core tokens
// (ETH, WETH, USDC, USDT, DAI, WBTC) ∪ Arbitrum-native/long-tail majors picked from the
// pipeline's qualified, guard-passed candidates (tokens:sync run 2026-09-12, 227 tokens) —
// ARB (the chain's own governance token), GMX, PENDLE, MAGIC, LINK, UNI, GRT, LDO, CRV, WOO,
// SUSHI, BAL, AAVE, COMP, YFI. Every symbol here was checked present in the generated
// token-catalog.42161.json before picking it (the pipeline's growth-cap ranking currently
// ties on vote count and breaks alphabetically — volume24hUsd is never populated by any
// fetcher, a pre-existing pipeline gap shared with Base/mainnet, not introduced here — so a
// plausible-sounding symbol can miss the cap; see PR feedback). Symbols are a curation
// choice; addresses come only from the validated generated catalog — never hand-typed.
const ARBITRUM_SUGGESTED_SYMBOLS = new Set([
  'ETH', 'WETH', 'USDC', 'USDC.e', 'USDT', 'DAI', 'WBTC',
  'ARB', 'GMX', 'PENDLE', 'MAGIC', 'LINK', 'UNI', 'GRT', 'LDO', 'CRV', 'WOO', 'SUSHI', 'BAL', 'AAVE', 'COMP', 'YFI',
])
const ARBITRUM_POPULAR_SYMBOLS = new Set(['ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'WBTC', 'ARB'])
const ARBITRUM_SUGGESTED_UPPER = upper(ARBITRUM_SUGGESTED_SYMBOLS)
const ARBITRUM_POPULAR_UPPER = upper(ARBITRUM_POPULAR_SYMBOLS)

const ARBITRUM_FULL: ChainToken[] = GENERATED_TOKEN_CATALOG[42161].map((t): ChainToken => ({
  address: t.address,
  symbol: t.symbol,
  name: t.name,
  decimals: t.decimals,
  logoURI: CORE_LOCAL_LOGO[t.symbol] ?? t.logoURI,
  popular: ARBITRUM_POPULAR_UPPER.has(t.symbol.toUpperCase()),
  suggested: ARBITRUM_SUGGESTED_UPPER.has(t.symbol.toUpperCase()),
  verified: t.verified,
  sources: t.sources,
  category: generatedCategory(t),
}))

export const CHAIN_TOKENS: Record<number, ChainToken[]> = {
  1: DEFAULT_TOKENS.map(toChainToken),
  // [SPRINT-9Y] Base default view = the curated "Suggested" subset of the full
  // catalog. The long tail stays reachable via getSearchCatalog / getFullCatalog.
  8453: BASE_FULL.filter((t) => t.suggested),
  42161: ARBITRUM_FULL.filter((t) => t.suggested),
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

function inferCategory(symbol: string, chainId: number): TokenCategory {
  if (symbol === 'ETH' || symbol === 'WETH') return 'Native'
  // [CHORE-STABLECOIN-CONSTANT] Chain-keyed membership (USD stables ∪ EUR-pegged extras).
  if (isStablecoinCategorySymbol(symbol, chainId)) return 'Stablecoin'
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
  return (CHAIN_TOKENS[chainId] ?? []).map((t) => chainTokenToToken(t, chainId))
}

// [SPRINT-9Y] Map a ChainToken to the rich Token the selector renders.
// [CHORE-STABLECOIN-CONSTANT] Carries the chainId so the category fallback is chain-keyed.
function chainTokenToToken(t: ChainToken, chainId: number): Token {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    logoURI: t.logoURI,
    category: t.category ?? inferCategory(t.symbol, chainId),
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

// [CHORE-ARBITRUM-TOKEN-CATALOG-PIPELINE] Arbitrum (42161) now HAS a generated pipeline
// catalog (src/config/generated/token-catalog.42161.json via GENERATED_TOKEN_CATALOG[42161]),
// so the generic population above already covers it — no more per-chain override needed
// (superseded the CHORE-ARBITRUM-UI-POLISH seed that plugged this gap for the old
// manifest-only catalog).

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
    category: generatedCategory(t) ?? inferCategory(t.symbol, 1),
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
const BASE_FULL_TOKENS: Token[] = BASE_FULL.map((t) => chainTokenToToken(t, 8453))
const ARBITRUM_FULL_TOKENS: Token[] = ARBITRUM_FULL.map((t) => chainTokenToToken(t, 42161))

/**
 * [SPRINT-9Y] The FULL pinned catalog for a chain (curated + long tail), as Token[].
 * Backs search and the verified-✓ badge. Excludes user-imported custom tokens (those
 * stay ⚠). chainId 1 = DEFAULT_TOKENS ∪ Uniswap long tail; 8453/42161 = the chain's full
 * generated-pipeline catalog (CHAIN_TOKENS holds only the curated "Suggested" subset for
 * both, so a pasted long-tail address still resolves to its verified ✓ token here instead
 * of re-importing — same reason BASE_FULL_TOKENS bypasses CHAIN_TOKENS below).
 */
export function getFullCatalog(chainId: number): Token[] {
  if (chainId === DEFAULT_CHAIN_ID) return MAINNET_FULL
  if (chainId === 8453) return BASE_FULL_TOKENS
  if (chainId === 42161) return ARBITRUM_FULL_TOKENS
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
 * [fix/token-search-ranking] Ranks token search matches so an EXACT case-insensitive
 * symbol match (e.g. "USDC") outranks a substring match (e.g. "aUSDC", "waEthUSDC"),
 * and among equally-tiered matches, more `sources` (catalog-pipeline cross-verification
 * count) ranks higher. Both signals come from the catalog rows themselves — never a
 * hardcoded symbol or address list, so any lookalike is ranked correctly by construction.
 * Does not filter: every match stays in the returned array, just reordered.
 */
export function rankSearchMatches<T extends { symbol: string; sources?: string[] }>(
  matches: T[],
  query: string,
): T[] {
  const q = query.toLowerCase()
  return [...matches].sort((a, b) => {
    const aExact = a.symbol.toLowerCase() === q
    const bExact = b.symbol.toLowerCase() === q
    if (aExact !== bExact) return aExact ? -1 : 1
    const aSources = a.sources?.length ?? 0
    const bSources = b.sources?.length ?? 0
    return bSources - aSources
  })
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
 * [fix/dca-native-out-signs-weth] The token EXACTLY as it can be committed to a signed order
 * struct — THE single native→wrapped resolution point for a conditional order's legs.
 *
 * The native-ETH sentinel `0xEeee…EEeE` is not a token; it is a convention, and it has no code on
 * any chain (`eth_getCode` → "0x" on both Ethereum mainnet and Base, re-derived 2026-09-09). An
 * order struct carrying it can never execute:
 *
 *   - TeraSwapOrderExecutorV3.sol:567 snapshots `IERC20(order.tokenOut).balanceOf(address(this))`
 *     BEFORE the swap and :579 re-reads it after, both unconditional and both ahead of every
 *     delivery branch. Against a codeless address Solidity's extcodesize guard reverts with empty
 *     revert data, so EVERY fill reverts — for a DCA, on every scheduled buy until expiry.
 *   - The executor's fair-value registry has no entry for the sentinel either
 *     (`tokenUsdFeeds(0xEeee…)` → `registered: false` on the live Base V3), so it cannot even be
 *     priced, while the WRAPPED native is registered.
 *   - The contract's own "router returned native ETH → forward ETH to the owner" branch (V3:593)
 *     is keyed on `order.tokenOut == WETH`. Signing the WRAPPED address is therefore what BUYS the
 *     user native-ETH delivery; signing the sentinel forfeits it and reverts first regardless.
 *
 * Chain-aware through `getWrappedNative` (never a hardcoded address, never a hardcoded chain id),
 * and returns the catalog `Token` so the resolved leg carries the symbol/decimals/logo the user
 * sees — the caller must use this ONE value for both the signed struct and the screen, or the two
 * drift apart again.
 *
 * FAILS CLOSED: `null` when the chain's catalog has no wrapped-native entry, which callers already
 * treat as "no token selected". Falling back to the sentinel would re-create the unexecutable
 * order this function exists to prevent. A non-native token is returned untouched — this resolves
 * the sentinel and nothing else.
 */
export function resolveSignableToken(token: Token | null, chainId: number): Token | null {
  if (!token) return token
  if (token.address.toLowerCase() !== NATIVE_ETH.toLowerCase()) return token
  return findChainToken(getWrappedNative(chainId), chainId)
}

/**
 * [CHORE-DCA-DEFAULT-BUY-USDC] The chain's canonical USDC, catalog-resolved — never a hardcoded
 * address, never a hardcoded/branched chain id. Reads `getChainConfig(chainId).tokens.USDC` (the
 * one address the registry curates as canonical per chain — e.g. Arbitrum's entry is USDC-native,
 * deliberately excluding USDC.e) and resolves it to the full catalog `Token` via findChainToken.
 *
 * FAILS CLOSED to `null`, never to a wrong address: an unsupported chainId (getChainConfig throws)
 * or a supported chain whose registry entry has no `USDC` key both return null, which callers
 * already treat as "no default — leave the selector empty for the user to pick."
 */
export function getCanonicalUsdc(chainId: number): Token | null {
  let usdcAddress: `0x${string}` | undefined
  try {
    usdcAddress = getChainConfig(chainId).tokens.USDC
  } catch {
    return null
  }
  return usdcAddress ? findChainToken(usdcAddress, chainId) : null
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
