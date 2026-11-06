/**
 * [P140] Smart CoW preference selection — pure, deterministic, testable.
 *
 * Extracted from the SwapBox useMemo so the routing logic can be exercised
 * directly without rendering the component.
 *
 * [feat/retire-force-mev, owner decision 2026-11-06] The "Force MEV Protection" toggle is retired
 * (CoW's free quote API has answered 429 to our servers since 2026-10-29; TeraSwap makes no MEV-related
 * promise any more). Its strict CoW-only filter is gone; the second argument is DEPRECATED and IGNORED.
 * CoW stays an ordinary source: queried, ranked, and selected when it wins.
 *
 * The one remaining path (ranking rule, unchanged): if best is not a
 * `mevProtected`-flagged source (CoW) and a CoW quote exists within
 * `threshold` of the best output AND the gasless engine flags it as
 * net-positive (gasless.recommended), promote CoW into best. Otherwise
 * leave best untouched.
 */
import type { MetaQuoteResult } from '@/lib/api'
import type { AGGREGATOR_META } from '@/lib/constants'
import { safeBigInt } from '@/lib/utils'

export interface MevPreferenceResult {
  meta: MetaQuoteResult | null
  /** True when path 2 actively promoted CoW into best. */
  smartMevApplied: boolean
  /**
   * @deprecated [feat/retire-force-mev] Still computed (best stayed a non-CoW source), but no UI reads it:
   * the "CoW Protocol available… Enable" strip it drove is retired with the toggle.
   */
  mevExposedBest: boolean
}

export function selectBestWithMevPreference(
  rawMeta: MetaQuoteResult | null,
  /**
   * @deprecated [feat/retire-force-mev, owner 2026-11-06] Was the "Force MEV Protection" toggle (strict CoW-only
   * filter). IGNORED: `true` and `false` select identically. Callers pass `false` (the old default).
   */
  _forceMevProtected: boolean,
  aggregatorMeta: typeof AGGREGATOR_META,
  threshold: number,
): MevPreferenceResult {
  if (!rawMeta) {
    return { meta: null, smartMevApplied: false, mevExposedBest: false }
  }

  // Smart preference — promote CoW if within threshold of best.
  const bestIsMevProtected = aggregatorMeta[rawMeta.best.source]?.mevProtected ?? false
  if (bestIsMevProtected) {
    // Best already is the CoW (mevProtected-flagged) source. No promotion
    // needed; not "exposed".
    return { meta: rawMeta, smartMevApplied: false, mevExposedBest: false }
  }

  const cowQuote = rawMeta.all.find(q => aggregatorMeta[q.source]?.mevProtected)
  if (cowQuote) {
    // [11-L-01] safeBigInt: malformed quote amount → skip MEV promotion.
    const bestAmount = safeBigInt(rawMeta.best.toAmount)
    const cowAmount = safeBigInt(cowQuote.toAmount)
    if (bestAmount !== null && cowAmount !== null && bestAmount > 0n && cowAmount > 0n && cowAmount <= bestAmount) {
      const shortfallBps = ((bestAmount - cowAmount) * 10_000n) / bestAmount
      const thresholdBps = safeBigInt(Math.round(threshold * 10_000)) ?? 0n
      // [P138] Promotion requires both:
      //   (a) shortfall within threshold (now 15 bps)
      //   (b) gasless engine net-positive verdict
      if (shortfallBps <= thresholdBps && rawMeta.gasless?.recommended) {
        const others = rawMeta.all.filter(q => q.source !== cowQuote.source)
        return {
          meta: { ...rawMeta, best: cowQuote, all: [cowQuote, ...others] },
          smartMevApplied: true,
          mevExposedBest: false,
        }
      }
    }
  }

  // Best stays as-is (a non-CoW source) → mevExposedBest (deprecated, no UI reads it).
  return { meta: rawMeta, smartMevApplied: false, mevExposedBest: true }
}
