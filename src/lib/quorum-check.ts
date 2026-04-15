/**
 * H5 — Quorum Cross-Check: semantic quote validation.
 *
 * Detects manipulated quotes by comparing output amounts across all active
 * sources for well-known reference pairs. If a source returns a quote that
 * deviates significantly from the median, it's flagged.
 *
 * Classification:
 *   - warning:    deviation > threshold on 1 pair only → log, no action
 *   - flagged:    deviation > threshold on 2/2 pairs → degrade source + alert
 *   - correlated: ≥3 sources flagged simultaneously → force-disable all + P0 alert
 *
 * Runs every 5th monitoring tick (every ~5 min) to stay within rate limits.
 * Consumes fetchMetaQuote() output — does NOT duplicate adapter fan-out.
 *
 * @internal — server-only module.
 */

import { kv } from '@vercel/kv'
import { WETH_ADDRESS } from './constants'
import type { NormalizedQuote, MetaQuoteResult } from './adapters'
import { fetchMetaQuote } from './api'
import { getAllStatuses, getStatus, getThresholds, forceDisable } from './source-state-machine'
import { emitTransitionAlert } from './alert-wrapper'

// ── Token addresses (Ethereum mainnet) ──────────────────

const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT_ADDRESS = '0xdac17f958d2ee523a2206206994597c13d831ec7'

// ── Reference pair configuration ────────────────────────

export interface ReferencePair {
  fromToken: string
  toToken: string
  amount: string
  srcDecimals: number
  dstDecimals: number
  label: string
  maxDeviationPercent: number
}

export const QUORUM_REFERENCE_PAIRS: readonly ReferencePair[] = [
  {
    fromToken: WETH_ADDRESS,
    toToken: USDC_ADDRESS,
    amount: '1000000000000000000', // 1 ETH (18 decimals)
    srcDecimals: 18,
    dstDecimals: 6,
    label: 'WETH→USDC (1 ETH)',
    maxDeviationPercent: 5,
  },
  {
    fromToken: USDC_ADDRESS,
    toToken: USDT_ADDRESS,
    amount: '10000000000', // 10,000 USDC (6 decimals)
    srcDecimals: 6,
    dstDecimals: 6,
    label: 'USDC→USDT (10k)',
    maxDeviationPercent: 2,
  },
] as const

// ── Types ───────────────────────────────────────────────

export type OutlierClassification = 'warning' | 'flagged' | 'correlated'

export interface OutlierInfo {
  sourceId: string
  deviationPercent: number
  medianAmount: string
  sourceAmount: string
  classification: OutlierClassification
  pairLabel: string
}

export interface PairResult {
  label: string
  maxDeviationPercent: number
  quotesCollected: number
  medianAmount: string
  outliers: OutlierInfo[]
  skipped: boolean
  skipReason?: string
}

export interface QuorumCheckResult {
  timestamp: string
  pairs: PairResult[]
  outliers: OutlierInfo[]
  correlatedOutlierCount: number
  skipped: boolean
  skipReason?: string
}

// ── Tick counter (run every 5th tick) ───────────────────

const TICK_COUNTER_KEY = 'teraswap:monitor:quorumTickCounter'
const QUORUM_TICK_INTERVAL = 5

export async function shouldRunQuorum(): Promise<boolean> {
  try {
    const count = await kv.get<number>(TICK_COUNTER_KEY) ?? 0
    const next = count + 1
    await kv.set(TICK_COUNTER_KEY, next)
    return next % QUORUM_TICK_INTERVAL === 0
  } catch (err) {
    console.warn('[QUORUM] KV tick counter failed, skipping:', err instanceof Error ? err.message : err)
    return false
  }
}

// ── Median calculation ──────────────────────────────────

export function computeMedian(values: bigint[]): bigint {
  if (values.length === 0) return 0n
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2n
  }
  return sorted[mid]
}

// ── Per-source deviation threshold ──────────────────────

function getMaxDeviation(sourceId: string, pair: ReferencePair): number {
  try {
    const thresholds = getThresholds(sourceId)
    if (pair.maxDeviationPercent <= 2) {
      // Stablecoin pair — use quorumStableMaxDeviationPercent if available
      if (thresholds.quorumStableMaxDeviationPercent != null && thresholds.quorumStableMaxDeviationPercent > 0) {
        return thresholds.quorumStableMaxDeviationPercent
      }
    } else {
      // Volatile pair — use quorumMaxDeviationPercent if available
      if (thresholds.quorumMaxDeviationPercent != null && thresholds.quorumMaxDeviationPercent > 0) {
        return thresholds.quorumMaxDeviationPercent
      }
    }
  } catch { /* fall through to pair default */ }
  return pair.maxDeviationPercent
}

// ── Core quorum analysis ────────────────────────────────

async function analyzePair(
  pair: ReferencePair,
  activeSourceIds: Set<string>,
): Promise<PairResult> {
  const result: PairResult = {
    label: pair.label,
    maxDeviationPercent: pair.maxDeviationPercent,
    quotesCollected: 0,
    medianAmount: '0',
    outliers: [],
    skipped: false,
  }

  // Fetch quotes via the existing adapter fan-out
  let metaResult: MetaQuoteResult
  try {
    metaResult = await fetchMetaQuote(
      pair.fromToken,
      pair.toToken,
      pair.amount,
      pair.srcDecimals,
      pair.dstDecimals,
    )
  } catch (err) {
    console.warn(`[QUORUM] fetchMetaQuote failed for ${pair.label}:`, err instanceof Error ? err.message : err)
    result.skipped = true
    result.skipReason = `fetchMetaQuote failed: ${err instanceof Error ? err.message : String(err)}`
    return result
  }

  // Filter to only active sources
  const activeQuotes = metaResult.all.filter(q => activeSourceIds.has(q.source))
  result.quotesCollected = activeQuotes.length

  if (activeQuotes.length < 3) {
    result.skipped = true
    result.skipReason = `Insufficient active quotes: ${activeQuotes.length} (need ≥3)`
    return result
  }

  // Compute median
  const amounts = activeQuotes.map(q => {
    try { return BigInt(q.toAmount) } catch { return 0n }
  }).filter(a => a > 0n)

  if (amounts.length < 3) {
    result.skipped = true
    result.skipReason = `Insufficient valid amounts: ${amounts.length} (need ≥3)`
    return result
  }

  const median = computeMedian(amounts)
  result.medianAmount = median.toString()

  if (median === 0n) {
    result.skipped = true
    result.skipReason = 'Median is zero'
    return result
  }

  // Check each source for deviation
  for (const quote of activeQuotes) {
    let sourceAmount: bigint
    try {
      sourceAmount = BigInt(quote.toAmount)
    } catch {
      continue
    }
    if (sourceAmount === 0n) continue

    const diff = sourceAmount > median
      ? sourceAmount - median
      : median - sourceAmount
    const deviationPercent = (Number(diff) / Number(median)) * 100

    const maxDev = getMaxDeviation(quote.source, pair)

    if (deviationPercent > maxDev) {
      result.outliers.push({
        sourceId: quote.source,
        deviationPercent: Math.round(deviationPercent * 100) / 100,
        medianAmount: median.toString(),
        sourceAmount: sourceAmount.toString(),
        classification: 'warning', // default — upgraded later if flagged on both pairs
        pairLabel: pair.label,
      })
    }
  }

  return result
}

// ── Main entry point ────────────────────────────────────

export async function runQuorumCheck(): Promise<QuorumCheckResult> {
  const timestamp = new Date().toISOString()

  // Get all active sources — only include active in quorum
  const allStatuses = await getAllStatuses()
  const activeSources = allStatuses.filter(s => s.state === 'active')
  const activeSourceIds = new Set(activeSources.map(s => s.id))

  if (activeSources.length < 3) {
    console.log(`[QUORUM] Skipped — only ${activeSources.length} active sources (need ≥3)`)
    return {
      timestamp,
      pairs: [],
      outliers: [],
      correlatedOutlierCount: 0,
      skipped: true,
      skipReason: `Insufficient active sources: ${activeSources.length} (need ≥3)`,
    }
  }

  // Analyze each reference pair
  const pairResults: PairResult[] = []
  for (const pair of QUORUM_REFERENCE_PAIRS) {
    const result = await analyzePair(pair, activeSourceIds)
    pairResults.push(result)
  }

  // Aggregate outlier flags across pairs
  const outliersBySource = new Map<string, OutlierInfo[]>()
  for (const pr of pairResults) {
    for (const o of pr.outliers) {
      const existing = outliersBySource.get(o.sourceId) || []
      existing.push(o)
      outliersBySource.set(o.sourceId, existing)
    }
  }

  // Classify outliers
  const allOutliers: OutlierInfo[] = []
  const flaggedSourceIds: string[] = []

  const nonSkippedPairCount = pairResults.filter(p => !p.skipped).length

  for (const [sourceId, infos] of outliersBySource) {
    if (nonSkippedPairCount >= 2 && infos.length >= 2) {
      // Flagged on both pairs → high confidence
      for (const info of infos) {
        info.classification = 'flagged'
      }
      flaggedSourceIds.push(sourceId)
    }
    // else: warning only (1 pair) — no action
    allOutliers.push(...infos)
  }

  // Correlated outlier detection: ≥3 sources flagged → systemic attack
  const correlatedOutlierCount = flaggedSourceIds.length
  const isCorrelated = correlatedOutlierCount >= 3

  if (isCorrelated) {
    // Mark all flagged as correlated
    for (const o of allOutliers) {
      if (o.classification === 'flagged') {
        o.classification = 'correlated'
      }
    }
  }

  // ── Act on classifications ────────────────────────────

  // Flagged (dual-pair outlier, <3 sources) → disable if currently active.
  // Uses forceDisable with 'quorum-deviation' reason (NOT P0 → auto-recovery allowed after 10 min).
  if (!isCorrelated) {
    for (const sourceId of flaggedSourceIds) {
      const status = await getStatus(sourceId)
      if (status.state === 'active') {
        console.warn(`[QUORUM] Disabling ${sourceId} — flagged on ${nonSkippedPairCount} pairs`)
        await forceDisable(sourceId, 'quorum-deviation')
      }
    }
  }

  // Correlated (≥3 sources flagged) → kill-switch all flagged sources
  if (isCorrelated) {
    console.error(`[QUORUM] CORRELATED OUTLIER — ${correlatedOutlierCount} sources flagged. Triggering kill-switch.`)
    for (const sourceId of flaggedSourceIds) {
      await forceDisable(sourceId, `quorum-kill-switch: correlated deviation across ${correlatedOutlierCount} sources`)
      // quorum-kill-switch is NOT in P0_REASONS, so auto-recovery is allowed
    }
    // Emit P0-level alert for the correlated event
    emitTransitionAlert(
      'quorum-system',
      'active',
      'disabled',
      `quorum-correlated: ${correlatedOutlierCount} sources disabled — ${flaggedSourceIds.join(', ')}`,
    ).catch(err => {
      console.error('[QUORUM] Correlated alert emission failed:', err instanceof Error ? err.message : err)
    })
  }

  // Log summary
  const warningCount = allOutliers.filter(o => o.classification === 'warning').length
  const flaggedCount = allOutliers.filter(o => o.classification === 'flagged' || o.classification === 'correlated').length
  if (allOutliers.length > 0) {
    console.warn(`[QUORUM] ${allOutliers.length} outlier(s): ${warningCount} warning, ${flaggedCount} flagged/correlated`)
  } else {
    console.log(`[QUORUM] All sources within tolerance (${activeSources.length} active, ${pairResults.filter(p => !p.skipped).length} pairs checked)`)
  }

  return {
    timestamp,
    pairs: pairResults,
    outliers: allOutliers,
    correlatedOutlierCount,
    skipped: false,
  }
}
