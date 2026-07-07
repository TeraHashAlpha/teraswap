/**
 * [CHORE-QUOTE-QUORUM / W7-L-02] Low-quorum sanity band for the quote winner.
 *
 * fetchMetaQuote's outlier filter drops quotes > 3× the median — but with only
 * 2 responders the median is (a+b)/2, so the threshold is 1.5× the larger
 * value and NOTHING can ever be flagged. A 10^n-mis-scaled quote (the
 * OpenOcean units bug) or a manipulated quote therefore wins the DISPLAYED
 * best price whenever quorum is 2, and the user is shown a false number.
 *
 * WHAT THIS MODULE ACTUALLY DOES [CHORE-QUORUM-LOWCONFIDENCE-FIX — header
 * corrected; the old "display-only" characterization was inaccurate]: when
 * quorum < 3 it can DEMOTE the winner, which changes which source is
 * PRESENTED AS BEST — and the presented best is the quote the user is then
 * steered to sign and execute. Demotion is execution-SELECTION-adjacent, not
 * cosmetic. What it does NOT do: bypass or weaken the execution gates. The
 * executed quote — whichever one is presented — still passes SC-04
 * (`isKnownSwapSelector` selector allowlist), R1 (`validateCallDataRecipient`
 * recipient gate) and the on-chain `minimumOutput` terminal backstop, all
 * untouched by this module. Those gates guarantee faithful execution OF the
 * presented quote and remain the terminal backstop; they cannot restore a
 * better quote this module demoted — which is why demotion itself must be
 * justified, not merely triggered.
 *
 * REFERENCE-CONFIRMED DEMOTION [CHORE-QUORUM-REFERENCE-CONFIRMED-DEMOTION —
 * closes NEW2-M-01]: a pairwise band trip alone no longer demotes anything.
 * The band sees ONE spread, so it cannot tell "winner too high" from
 * "runner-up too low" — yet it used to always demote the WINNER, letting a
 * source that quotes >band UNDER an honest winner grief the honest quote out
 * of the presented-best slot and take it (price degradation, not theft: the
 * executed fill is still bounded by its own minimumOutput). Demotion is now
 * gated behind an EXTERNAL reference resolved from existing plumbing only —
 * the #18 Chainlink consent-gate feed first (fetchChainlinkPriceRaw: round
 * integrity + per-feed staleness + L2 sequencer gates, composed feeds
 * included), else the #248 DefiLlama price (fetchDefiLlamaPrice: confidence
 * ≥ 0.5, cached) — no new oracle path. On a band trip:
 *   - the reference confirms the winner (within the band of it) → NO
 *     demotion, regardless of the pairwise spread: the low-baller achieves
 *     nothing (the attack NEW2-M-01 describes);
 *   - the winner deviates ABOVE the reference beyond the band → demoted —
 *     the #260 mis-scale / garbage-high defence, preserved exactly;
 *   - the winner sits BELOW the reference beyond the band (moved market or
 *     stale reference; the runner-up is lower still) → kept but flagged:
 *     demoting would present something even LOWER — the very lever this
 *     change removes from attackers;
 *   - NO reference exists (oracle-less AND DefiLlama-less pair) → flag-
 *     without-reorder: `lowConfidence` fires, nothing is demoted. The
 *     residual of a shown-but-garbage-high winner is bounded by the on-chain
 *     minimumOutput (a fill priced off a garbage-high quote reverts rather
 *     than executes), the tiered USD limits (oracle-less >$10k is already
 *     blocked) and the rendered cue.
 *
 * Behaviour when quorum < 3:
 *   - 2 responders: a winner within LOW_QUORUM_MAX_DEVIATION_BPS of the
 *     runner-up passes untouched — no false drops for legitimately thin
 *     markets. Beyond the band → reference-confirmed demotion as above.
 *   - 1 responder: kept (never dropped — a lone quote may be a legitimately
 *     thin market) but flagged low-confidence: with one responder there is
 *     zero cross-check (the median filter needs 3, the band needs 2).
 *   - 0 or ≥3 responders: passthrough — the caller's empty-quote error and
 *     the 3×-median filter own those quorums.
 *
 * Composition and determinism: the sanity stays BEFORE the 3×-median filter
 * (single demotion authority at n<3 — no double-demotion), and
 * applyLowQuorumSanity stays pure — the reference is resolved by the caller
 * (lazily, only when lowQuorumBandTripped says a demotion decision is
 * actually pending) and passed IN, so identical inputs always produce
 * identical outputs (the NEW-1 determinism / tie-stability guards hold).
 *
 * The `lowConfidence` flag is rendered as an informational (non-alarmist) cue
 * in QuoteBreakdown, so a thin quorum is never silent to the user.
 *
 * Threshold rationale: 500 bps (5%) mirrors CROSS_QUOTE_WARN_THRESHOLD (0.05)
 * already used for the cross-quote deviation warning, and the SAME band gates
 * the winner-vs-reference check — this chore adds no new threshold. Legitimate
 * 2-source spread on quotable pairs is well under 1%; every mis-scale/units
 * defect observed (10^6–10^18×) exceeds the band by orders of magnitude. Two
 * responders that are BOTH mis-scaled by the same factor still cannot be
 * caught pairwise (the band never trips, so the reference is never consulted
 * — reference-confirmation gates demotion, it never creates one); that
 * residual keeps belonging to the execution-time guards.
 *
 * Reconciliation with the #248 DCA deviation guard (contracts/order-engine/
 * executor/deviation-guard.js): that guard runs keeper-side at DCA fill time,
 * comparing the order's already-pinned router against a fresh cross-
 * aggregator best (1% threshold, fail-open) — it can only DEFER a fill within
 * a bounded window, never re-route. Different layer (execution quality of a
 * signed order) vs this module (pre-signature presentation); no shared state,
 * no conflict. This module reuses #248's PRICE plumbing (fetchDefiLlamaPrice),
 * not that gate.
 *
 * Distinct from quorum-check.ts (H5): that is a PERIODIC monitoring cross-check
 * on reference pairs that can flag/disable a source via the state machine; this
 * runs PER REQUEST on the actual displayed quote list and only demotes the
 * presented winner. H5 also never sees quotes the filters drop — this module is
 * the one that catches them at the moment they would have been shown.
 */
import type { NormalizedQuote } from './adapters/types'
import { fetchChainlinkPriceRaw } from './chainlink'
import { fetchDefiLlamaPrice } from './defillama'
import { DEFAULT_CHAIN_ID, getChainConfig } from './chains/registry'

/** Default winner-vs-runner-up deviation band, in basis points (500 = 5%). */
export const LOW_QUORUM_MAX_DEVIATION_BPS = 500

/**
 * The active band: `LOW_QUORUM_MAX_DEVIATION_BPS` env override when it parses
 * to a positive integer, else the 500 bps default.
 */
export function getLowQuorumMaxDeviationBps(): number {
  const raw = process.env.LOW_QUORUM_MAX_DEVIATION_BPS
  if (!raw) return LOW_QUORUM_MAX_DEVIATION_BPS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return LOW_QUORUM_MAX_DEVIATION_BPS
  return parsed
}

export interface QuorumSanityOutcome {
  /** Display list, best-first, with any demoted winner removed. */
  quotes: NormalizedQuote[]
  /** Quotes removed from the display (never shown as best OR in Compare). */
  demoted: NormalizedQuote[]
  /** True when the displayed best could not be cross-validated (1 responder,
   *  a demotion happened, an unusable runner-up amount, or a band trip the
   *  reference could not adjudicate — including the no-reference fallback). */
  lowConfidence: boolean
}

function parseAmount(quote: NormalizedQuote): bigint | null {
  try {
    const v = BigInt(quote.toAmount)
    return v > 0n ? v : null
  } catch {
    return null
  }
}

/** (winner − runnerUp) / runnerUp × 10_000, in BigInt (truncating). */
function pairwiseDeviationBps(winnerAmount: bigint, runnerAmount: bigint): bigint {
  return ((winnerAmount - runnerAmount) * 10_000n) / runnerAmount
}

/**
 * True exactly when the 2-responder winner/runner-up spread exceeds the band —
 * i.e. when applyLowQuorumSanity has a demotion decision PENDING and needs the
 * external reference to adjudicate it. Callers use this to resolve the
 * reference lazily: the healthy path (agreeing quotes, other quorums,
 * unparseable amounts) never pays a reference lookup.
 */
export function lowQuorumBandTripped(sorted: NormalizedQuote[]): boolean {
  if (sorted.length !== 2) return false
  const winnerAmount = parseAmount(sorted[0])
  const runnerAmount = parseAmount(sorted[1])
  if (winnerAmount === null || runnerAmount === null) return false
  return pairwiseDeviationBps(winnerAmount, runnerAmount) > BigInt(getLowQuorumMaxDeviationBps())
}

/**
 * Apply the low-quorum sanity band to a best-first-sorted quote list.
 * Pure function — no I/O, no mutation of the input array.
 *
 * `referenceToAmount` is the fair expected output for THIS trade in raw
 * toToken units (see computeReferenceToAmount), resolved by the caller from
 * the #18/#248 plumbing. Absent / non-positive ⇒ no reference: a tripped band
 * falls back to flag-without-reorder [NEW2-M-01].
 */
export function applyLowQuorumSanity(
  sorted: NormalizedQuote[],
  referenceToAmount?: bigint | null,
): QuorumSanityOutcome {
  if (sorted.length === 0 || sorted.length >= 3) {
    return { quotes: sorted, demoted: [], lowConfidence: false }
  }

  if (sorted.length === 1) {
    // Never drop a lone quote; there is simply nothing to validate against.
    return { quotes: sorted, demoted: [], lowConfidence: true }
  }

  const [winner, runnerUp] = sorted
  const winnerAmount = parseAmount(winner)
  const runnerAmount = parseAmount(runnerUp)

  // Unusable runner-up ⇒ no band available. Keep the winner (no false drop)
  // but flag the result — the display is effectively single-source.
  if (runnerAmount === null) {
    return { quotes: sorted, demoted: [], lowConfidence: true }
  }
  // Unusable winner amount cannot legitimately out-rank a parseable runner-up
  // (the caller pre-filters non-positive amounts); treat defensively as
  // garbage. A data-integrity defect, not a price call — the reference-
  // confirmation gate below applies to PRICE judgments only.
  if (winnerAmount === null) {
    return { quotes: [runnerUp], demoted: [winner], lowConfidence: true }
  }

  // The sort guarantees winner ≥ runnerUp on output amount.
  const bandBps = BigInt(getLowQuorumMaxDeviationBps())
  if (pairwiseDeviationBps(winnerAmount, runnerAmount) <= bandBps) {
    // Two responders that AGREE pass untouched — no false drops for
    // legitimately thin markets, and no reference is ever consulted (the
    // reference gates demotion; it never creates one).
    return { quotes: sorted, demoted: [], lowConfidence: false }
  }

  // Band tripped: one side of the pair is off, but the pairwise spread cannot
  // say WHICH. Only an external reference may authorize a demotion [NEW2-M-01].
  const reference =
    referenceToAmount != null && referenceToAmount > 0n ? referenceToAmount : null
  if (reference === null) {
    // No reference (oracle-less + DefiLlama-less pair): flag-without-reorder.
    // A low-baller can no longer force the honest winner out of the presented
    // slot; a garbage-high winner is shown but flagged, and what a user could
    // actually lose stays bounded by minimumOutput + the tiered USD limits.
    return { quotes: sorted, demoted: [], lowConfidence: true }
  }

  const refDeviationBps = ((winnerAmount - reference) * 10_000n) / reference
  if (refDeviationBps > bandBps) {
    // The reference confirms the WINNER is the outlier (mis-scale, units bug,
    // inflated quote) — the sane runner-up becomes the presented best.
    return { quotes: [runnerUp], demoted: [winner], lowConfidence: true }
  }
  if (refDeviationBps < -bandBps) {
    // The winner (and the even-lower runner-up) sit below the reference:
    // unconfirmable, but demoting would present something LOWER still — keep
    // the order and flag it.
    return { quotes: sorted, demoted: [], lowConfidence: true }
  }

  // The reference confirms the winner: the pairwise spread was the RUNNER-UP
  // lying (the NEW2-M-01 low-ball shape). Externally cross-validated ⇒ not
  // low-confidence.
  return { quotes: sorted, demoted: [], lowConfidence: false }
}

// ══════════════════════════════════════════════════════════
//  REFERENCE WIRING [CHORE-QUORUM-REFERENCE-CONFIRMED-DEMOTION]
//  Reuses the #18 Chainlink consent-gate feed and the #248 DefiLlama price —
//  never builds an oracle path of its own.
// ══════════════════════════════════════════════════════════

/** Trade context needed to price a fair expected output for the pair. */
export interface QuorumReferenceParams {
  src: string
  dst: string
  /** Raw sell amount (bigint string), as passed to the adapters. */
  amount: string
  srcDecimals: number
  dstDecimals: number
  /** Omitted → mainnet (DEFAULT_CHAIN_ID), matching fetchMetaQuote. */
  chainId?: number
}

/** An external fair-output reference and which existing plumbing produced it. */
export interface QuorumReference {
  /** Fair expected output for the trade, in raw toToken units. */
  toAmount: bigint
  source: 'chainlink' | 'defillama'
}

/**
 * Fair expected output for a trade from two USD legs — the same fair-value
 * formula as the #248 server guard (validateSwapPrice):
 *   fairOut = amountIn / 10^srcDecimals × (srcUsd / dstUsd) × 10^dstDecimals
 * Pure; returns null on any unusable input. Float precision (≤ ~1e-16
 * relative) is orders of magnitude below the 500 bps decision threshold.
 */
export function computeReferenceToAmount(params: {
  amount: string
  srcDecimals: number
  dstDecimals: number
  srcUsd: number
  dstUsd: number
}): bigint | null {
  const { amount, srcDecimals, dstDecimals, srcUsd, dstUsd } = params
  if (!Number.isFinite(srcUsd) || srcUsd <= 0) return null
  if (!Number.isFinite(dstUsd) || dstUsd <= 0) return null
  if (!Number.isInteger(srcDecimals) || srcDecimals < 0 || srcDecimals > 36) return null
  if (!Number.isInteger(dstDecimals) || dstDecimals < 0 || dstDecimals > 36) return null

  let raw: bigint
  try {
    raw = BigInt(amount)
  } catch {
    return null
  }
  if (raw <= 0n) return null

  const wholeIn = Number(raw) / 10 ** srcDecimals
  const fairRawOut = wholeIn * (srcUsd / dstUsd) * 10 ** dstDecimals
  if (!Number.isFinite(fairRawOut) || fairRawOut <= 0) return null
  try {
    return BigInt(Math.round(fairRawOut))
  } catch {
    return null
  }
}

/**
 * Resolve the external reference for a pair from EXISTING plumbing, in the
 * project's oracle order: Chainlink first (#18 consent-gate feed — round
 * integrity, per-feed staleness and the L2 sequencer gate all enforced inside
 * fetchChainlinkPriceRaw), else DefiLlama (#248 — confidence ≥ 0.5 enforced
 * inside fetchDefiLlamaPrice, 2-min cache), using the same chainId → slug
 * mapping as the swap-route guard (unknown chain → 'ethereum'). BOTH legs of
 * one source must price — legs are never mixed across sources (a ratio built
 * from two methodologies is not a reference). Never throws; null means "no
 * reference exists" and callers fall back to flag-without-reorder.
 */
export async function resolveQuorumReference(
  params: QuorumReferenceParams,
): Promise<QuorumReference | null> {
  const { src, dst, amount, srcDecimals, dstDecimals } = params
  const cid = params.chainId ?? DEFAULT_CHAIN_ID

  try {
    const [srcFeed, dstFeed] = await Promise.all([
      fetchChainlinkPriceRaw(src, cid).catch(() => null),
      fetchChainlinkPriceRaw(dst, cid).catch(() => null),
    ])
    if (srcFeed && dstFeed) {
      const toAmount = computeReferenceToAmount({
        amount, srcDecimals, dstDecimals, srcUsd: srcFeed.price, dstUsd: dstFeed.price,
      })
      if (toAmount !== null) return { toAmount, source: 'chainlink' }
    }
  } catch {
    /* fall through to DefiLlama */
  }

  try {
    const slug = (() => {
      try {
        return getChainConfig(cid).slug
      } catch {
        return 'ethereum'
      }
    })()
    const [srcPrice, dstPrice] = await Promise.all([
      fetchDefiLlamaPrice(src, slug).catch(() => null),
      fetchDefiLlamaPrice(dst, slug).catch(() => null),
    ])
    if (srcPrice && dstPrice) {
      const toAmount = computeReferenceToAmount({
        amount, srcDecimals, dstDecimals, srcUsd: srcPrice.price, dstUsd: dstPrice.price,
      })
      if (toAmount !== null) return { toAmount, source: 'defillama' }
    }
  } catch {
    /* no reference — callers flag without reordering */
  }

  return null
}

/**
 * The wiring fetchMetaQuote consumes: resolve the reference LAZILY (only when
 * the band actually tripped — the healthy path performs zero lookups), then
 * apply the pure sanity. The resolved reference is returned alongside the
 * outcome so the caller can attribute a demotion in its logs.
 */
export async function applyLowQuorumSanityWithReference(
  sorted: NormalizedQuote[],
  params: QuorumReferenceParams,
): Promise<QuorumSanityOutcome & { reference: QuorumReference | null }> {
  const reference = lowQuorumBandTripped(sorted)
    ? await resolveQuorumReference(params)
    : null
  const outcome = applyLowQuorumSanity(sorted, reference?.toAmount ?? null)
  return { ...outcome, reference }
}
