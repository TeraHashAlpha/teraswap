/**
 * [CHORE-SUSHI-V7-REDSNWAPPER-QUOTE-FIX] Per-chain executable-source scoping.
 *
 * A source may QUOTE on a chain without being able to SETTLE there. Settling
 * a standard (calldata) swap requires the full execution wiring:
 *   (a) the router's swap selector in SC-04 `KNOWN_SWAP_SELECTORS`
 *       (src/lib/swap-selectors.ts — client + server fail-closed gate),
 *   (b) an R1 recipient decoder for that selector in `VALIDATED_SELECTORS`
 *       (src/lib/calldata-recipient.ts — fail-closed),
 *   (c) the router whitelisted on the chain's DEPLOYED FeeCollector /
 *       OrderExecutor (`whitelistedRouters(address)`, an owner-gated
 *       on-chain state).
 * A source that fails any of (a)(b)(c) on a chain is QUOTE-ONLY there: its
 * price is shown for comparison (informational) but it must never win the
 * executable path — not as the primary swap source, not as a 9O fallback,
 * not as a split-routing leg. SC-04 remains the terminal backstop regardless
 * of what this module says (defense-in-depth, not a replacement).
 *
 * Current map — evidence (probed live + on-chain, 2026-07-03, FEEDBACK.md
 * "CHORE-SUSHI-V7" section has the full matrix):
 *   - sushiswap: v7 settles via RedSnwapper 0xAC4c…0b75 on BOTH chains
 *     (snwap selector 0x5f3bd1c8). (a) ❌ and (b) ❌ everywhere; (c) mainnet
 *     FC+OE ❌, Base FC+OE ✅. Executable support (decoder + SC-04 + mainnet
 *     owner whitelist tx) is a separate fund-flow-gated task (rules #2/#3,
 *     Auditor re-pass) — W7-L-02-decoder class.
 *   - openocean / curve: (a) ❌ (b) ❌ on both chains (T-SAF W7-L-02,
 *     APPROVED verdict: leave quote-only — aggregators already route the
 *     same pools). OpenOcean quotes correctly since the units fix (#259),
 *     so without this scoping it could WIN the display and dead-end into
 *     the SC-04 → 9O fallback papercut on every attempt.
 *   - balancer: not listed here — fully DISABLED (dead endpoint, #259).
 *
 * Re-enabling a source here = flipping REAL wiring first: add the selector
 * to SC-04, add the R1 decoder, verify the on-chain whitelist per chain,
 * then remove it from this map. The invariant test in
 * executable-sources.test.ts couples this map to (a)/(b) so it cannot
 * silently drift.
 */
import type { AggregatorName } from '@/lib/constants'
import type { MetaQuoteResult } from '@/lib/adapters'
import { orderFallbackSources } from '@/lib/swap-fallback'

/** Sources whose quotes are informational-only on a chain (cannot settle). */
export const QUOTE_ONLY_SOURCES_BY_CHAIN: Record<number, ReadonlySet<AggregatorName>> = {
  1: new Set<AggregatorName>(['sushiswap', 'openocean', 'curve']),
  8453: new Set<AggregatorName>(['sushiswap', 'openocean', 'curve']),
}

/**
 * True when `source` can actually settle a swap on `chainId`.
 * Chains without an explicit map (quote-open coming-soon chains) default to
 * executable — swaps are impossible there anyway (no FeeCollector), and the
 * SC-04/router gates stay fail-closed.
 */
export function isExecutableSource(source: string, chainId: number): boolean {
  return !QUOTE_ONLY_SOURCES_BY_CHAIN[chainId]?.has(source as AggregatorName)
}

/**
 * Rebase `best` onto the highest-ranked EXECUTABLE quote for the chain,
 * moving it to `all[0]` (the same best===all[0] contract
 * selectBestWithMevPreference maintains). Quote-only entries stay in `all`
 * so the comparison list still shows them (labeled informational in the UI).
 * Identity-returns the input when best is already executable (referential
 * stability for useMemo) and when nothing is executable (SC-04 backstop).
 */
export function scopeToExecutable(
  meta: MetaQuoteResult | null,
  chainId: number,
): MetaQuoteResult | null {
  if (!meta) return null
  if (isExecutableSource(meta.best.source, chainId)) return meta
  const execBest = meta.all.find((q) => isExecutableSource(q.source, chainId))
  if (!execBest) return meta
  return {
    ...meta,
    best: execBest,
    all: [execBest, ...meta.all.filter((q) => q !== execBest)],
  }
}

/**
 * Ranked 9O-fallback candidates that can actually settle on `chainId`.
 * Delegates to orderFallbackSources with the quote-only set (plus cowswap,
 * which settles via its own intent flow) excluded.
 */
export function orderExecutableFallbacks(
  meta: MetaQuoteResult,
  primary: string,
  chainId: number,
): AggregatorName[] {
  const quoteOnly = QUOTE_ONLY_SOURCES_BY_CHAIN[chainId] ?? new Set<AggregatorName>()
  return orderFallbackSources(meta, primary, ['cowswap', ...quoteOnly])
}
