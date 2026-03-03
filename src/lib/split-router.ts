import { type NormalizedQuote, type MetaQuoteResult } from './api'
import type { AggregatorName } from './constants'
import {
  type SplitLeg,
  type SplitRoute,
  type SplitQuoteResult,
  SPLIT_MIN_IMPROVEMENT_BPS,
  SPLIT_MAX_LEGS,
  SPLIT_MIN_PERCENT,
  SPLIT_CONFIGS_2WAY,
  SPLIT_CONFIGS_3WAY,
  SPLIT_ELIGIBLE_SOURCES,
} from './split-routing-types'

// ── Split Router Engine ─────────────────────────────────────
// Given a set of single-source quotes at multiple sub-amounts,
// finds the optimal split across sources to maximize output.

/**
 * Fetch quotes from all sources at multiple sub-amounts for split routing.
 * Returns a map: source → percent → NormalizedQuote
 *
 * @param fetchQuoteAtAmount — callback that fetches quotes at a given raw amount
 * @param totalAmount — total raw bigint string to split
 * @param singleQuotes — already-fetched full-amount quotes (reused for 100%)
 */
export async function fetchSplitQuotes(
  fetchQuoteAtAmount: (amount: string) => Promise<NormalizedQuote[]>,
  totalAmount: string,
  singleQuotes: NormalizedQuote[],
): Promise<Map<AggregatorName, Map<number, NormalizedQuote>>> {
  const total = BigInt(totalAmount)
  const quoteMap = new Map<AggregatorName, Map<number, NormalizedQuote>>()

  // Seed with 100% quotes from existing single-source results
  for (const q of singleQuotes) {
    if (!SPLIT_ELIGIBLE_SOURCES.has(q.source)) continue
    if (!quoteMap.has(q.source)) quoteMap.set(q.source, new Map())
    quoteMap.get(q.source)!.set(100, q)
  }

  // Determine sub-percentages we need
  const neededPercents = new Set<number>()
  for (const [a, b] of SPLIT_CONFIGS_2WAY) {
    neededPercents.add(a)
    neededPercents.add(b)
  }
  for (const [a, b, c] of SPLIT_CONFIGS_3WAY) {
    neededPercents.add(a)
    neededPercents.add(b)
    neededPercents.add(c)
  }

  // Remove 100% (already have it)
  neededPercents.delete(100)

  // Fetch quotes at each sub-amount in parallel
  const fetchPromises: Promise<void>[] = []

  for (const pct of neededPercents) {
    const subAmount = (total * BigInt(pct)) / 100n
    if (subAmount <= 0n) continue

    const p = fetchQuoteAtAmount(subAmount.toString()).then((quotes) => {
      for (const q of quotes) {
        if (!SPLIT_ELIGIBLE_SOURCES.has(q.source)) continue
        if (!quoteMap.has(q.source)) quoteMap.set(q.source, new Map())
        quoteMap.get(q.source)!.set(pct, q)
      }
    }).catch(() => {
      // Silently skip failed sub-amount fetches
    })

    fetchPromises.push(p)
  }

  await Promise.all(fetchPromises)
  return quoteMap
}

/**
 * Given a map of quotes at various sub-amounts, find the best split route.
 * Tries all 2-way and 3-way combinations of eligible sources at predefined split ratios.
 */
export function findBestSplit(
  quoteMap: Map<AggregatorName, Map<number, NormalizedQuote>>,
  totalAmount: string,
  bestSingle: NormalizedQuote,
): SplitRoute {
  const eligibleSources = Array.from(quoteMap.keys())
    .filter(s => SPLIT_ELIGIBLE_SOURCES.has(s))

  const bestSingleOutput = BigInt(bestSingle.toAmount)
  let bestRoute: SplitRoute = buildSingleRoute(bestSingle, totalAmount)

  // ── Try 2-way splits ──
  if (eligibleSources.length >= 2) {
    for (let i = 0; i < eligibleSources.length; i++) {
      for (let j = i + 1; j < eligibleSources.length; j++) {
        const srcA = eligibleSources[i]
        const srcB = eligibleSources[j]
        const mapA = quoteMap.get(srcA)!
        const mapB = quoteMap.get(srcB)!

        for (const [pctA, pctB] of SPLIT_CONFIGS_2WAY) {
          const quoteA = mapA.get(pctA)
          const quoteB = mapB.get(pctB)
          if (!quoteA || !quoteB) continue

          const route = buildSplitRoute(
            [
              { source: srcA, percent: pctA, quote: quoteA },
              { source: srcB, percent: pctB, quote: quoteB },
            ],
            totalAmount,
            bestSingleOutput,
          )

          if (BigInt(route.totalOutput) > BigInt(bestRoute.totalOutput)) {
            bestRoute = route
          }

          // Also try the reverse allocation (pctB for A, pctA for B)
          if (pctA !== pctB) {
            const quoteAr = mapA.get(pctB)
            const quoteBr = mapB.get(pctA)
            if (quoteAr && quoteBr) {
              const routeR = buildSplitRoute(
                [
                  { source: srcA, percent: pctB, quote: quoteAr },
                  { source: srcB, percent: pctA, quote: quoteBr },
                ],
                totalAmount,
                bestSingleOutput,
              )
              if (BigInt(routeR.totalOutput) > BigInt(bestRoute.totalOutput)) {
                bestRoute = routeR
              }
            }
          }
        }
      }
    }
  }

  // ── Try 3-way splits ──
  if (eligibleSources.length >= 3 && SPLIT_MAX_LEGS >= 3) {
    for (let i = 0; i < eligibleSources.length; i++) {
      for (let j = i + 1; j < eligibleSources.length; j++) {
        for (let k = j + 1; k < eligibleSources.length; k++) {
          const sources = [eligibleSources[i], eligibleSources[j], eligibleSources[k]]
          const maps = sources.map(s => quoteMap.get(s)!)

          for (const config of SPLIT_CONFIGS_3WAY) {
            // Try all permutations of allocating config percentages to sources
            const perms = permute3(config)
            for (const [pA, pB, pC] of perms) {
              const qA = maps[0].get(pA)
              const qB = maps[1].get(pB)
              const qC = maps[2].get(pC)
              if (!qA || !qB || !qC) continue

              const route = buildSplitRoute(
                [
                  { source: sources[0], percent: pA, quote: qA },
                  { source: sources[1], percent: pB, quote: qB },
                  { source: sources[2], percent: pC, quote: qC },
                ],
                totalAmount,
                bestSingleOutput,
              )

              if (BigInt(route.totalOutput) > BigInt(bestRoute.totalOutput)) {
                bestRoute = route
              }
            }
          }
        }
      }
    }
  }

  return bestRoute
}

/**
 * Main entry: analyze whether split routing improves over the best single-source quote.
 */
export function analyzeSplitRoute(
  quoteMap: Map<AggregatorName, Map<number, NormalizedQuote>>,
  metaQuote: MetaQuoteResult,
): SplitQuoteResult {
  const bestSplit = findBestSplit(quoteMap, '', metaQuote.best)

  return {
    bestSingle: metaQuote.best,
    bestSplit,
    allSingles: metaQuote.all,
    splitRecommended: bestSplit.isSplit && bestSplit.improvementBps >= SPLIT_MIN_IMPROVEMENT_BPS,
    fetchedAt: Date.now(),
  }
}

// ── Helpers ──

function buildSingleRoute(quote: NormalizedQuote, _totalAmount: string): SplitRoute {
  return {
    legs: [{
      source: quote.source,
      percent: 100,
      inputAmount: '', // filled at execution time
      outputAmount: quote.toAmount,
      gasUsd: quote.gasUsd,
      quote,
    }],
    totalOutput: quote.toAmount,
    totalGasUsd: quote.gasUsd,
    isSplit: false,
    improvementBps: 0,
  }
}

function buildSplitRoute(
  parts: Array<{ source: AggregatorName; percent: number; quote: NormalizedQuote }>,
  _totalAmount: string,
  bestSingleOutput: bigint,
): SplitRoute {
  // Validate percentages sum to 100
  const totalPct = parts.reduce((sum, p) => sum + p.percent, 0)
  if (totalPct !== 100) return buildEmptyRoute()

  // Validate min percent
  if (parts.some(p => p.percent < SPLIT_MIN_PERCENT)) return buildEmptyRoute()

  let totalOutput = 0n
  let totalGasUsd = 0

  const legs: SplitLeg[] = parts.map(p => {
    const outputBig = BigInt(p.quote.toAmount)
    totalOutput += outputBig
    totalGasUsd += p.quote.gasUsd

    return {
      source: p.source,
      percent: p.percent,
      inputAmount: '', // resolved at execution
      outputAmount: p.quote.toAmount,
      gasUsd: p.quote.gasUsd,
      quote: p.quote,
    }
  })

  // Calculate improvement in basis points
  const improvementBps = bestSingleOutput > 0n
    ? Number(((totalOutput - bestSingleOutput) * 10_000n) / bestSingleOutput)
    : 0

  return {
    legs,
    totalOutput: totalOutput.toString(),
    totalGasUsd,
    isSplit: parts.length > 1,
    improvementBps,
  }
}

function buildEmptyRoute(): SplitRoute {
  return {
    legs: [],
    totalOutput: '0',
    totalGasUsd: 0,
    isSplit: false,
    improvementBps: -Infinity,
  }
}

/** Generate all unique permutations of a 3-element tuple */
function permute3<T>(arr: [T, T, T]): [T, T, T][] {
  const [a, b, c] = arr
  const result: [T, T, T][] = [[a, b, c]]
  // Only add unique permutations
  const seen = new Set<string>()
  seen.add(`${a},${b},${c}`)
  const all: [T, T, T][] = [
    [a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a],
  ]
  for (const perm of all) {
    const key = `${perm[0]},${perm[1]},${perm[2]}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(perm)
    }
  }
  return result
}
