/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Shared types for the build-time token-catalog pipeline.
 *
 * The pipeline is: fetch (sources.ts) → normalize (SourceEntry) → merge by checksummed
 * address (Candidate) → cross-verify (source agreement + market signal) → on-chain
 * validate (symbol/decimals) → assemble (cores forced, seeds preserved) → emit the
 * committed per-chain JSON (src/config/generated/token-catalog.<chainId>.json).
 *
 * ANTI-SPOOFING INVARIANT: identity is the (chainId, EIP-55 address) pair — NEVER the
 * symbol. Same-symbol different-address entries are separate candidates and are never
 * merged; at most one may win inclusion per (chainId, symbol) (see resolveSymbolConflicts).
 */

export type SourceId =
  | 'curated' // repo-curated seed (DEFAULT_TOKENS / previous pinned catalog) — NOT an agreement vote
  | 'superchain'
  | 'uniswap'
  | 'coingecko'
  | 'oneinch'
  | 'trustwallet'
  | 'defillama'
  | 'native' // sentinel pseudo-source for native ETH (no ERC-20 contract to verify)

/** One token row as reported by one source, normalized. Address is EIP-55 checksummed. */
export interface SourceEntry {
  chainId: number
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  logoURI?: string
  source: SourceId
}

/** Market signal for one (chainId, address). Either field may be missing. */
export interface MarketSignal {
  /** 24h volume in USD (CoinGecko markets), when resolvable. */
  volume24hUsd?: number
  /** Spot price in USD (DefiLlama coins API). */
  priceUsd?: number
  /** DefiLlama price confidence in [0, 1]. */
  priceConfidence?: number
}

/** The merged view of one (chainId, address) across all sources that listed it. */
export interface Candidate {
  chainId: number
  address: `0x${string}`
  /** Distinct sources that listed this exact (chainId, address), in priority order. */
  sources: SourceId[]
  /** Consensus metadata (majority across sources; source-priority tiebreak). */
  symbol: string
  name: string
  decimals: number
  /** True when sources disagreed on decimals — on-chain is the arbiter, but we log it. */
  decimalsDisagree: boolean
  logoURI?: string
}

/**
 * Per-address outcome of routing a candidate THROUGH the existing catalog guard
 * (src/lib/chains/catalog-guard.ts auditChain + the shared verdict collector):
 *  - 'pass'         — no fatal finding for this address
 *  - 'fatal'        — at least one fatal finding (dead / identity / decimals / trusted-list / dup)
 *  - 'unverifiable' — the verdict has null on-chain signals (RPC unreachable) — cannot verify
 */
export interface GuardOutcome {
  status: 'pass' | 'fatal' | 'unverifiable'
  detail?: string
}

/** A pinned, fee/routing-critical token that must ALWAYS be present in the catalog. */
export interface CoreToken {
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  /** Native sentinel (no ERC-20 contract) — skips on-chain validation. */
  native?: boolean
}

/** A token already in the shipped catalog (DEFAULT_TOKENS / previous generated pin). */
export interface SeedToken {
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  category?: string
  logoURI?: string
}

/** One row of the emitted catalog JSON. */
export interface CatalogRow {
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  category: string
  logoURI: string
  /** REAL verified flag: source agreement + on-chain match. NOT mere membership. */
  verified: boolean
  /** Which sources agreed on this (chainId, address). */
  sources: SourceId[]
  /** Present + true only for the pinned core allowlist. */
  core?: boolean
}

export interface Rejection {
  chainId: number
  address: `0x${string}`
  symbol: string
  reason:
    | 'insufficient-sources'
    | 'insufficient-sources-low-liquidity'
    | 'missing-required-source'
    | 'guard-fatal'
    | 'guard-unverifiable'
    | 'symbol-conflict'
    | 'capped'
  detail?: string
}

export interface SymbolConflict {
  chainId: number
  symbol: string
  kept: `0x${string}`
  rejected: `0x${string}`[]
}

export interface PipelineConfig {
  chains: number[]
  /** Minimum distinct agreeing sources for inclusion. */
  minSources: number
  /** Agreement floor when the market signal is weak/unknown. */
  lowLiqMinSources: number
  /** 24h-volume floor (USD) under which a token is "low liquidity". */
  liquidityFloorUsd: number
  /** DefiLlama confidence floor that clears low-liquidity when volume is unknown. */
  defillamaConfidenceMin: number
  /** Cap on NEW (non-seed, non-core) tokens per chain; overflow is logged, never silent. */
  maxNewTokensPerChain: Record<number, number>
  /**
   * NEW (non-seed) tokens must count this source among their votes. Aligned with the
   * catalog-address-guard trusted-list gate (same CoinGecko per-chain list) so a token
   * added here can never immediately red that gate.
   */
  requiredSourceForNew: SourceId
  /** Canonical priority for symbol-conflict resolution + metadata tiebreaks (first wins). */
  sourcePriority: SourceId[]
}

/** Everything assembleCatalog needs for one chain. Keys are LOWERCASE addresses. */
export interface AssembleInput {
  chainId: number
  /** Candidates that passed cross-verification + symbol-conflict resolution. */
  qualified: Candidate[]
  /** Per-address outcome from the EXISTING catalog guard (reused, not reimplemented). */
  guard: Map<string, GuardOutcome>
  seeds: Map<string, SeedToken>
  cores: CoreToken[]
  market: Map<string, MarketSignal>
  config: PipelineConfig
  /** category resolver (seed category > overrides > heuristic > 'Other'). */
  categoryFor: (chainId: number, address: string, symbol: string) => string
  /** logo resolver — local core asset or /api/token-logo route (both CSP 'self'). */
  logoFor: (chainId: number, address: string, symbol: string) => string
}

/** One source fetch's normalized output. `market` carries `${chainId}:${addrLower}` keys. */
export interface SourceFetchResult {
  source: SourceId
  entries: SourceEntry[]
  market?: Map<string, MarketSignal>
  note?: string
}

export interface BuildReport {
  chainId: number
  included: number
  verified: number
  /** Seeds kept with verified:false (flagged, never silently dropped). */
  unverifiedSeeds: Array<{ address: `0x${string}`; symbol: string; reason: Rejection['reason'] }>
  rejections: Rejection[]
  conflicts: SymbolConflict[]
  /** New tokens dropped by maxNewTokensPerChain (logged — no silent caps). */
  capped: Array<{ address: `0x${string}`; symbol: string }>
}

export class CoreTokenValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoreTokenValidationError'
  }
}
