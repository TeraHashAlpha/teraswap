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
 */

import { ADAPTER_REGISTRY } from '@/lib/adapters'
import { DISABLED_SOURCES } from '@/lib/constants'
import { CHAIN_CONFIGS, getSupportedChainIds } from '@/lib/chains/registry'

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
