/**
 * [SPRINT-9O Part B] Swap-selection resilience.
 *
 * Root cause of 9O: on mainnet the Velora route runs through Augustus V6
 * (0x6a00…1068), which is NOT whitelisted in the FeeCollector V2 — so every
 * Velora fee-routed swap reverts on-chain with RouterNotWhitelisted() during
 * pre-swap simulation. The proper fix (whitelisting the router) is an on-chain
 * admin action escalated separately (no contract edits here).
 *
 * Independent of that root cause, a route that "wins then reverts" must never
 * dead-end the user when other sources work. These helpers let the swap flow
 * walk the ranked alternatives and use the first that simulates OK.
 *
 * Pure / zero side-effects so they can be unit-tested in isolation.
 */
import type { AggregatorName } from '@/lib/constants'

interface RankedMeta {
  /** Quotes ranked best→worst (api.ts sorts before returning). */
  all: ReadonlyArray<{ source: string }>
}

/**
 * Ranked fallback candidates to try after `primary`, in best→worst order.
 * Excludes the primary itself and, by default, CoW (it settles via a separate
 * EIP-712 intent flow, not the FeeCollector simulation path). De-duplicated.
 */
export function orderFallbackSources(
  meta: RankedMeta,
  primary: string,
  exclude: readonly string[] = ['cowswap'],
): AggregatorName[] {
  const seen = new Set<string>([primary, ...exclude])
  const ordered: AggregatorName[] = []
  for (const quote of meta.all ?? []) {
    if (seen.has(quote.source)) continue
    seen.add(quote.source)
    ordered.push(quote.source as AggregatorName)
  }
  return ordered
}

/**
 * Patterns where switching sources would NOT help or would hide something the
 * user needs to see — so we stop instead of silently trying another route:
 *   - allowance: the user must approve first (same FeeCollector for every route)
 *   - price guard: a deliberate Chainlink-deviation protection block
 *   - user rejection: the user declined the request
 */
const NO_FALLBACK_PATTERNS: readonly RegExp[] = [
  /insufficient allowance|please approve/i,
  /price guard/i,
  /user rejected|user denied|request rejected|user cancell?ed/i,
]

/**
 * Whether a failed swap attempt is worth retrying on the next-best source.
 * Conclusive on-chain reverts (RouterNotWhitelisted, "execution reverted"),
 * unusable aggregator responses (unknown selector, recipient/router mismatch),
 * and transient/unknown errors → true. User-actionable or deliberate blocks → false.
 */
export function shouldFallbackToNextSource(error: unknown): boolean {
  const msg =
    error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!msg) return true
  return !NO_FALLBACK_PATTERNS.some((re) => re.test(msg))
}
