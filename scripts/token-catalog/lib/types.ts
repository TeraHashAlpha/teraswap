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
  | 'arbitrumBridge' // OffchainLabs' canonical Arbitrum bridged-token list (Arbitrum only)
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

/** Market signal for one (chainId, address). Any field may be missing. */
export interface MarketSignal {
  /** 24h volume in USD (CoinGecko /coins/markets total_volume), when resolvable. */
  volume24hUsd?: number
  /** Which source supplied volume24hUsd — provenance for the emitted catalog row. */
  volumeSource?: SourceId
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
  /** [feat/catalog-single-source-volume] Set only when the candidate was admitted on ONE source
   *  via the 7-day volume rule — carried through to the emitted CatalogRow. */
  admission?: SingleSourceAdmission
}

/**
 * [feat/catalog-single-source-volume] Provenance of a token admitted on a single source because
 * its 24h USD volume cleared the floor on EACH of the last `days` complete days. Emitted on the
 * catalog row (optional key — absent on every two-source row).
 */
export interface SingleSourceAdmission {
  rule: 'single-source-volume'
  /** The per-day 24h USD volumes, oldest → newest, exactly `days` entries. */
  dailyVolumeUsd: number[]
  minDailyVolumeUsd: number
  days: number
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
  /** [fix/token-search-ranking-squatting] 24h volume in USD, when a source resolved one.
   *  NULL (never 0) when nothing resolved — a coerced 0 would outrank real zero-liquidity
   *  squatters as "worse than worst", sinking a token we simply have no data for. */
  volume24hUsd: number | null
  /** Which source supplied volume24hUsd. Null exactly when volume24hUsd is null. */
  volumeSource: SourceId | null
  /** ISO date this build's volume snapshot was taken. Null exactly when volume24hUsd is null. */
  volumeFetchedAt: string | null
  /** [feat/catalog-single-source-volume] Present only on rows admitted on ONE source via the
   *  7-day volume rule (verified:true there means volume + on-chain guard, not >=minSources). */
  admission?: SingleSourceAdmission
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
  /** [feat/catalog-single-source-volume] Set on an 'insufficient-sources' rejection of a
   *  single-source candidate that WAS evaluated by the volume rule. 'below-floor' = at least one
   *  day under the floor; 'fetch-failed' = history unavailable (fail-closed). The reason stays
   *  'insufficient-sources' so retainFlakySeeds keeps treating it as a vote shortfall. */
  singleSource?: 'below-floor' | 'fetch-failed'
}

/**
 * [fix/token-search-ranking-squatting Task 3] A previously-verified (>=2-source agreement)
 * catalog row kept this run even though it lost the vote(s) of a source that failed to
 * report ANYTHING this run (rate limit / outage) — never a source that reported fine but
 * simply stopped listing the token (that is real signal, not a flake). New candidates
 * (no previous row) are never retained.
 */
export interface RetainedSeed {
  address: `0x${string}`
  symbol: string
  /** Sources that contributed to the previous agreement but returned nothing this run. */
  missingSources: SourceId[]
}

/**
 * [fix/catalog-continuity-drop-on-trust-loss] A continuity seed (previous-catalog row, NOT
 * hand-curated and NOT a core) dropped this run because its fresh verdict says the address
 * left every trusted list AND it no longer reaches `minSources` external agreement. Reported,
 * never silent — see CONTINUITY_DROP_ON_VERIFIED_TRUST_LOSS in build-chain.ts.
 */
export interface TrustLostSeed {
  address: `0x${string}`
  symbol: string
  /** Human-readable cause, e.g. "not in any trusted list, 1 external vote < 2 required". */
  reason: string
}

export interface SymbolConflict {
  chainId: number
  symbol: string
  /** null = unresolvable tie — the whole group was rejected (needs curation). */
  kept: `0x${string}` | null
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
  /** [feat/catalog-single-source-volume] Default single-source admission rule (see SingleSourceConfig). */
  singleSource: SingleSourceConfig
  /** Per-chain overrides, merged over `singleSource` (partial — unset keys inherit the default). */
  singleSourceByChain?: Record<number, Partial<SingleSourceConfig>>
}

/**
 * [feat/catalog-single-source-volume] Admit a token present in exactly ONE source (CoinGecko) when
 * its 24h USD volume was >= minDailyVolumeUsd on EACH of the last `days` complete UTC days.
 * Two-source tokens never touch this rule. See docs/Runbooks/token-catalog-single-source-volume.md.
 */
export interface SingleSourceConfig {
  enabled: boolean
  minDailyVolumeUsd: number
  days: number
  /** true = every one of the `days` values must clear the floor (the owner decision). */
  requireEveryDay: boolean
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
  /** ISO date stamped onto every row's volumeFetchedAt (when volume24hUsd is non-null). */
  builtAt: string
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
  /** [fix/token-search-ranking-squatting Task 3] Seeds kept despite this run's vote drop
   *  because the drop is attributable to a source outage, not delisting. */
  retained: RetainedSeed[]
  /** [fix/catalog-continuity-drop-on-trust-loss] Continuity seeds DROPPED because they lost
   *  their trusted-list membership and their external agreement (no freeze, no silence). */
  trustLost: TrustLostSeed[]
  /** [feat/catalog-single-source-volume] Run summary for the single-source volume rule. */
  singleSource: SingleSourceReport
}

/** One evaluated single-source candidate — the dry-run / run-summary record. */
export interface SingleSourceEvaluation {
  address: `0x${string}`
  symbol: string
  outcome: 'admitted' | 'below-floor' | 'fetch-failed'
  dailyVolumeUsd?: number[]
  medianUsd?: number
}

export interface SingleSourceReport {
  enabled: boolean
  /** Single-source CoinGecko candidates before any volume check. */
  candidates: number
  /** Skipped without a history call: current 24h volume unknown or under the floor. */
  prefiltered: number
  /** History calls attempted (one token per call). */
  evaluated: number
  admitted: number
  belowFloor: number
  /** History unavailable → NOT admitted this run (fail-closed). */
  fetchFailed: number
  /** Admitted by the rule but dropped by the per-run new-token cap (ordered by 7-day median desc). */
  deferred: Array<{ address: `0x${string}`; symbol: string; medianUsd: number }>
  evaluations: SingleSourceEvaluation[]
}

export class CoreTokenValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoreTokenValidationError'
  }
}

/**
 * [fix/catalog-trust-loss-means-previously-verified — outage circuit breaker] Per-source raw
 * fetched-list size (step-1 `entries.length`, BEFORE seeds/merge), keyed by SourceId. Recorded
 * into the committed catalog's `counts.sourceCounts` each run so the NEXT run can detect a
 * source silently going dark (rate limit / vendor outage / a bad response the source itself
 * doesn't error on) instead of the build quietly shipping a mass drop.
 */
export type SourceCounts = Partial<Record<SourceId, number>>

/**
 * [fix/catalog-trust-loss-means-previously-verified — outage circuit breaker] Thrown fail-closed
 * when either breaker trips (see build-chain.ts SOURCE_OUTAGE_RATIO_THRESHOLD /
 * TRUST_LOSS_DROP_ABS_FLOOR / TRUST_LOSS_DROP_PCT_THRESHOLD): a source's fetched-list size
 * collapsed relative to the previous run, or an implausible number of continuity seeds lost
 * trust in one run. Either shape looks like a source outage, not a real correction — the build
 * refuses to write a catalog or open a PR on it, the same fail-closed contract as
 * CoreTokenValidationError for a core token.
 */
export class OutageSuspectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutageSuspectedError'
  }
}
