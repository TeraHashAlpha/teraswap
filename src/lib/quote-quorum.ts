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
 * presented quote; they cannot restore a better quote this module demoted.
 *
 * Behaviour when quorum < 3:
 *   - 2 responders: the winner must be within LOW_QUORUM_MAX_DEVIATION_BPS of
 *     the runner-up. A winner beyond the band is demoted (the sane runner-up
 *     becomes the presented best) and the result is flagged low-confidence.
 *     A quote the two responders AGREE on passes untouched — no false drops
 *     for legitimately thin markets.
 *   - 1 responder: kept (never dropped — a lone quote may be a legitimately
 *     thin market) but flagged low-confidence: with one responder there is
 *     zero cross-check (the median filter needs 3, the band needs 2).
 *   - 0 or ≥3 responders: passthrough — the caller's empty-quote error and
 *     the 3×-median filter own those quorums.
 *
 * The `lowConfidence` flag is rendered as an informational (non-alarmist) cue
 * in QuoteBreakdown, so a thin quorum is never silent to the user.
 *
 * Threshold rationale: 500 bps (5%) mirrors CROSS_QUOTE_WARN_THRESHOLD (0.05)
 * already used for the cross-quote deviation warning. Legitimate 2-source
 * spread on quotable pairs is well under 1%; every mis-scale/units defect
 * observed (10^6–10^18×) exceeds the band by orders of magnitude. Two
 * responders that are BOTH mis-scaled by the same factor cannot be caught by
 * any pairwise band — that residual case needs an external reference (#248
 * cross-agg guard at execution / #18 oracle advisory) and is out of display
 * scope by design.
 *
 * KNOWN ADVERSARIAL ASYMMETRY (characterized in the adversarial tests;
 * flagged for the Auditor — do not "fix" silently): the band sees one
 * pairwise spread, so it cannot tell "winner too high" from "runner-up too
 * low", yet it always demotes the WINNER. A source quoting >band UNDER an
 * honest winner therefore gets the honest quote demoted and is itself
 * presented as best. Mitigations that bound this steering: the guaranteed
 * `lowConfidence` cue, the client Chainlink price gate on feeded pairs
 * (explicit informed consent required from 2% deviation, hard block beyond
 * the 25% consent ceiling — price-gate.ts), the non-overridable server-side
 * DefiLlama guard (422 when output is too far below fair value), and the
 * executed quote's own on-chain minimumOutput.
 *
 * Reconciliation with the #248 DCA deviation guard (contracts/order-engine/
 * executor/deviation-guard.js): that guard runs keeper-side at DCA fill time,
 * comparing the order's already-pinned router against a fresh cross-
 * aggregator best (1% threshold, fail-open) — it can only DEFER a fill within
 * a bounded window, never re-route. Different layer (execution quality of a
 * signed order) vs this module (pre-signature presentation); no shared state,
 * no conflict.
 *
 * Distinct from quorum-check.ts (H5): that is a PERIODIC monitoring cross-check
 * on reference pairs that can flag/disable a source via the state machine; this
 * runs PER REQUEST on the actual displayed quote list and only demotes the
 * presented winner. H5 also never sees quotes the filters drop — this module is
 * the one that catches them at the moment they would have been shown.
 */
import type { NormalizedQuote } from './adapters/types'

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
   *  a demotion happened, or the runner-up amount was unusable). */
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

/**
 * Apply the low-quorum sanity band to a best-first-sorted quote list.
 * Pure function — no I/O, no mutation of the input array.
 */
export function applyLowQuorumSanity(sorted: NormalizedQuote[]): QuorumSanityOutcome {
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
  // (the caller pre-filters non-positive amounts); treat defensively as garbage.
  if (winnerAmount === null) {
    return { quotes: [runnerUp], demoted: [winner], lowConfidence: true }
  }

  // deviation_bps = (winner - runnerUp) / runnerUp × 10_000, in BigInt.
  // The sort guarantees winner ≥ runnerUp on output amount.
  const bandBps = BigInt(getLowQuorumMaxDeviationBps())
  const deviationBps = ((winnerAmount - runnerAmount) * 10_000n) / runnerAmount

  if (deviationBps > bandBps) {
    return { quotes: [runnerUp], demoted: [winner], lowConfidence: true }
  }

  return { quotes: sorted, demoted: [], lowConfidence: false }
}
