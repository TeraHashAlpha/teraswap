/**
 * [fix/catalog-refresh-drops-untrusted] Growth breaker — rule A of the owner's 2026-11-18 decision.
 *
 * The outage breaker (build-chain.ts, SOURCE_OUTAGE_RATIO_THRESHOLD) only catches a source that
 * SHRINKS. On 2026-11-16 → 2026-11-18 one source (1inch) grew 1074 → 3203 (mainnet), 194 → 337 (Base)
 * and 137 → 5069 (Arbitrum) and a refresh would have built 1377 / 520 rows against the size bounds.
 *
 * Rule: a source list that grew by MORE than 50% against the previous committed run's size for the
 * same source and chain is not used for that run. The refresh uses the previous snapshot of that
 * source instead and carries on with the others; the PR body and one issue name the source, chain,
 * old and new size. It stays held back until the owner accepts the new size by a committed change
 * to `scripts/token-catalog/accepted-source-sizes.json` (one line per source and chain).
 *
 * "Previous snapshot": the repo stores each source's list SIZE per chain (`counts.sourceCounts`),
 * not its entries. The snapshot is therefore rebuilt from the previous catalog: every row whose
 * `sources` names the source is one entry of it (owner answer, 2026-11-18). A source that stood
 * for a vote on a row on the site keeps its vote; entries that never reached a row cannot have
 * moved a decision. The recorded size stays at the previous number, so next week's comparison is
 * against the same baseline — "held back until accepted" needs no other state.
 *
 * Pure: no network, no fs (the JSON file is read by build.ts and parsed here).
 */
import type { CatalogRow, SourceCounts, SourceEntry, SourceId } from './types'

/** More than this percentage over the baseline ⇒ the source is held back. Exactly this much is fine. */
export const SOURCE_GROWTH_PERCENT = 50

export interface HeldBackSource {
  chainId: number
  source: SourceId
  /** Size recorded by the previous committed run (the baseline unless the owner accepted a larger one). */
  previous: number
  /** Size of the list fetched this run. */
  current: number
  /** What `current` was compared with: max(previous, owner-accepted size). */
  baseline: number
}

/** Integer math only: current > baseline * 150 / 100. */
export function exceedsGrowth(baseline: number, current: number): boolean {
  return current * 100 > baseline * (100 + SOURCE_GROWTH_PERCENT)
}

export interface SourceGrowthInput {
  chainId: number
  /** This chain's `counts.sourceCounts` from the previous committed catalog. undefined = no baseline at all. */
  previousCounts?: SourceCounts
  /** This run's fetched-list sizes (fulfilled sources only). */
  currentCounts: SourceCounts
  /** Sizes the owner accepted for this chain (accepted-source-sizes.json). */
  accepted?: Partial<Record<SourceId, number>>
}

/**
 * Sources whose list grew past the threshold. A source with no previous size (first appearance, or
 * a chain with no previous counts) has nothing to compare against and is never held back — same
 * "record only" contract as the outage breaker.
 */
export function evaluateSourceGrowth(input: SourceGrowthInput): HeldBackSource[] {
  const held: HeldBackSource[] = []
  for (const [source, current] of Object.entries(input.currentCounts) as Array<[SourceId, number]>) {
    const previous = input.previousCounts?.[source]
    if (!previous || previous <= 0) continue
    const baseline = Math.max(previous, input.accepted?.[source] ?? 0)
    if (exceedsGrowth(baseline, current)) held[held.length] = { chainId: input.chainId, source, previous, current, baseline }
  }
  return held
}

/** The previous run's view of one source, rebuilt from the previous catalog (see the header). */
export function snapshotEntries(chainId: number, source: SourceId, previousRows: Iterable<CatalogRow>): SourceEntry[] {
  const out: SourceEntry[] = []
  for (const r of previousRows) {
    if (!r.sources.includes(source)) continue
    // no logoURI: the catalog's own logo path is not the source's logo, and assemble resolves logos itself
    out[out.length] = { chainId, address: r.address, symbol: r.symbol, name: r.name, decimals: r.decimals, source }
  }
  return out
}

/** File the owner edits to accept a source's new size: one `"<chainId>:<source>": <size>` line each. */
export const ACCEPTED_SIZES_FILE = 'scripts/token-catalog/accepted-source-sizes.json'

const SOURCE_IDS: ReadonlySet<string> = new Set(['superchain', 'arbitrumBridge', 'uniswap', 'coingecko', 'oneinch', 'trustwallet', 'defillama'])

/**
 * Parse accepted-source-sizes.json for one chain. Strict: a malformed line throws (the build fails
 * loudly) — a typo in an owner decision must never silently mean "nothing accepted" or "everything".
 */
export function parseAcceptedSizes(raw: unknown, chainId: number): Partial<Record<SourceId, number>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${ACCEPTED_SIZES_FILE}: expected a JSON object`)
  const out: Partial<Record<SourceId, number>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith('$')) continue // $comment
    const m = /^(\d+):([A-Za-z]+)$/.exec(key)
    if (!m || !SOURCE_IDS.has(m[2])) throw new Error(`${ACCEPTED_SIZES_FILE}: bad key "${key}" (expected "<chainId>:<source>", e.g. "1:oneinch")`)
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`${ACCEPTED_SIZES_FILE}: "${key}" must be a positive integer size`)
    if (Number(m[1]) === chainId) out[m[2] as SourceId] = value
  }
  return out
}
