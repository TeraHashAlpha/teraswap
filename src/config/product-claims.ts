/**
 * Single module for user-facing product claims.
 *
 * Every count, chain list, and order-type availability string on a product
 * surface must be derived here — never typed as prose in a component.
 *
 * Source of truth:
 *   (a) integrated DEX source count = ADAPTER_REGISTRY.length minus the
 *       DISABLED_SOURCES entries present in the registry
 *       (a registry entry proves an adapter EXISTS, not that it can quote —
 *       DISABLED_SOURCES is the one place that tracks "never quotes";
 *       a file scan or filename blocklist would be one more hand-maintained fact)
 *   (b) chains that execute swaps = the chain registry
 *   (c) order-type availability = each type's launch flag (strict `'true'`)
 *   (d) Chainlink feed count per chain = listConfiguredFeedTokens() (direct + composed)
 *   (e) verification checks / thresholds = the constants that define them
 */

import { ADAPTER_REGISTRY } from '@/lib/adapters'
import {
  AGGREGATOR_META,
  CHAINLINK_MAX_STALENESS_SEC,
  DEPEG_DIVERGENCE_BLOCK,
  DEPEG_DIVERGENCE_WARN,
  DISABLED_SOURCES,
  PERMIT2_MAX_DEADLINE_SEC,
  PERMIT2_MAX_EXPIRATION_SEC,
  PRICE_DEVIATION_BLOCK,
  PRICE_DEVIATION_WARN,
  UNVERIFIED_SWAP_BLOCK_USD,
  UNVERIFIED_SWAP_WARN_USD,
  type AggregatorName,
} from '@/lib/constants'
import { CHAIN_CONFIGS, getSupportedChainIds } from '@/lib/chains/registry'
import { listConfiguredFeedTokens } from '@/lib/chains/chainlink-feeds'
import { DCA_CHAINS, isDcaLive } from '@/lib/dca-launch'

const SMALL_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
] as const

/** Mirror of isDcaLaunchEnabled / isLimitLaunchEnabled: only the exact literal `'true'`. */
function isLaunchFlagOn(value: string | undefined): boolean {
  return value === 'true'
}

export function spellCount(n: number): string {
  if (Number.isInteger(n) && n >= 0 && n < SMALL_WORDS.length) return SMALL_WORDS[n]
  return String(n)
}

export function capitalizeWord(word: string): string {
  if (word.length === 0) return word
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function formatChainList(names: readonly string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

/**
 * (a) Registry minus DISABLED_SOURCES. Never a parallel list: both inputs
 * already exist (ADAPTER_REGISTRY = what's built, DISABLED_SOURCES = what
 * never quotes), so the public count is their difference, not a third fact.
 */
const QUOTING_ADAPTERS = ADAPTER_REGISTRY.filter((a) => !DISABLED_SOURCES[a.name])

export const INTEGRATED_DEX_SOURCE_COUNT = QUOTING_ADAPTERS.length
export const INTEGRATED_DEX_SOURCE_NAMES: readonly string[] = QUOTING_ADAPTERS.map((a) => a.name)

/**
 * (a) per chain. The adapter registry exposes NO chain-support field today (an entry is
 * `{ name, fetchQuote, fetchSwapData }` — pinned by a test that fails the day that changes), so
 * every chain gets the global list. The parameter is accepted now so call sites are already
 * chain-shaped and the filter lands in one place once the registry can answer it.
 */
export function integratedSourcesFor(_chainId: number): readonly string[] {
  return INTEGRATED_DEX_SOURCE_NAMES
}

/**
 * Display labels (AGGREGATOR_META.label) for the same list — what a visitor reads, as opposed to
 * the registry ids ("cowswap", "uniswapv3") that INTEGRATED_DEX_SOURCE_NAMES carries.
 */
export const INTEGRATED_DEX_SOURCE_LABELS: readonly string[] = [
  ...new Set(
    INTEGRATED_DEX_SOURCE_NAMES.map((name) => AGGREGATOR_META[name as AggregatorName]?.label ?? name),
  ),
]

/** Claim string the registry proves: these adapters are integrated. */
export const INTEGRATED_DEX_SOURCES_CLAIM = `${INTEGRATED_DEX_SOURCE_COUNT} integrated DEX sources`

export const INTEGRATED_DEX_SOURCE_COUNT_WORDS = spellCount(INTEGRATED_DEX_SOURCE_COUNT)
export const INTEGRATED_DEX_SOURCE_COUNT_WORDS_CAP = capitalizeWord(INTEGRATED_DEX_SOURCE_COUNT_WORDS)

/** (b) Chains the registry actually lists as swap-capable configs. */
export const SWAP_CHAIN_IDS: readonly number[] = getSupportedChainIds()

export const SWAP_CHAINS: readonly { chainId: number; name: string; slug: string }[] =
  SWAP_CHAIN_IDS.map((chainId) => {
    const config = CHAIN_CONFIGS[chainId]
    return { chainId, name: config.name, slug: config.slug }
  })

export const SWAP_CHAIN_NAMES: readonly string[] = SWAP_CHAINS.map((c) => c.name)
export const SWAP_CHAIN_LIST_LABEL = formatChainList(SWAP_CHAIN_NAMES)

export const SITE_META_DESCRIPTION =
  `Maximum liquidity. Absolute protection. TeraSwap is an EVM meta-aggregator on ${SWAP_CHAIN_LIST_LABEL} that queries ${INTEGRATED_DEX_SOURCE_COUNT} liquidity sources to find the best swap rate — with multi-oracle price protection (Chainlink + DefiLlama), MEV-free execution via CoW Protocol, and a privacy proxy that hides your IP from all external services.`

export type OrderTypeId = 'instant' | 'dca' | 'limit' | 'takeProfit' | 'stopLoss'

/**
 * (c) Product-level availability from the launch flag, read at call time
 * (not module scope) so tests and runtime see the current env.
 *
 * Instant swaps have no launch flag — they are the live product.
 * Stop-Loss is deferred (v4 executor); the Limit flag does not enable it.
 */
export function isOrderTypeLive(type: OrderTypeId): boolean {
  switch (type) {
    case 'instant':
      return true
    case 'dca':
      return isLaunchFlagOn(process.env.NEXT_PUBLIC_DCA_ENABLED)
    case 'limit':
    case 'takeProfit':
      return isLaunchFlagOn(process.env.NEXT_PUBLIC_LIMIT_ENABLED)
    case 'stopLoss':
      return false
  }
}

export function orderTypeStatusLabel(type: OrderTypeId): 'Live' | 'Coming Soon' {
  return isOrderTypeLive(type) ? 'Live' : 'Coming Soon'
}

// ── (d) Chainlink feed count per chain ───────────────────────────────────────

/** Fraction → display percent: 0.02 → "2%", 0.015 → "1.5%". */
export function formatPercent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(2))}%`
}

export function chainNameFor(chainId: number): string {
  return CHAIN_CONFIGS[chainId]?.name ?? `chain ${chainId}`
}

let feedCountByChain: Map<number, number> | null = null

/**
 * Tokens with a configured Chainlink price source on `chainId`, direct + composed (+ preferred
 * direct, de-duplicated by token) — straight from the feed registries via
 * listConfiguredFeedTokens(). Not a typed number.
 */
export function chainlinkFeedCountFor(chainId: number): number {
  if (!feedCountByChain) {
    feedCountByChain = new Map()
    for (const { chainId: id } of listConfiguredFeedTokens()) {
      feedCountByChain.set(id, (feedCountByChain.get(id) ?? 0) + 1)
    }
  }
  return feedCountByChain.get(chainId) ?? 0
}

// ── (e) Verification stages / checks ─────────────────────────────────────────

export const VERIFICATION_STAGES = ['pre-trade', 'post-execution'] as const
export type VerificationStage = (typeof VERIFICATION_STAGES)[number]

export interface VerificationCheck {
  id: string
  stage: VerificationStage
  label: string
  /** File that DECLARES the constant behind the check (enforcement sites are not claimed here). */
  provedBy: string
}

/**
 * Post-execution shortfall tolerance. post-execution-validator.ts declares it as the module-private
 * `const WARNING_THRESHOLD = 0.02` in a server-only module (it imports kv + viem clients), so it
 * can be neither imported into a client bundle nor re-exported without editing that file. This is
 * the one slot that is typed here; product-claims.test.ts reads the validator source and fails
 * the day the two differ.
 */
export const POST_EXECUTION_SHORTFALL_WARN = 0.02

/**
 * The checks the in-repo constants prove. Each is a declared threshold, so the list and its
 * count cannot outgrow what the code defines; a check with no `provedBy` does not belong here.
 */
export const VERIFICATION_CHECKS: readonly VerificationCheck[] = [
  { id: 'chainlink-deviation', stage: 'pre-trade', label: 'Chainlink price deviation (warn / block)', provedBy: 'src/lib/constants.ts' },
  { id: 'chainlink-staleness', stage: 'pre-trade', label: 'Chainlink feed staleness limit', provedBy: 'src/lib/constants.ts' },
  { id: 'lst-depeg', stage: 'pre-trade', label: 'Liquid-staking depeg divergence (warn / block)', provedBy: 'src/lib/constants.ts' },
  { id: 'unverified-swap-gate', stage: 'pre-trade', label: 'Size gate on swaps without an independent price', provedBy: 'src/lib/constants.ts' },
  { id: 'permit2-caps', stage: 'pre-trade', label: 'Permit2 signature deadline and allowance expiry caps', provedBy: 'src/lib/constants.ts' },
  { id: 'post-execution-shortfall', stage: 'post-execution', label: 'Post-execution output vs expected', provedBy: 'src/lib/post-execution-validator.ts' },
]

export const VERIFICATION_STAGE_COUNT = VERIFICATION_STAGES.length
export const VERIFICATION_CHECK_COUNT = VERIFICATION_CHECKS.length
export const VERIFICATION_SUMMARY = `${VERIFICATION_STAGE_COUNT} stages · ${VERIFICATION_CHECK_COUNT} checks`

// ── (e) Threshold copy slots ─────────────────────────────────────────────────

export const PRICE_DEVIATION_WARN_PCT = formatPercent(PRICE_DEVIATION_WARN)
export const PRICE_DEVIATION_BLOCK_PCT = formatPercent(PRICE_DEVIATION_BLOCK)
export const DEPEG_DIVERGENCE_WARN_PCT = formatPercent(DEPEG_DIVERGENCE_WARN)
export const DEPEG_DIVERGENCE_BLOCK_PCT = formatPercent(DEPEG_DIVERGENCE_BLOCK)
export const POST_EXECUTION_SHORTFALL_WARN_PCT = formatPercent(POST_EXECUTION_SHORTFALL_WARN)
export const CHAINLINK_MAX_STALENESS_MIN = CHAINLINK_MAX_STALENESS_SEC / 60
export const UNVERIFIED_SWAP_WARN_USD_LABEL = `$${UNVERIFIED_SWAP_WARN_USD.toLocaleString('en-US')}`
export const UNVERIFIED_SWAP_BLOCK_USD_LABEL = `$${UNVERIFIED_SWAP_BLOCK_USD.toLocaleString('en-US')}`
export const PERMIT2_MAX_DEADLINE_MIN = PERMIT2_MAX_DEADLINE_SEC / 60
export const PERMIT2_MAX_EXPIRATION_HOURS = PERMIT2_MAX_EXPIRATION_SEC / 3600

/** "Prices older than 60 min are rejected" — a limit, not a polling cadence. */
export const CHAINLINK_STALENESS_CLAIM =
  `Prices older than ${CHAINLINK_MAX_STALENESS_MIN} min are rejected (feeds with a published heartbeat use a per-feed limit).`

// ── (f) Order-type copy slots ────────────────────────────────────────────────

/**
 * Chains where DCA is actually live right now: DCA_CHAINS (built for) filtered by isDcaLive
 * (flag + wired executor). Arbitrum stays out until its executor is wired, then appears here
 * with no copy edit. Read at call time so tests and runtime see the current env.
 */
export function dcaLiveChainNames(): readonly string[] {
  return DCA_CHAINS.filter((id) => isDcaLive(id)).map(chainNameFor)
}

/** "DCA (Base)" today; "DCA (Base, Arbitrum One)" once both executors are live; "DCA" if none. */
export function dcaFeatureTitle(): string {
  const names = dcaLiveChainNames()
  return names.length === 0 ? 'DCA' : `DCA (${names.join(', ')})`
}

/**
 * Delay on OrderExecutor config changes (router whitelist, executor whitelist, fund sweeps).
 * Stated by the owner and by DocsPage "On-Chain Admin Timelocks"; the contract constant itself
 * lives outside this change's read list, so this is a typed slot — see FEEDBACK (unverified).
 */
export const ADMIN_TIMELOCK_HOURS = 48
