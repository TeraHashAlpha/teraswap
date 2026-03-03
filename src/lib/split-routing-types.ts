import type { AggregatorName } from './constants'
import type { NormalizedQuote } from './api'

// ── Split Routing Types ──────────────────────────────────────
// Split a large trade across multiple DEX sources to minimize
// price impact and maximize total output.

/** A single leg of a split route — one source handling a % of the total */
export interface SplitLeg {
  source: AggregatorName
  /** Percentage of total input allocated (0–100) */
  percent: number
  /** Raw bigint string of input amount for this leg */
  inputAmount: string
  /** Raw bigint string of output amount for this leg */
  outputAmount: string
  /** Gas cost in USD for this leg */
  gasUsd: number
  /** The full quote for this leg (used for execution) */
  quote: NormalizedQuote
}

/** A complete split route solution (possibly 1 leg = single-source) */
export interface SplitRoute {
  /** All legs in the split */
  legs: SplitLeg[]
  /** Total output across all legs (raw bigint string) */
  totalOutput: string
  /** Total gas cost across all legs (USD) */
  totalGasUsd: number
  /** Whether this is actually split (>1 legs) */
  isSplit: boolean
  /** Improvement vs best single source (0 = no improvement, positive = better) */
  improvementBps: number
}

/** The enriched MetaQuote result including split route analysis */
export interface SplitQuoteResult {
  /** Best single-source quote (existing behavior) */
  bestSingle: NormalizedQuote
  /** Best split route (may be single-source if splitting doesn't help) */
  bestSplit: SplitRoute
  /** All single-source quotes sorted by output desc */
  allSingles: NormalizedQuote[]
  /** Whether split route is recommended over single-source */
  splitRecommended: boolean
  /** Timestamp */
  fetchedAt: number
}

// ── Configuration ──

/** Minimum trade size in USD before split routing is attempted */
export const SPLIT_MIN_USD = 5_000

/** Maximum number of legs in a split */
export const SPLIT_MAX_LEGS = 3

/** Minimum allocation per leg (percent) */
export const SPLIT_MIN_PERCENT = 10

/** Minimum improvement in bps to recommend split over single */
export const SPLIT_MIN_IMPROVEMENT_BPS = 10 // 0.1%

/**
 * Pre-defined split configurations to test.
 * Each array represents percentages for a 2-way or 3-way split.
 * We test all pairwise/triple combos of top sources at these splits.
 */
export const SPLIT_CONFIGS_2WAY: [number, number][] = [
  [50, 50],
  [60, 40],
  [70, 30],
  [80, 20],
]

export const SPLIT_CONFIGS_3WAY: [number, number, number][] = [
  [50, 30, 20],
  [40, 40, 20],
  [60, 25, 15],
  [34, 33, 33],
]

/** Sources that can participate in split routing execution (must support partial amounts) */
export const SPLIT_ELIGIBLE_SOURCES: ReadonlySet<AggregatorName> = new Set([
  '1inch',
  '0x',
  'velora',
  'odos',
  'kyberswap',
  'openocean',
  'sushiswap',
  'uniswapv3',
  'balancer',
  'curve',
  // Note: cowswap excluded — intent-based orders can't be split into sub-amounts easily
])
