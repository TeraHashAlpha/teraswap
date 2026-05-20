/**
 * [P140] Smart MEV preference selection — pure, deterministic, testable.
 *
 * Extracted from the SwapBox useMemo so the routing logic can be exercised
 * directly without rendering the component. Behaviour is identical to the
 * inline implementation it replaces.
 *
 * Two paths:
 *   1. mevProtected = true  → strict filter: keep only MEV-protected
 *      sources. If none exist, return meta=null so the UI can surface
 *      "no MEV-protected quote available".
 *   2. mevProtected = false → if best is not MEV-protected and a CoW
 *      quote exists within `threshold` of the best output AND the
 *      gasless engine flags it as net-positive (gasless.recommended),
 *      promote CoW into best. Otherwise leave best untouched and flag
 *      the route as MEV-exposed so the UI can offer the toggle.
 */
import type { MetaQuoteResult } from '@/lib/api'
import type { AGGREGATOR_META } from '@/lib/constants'
import { safeBigInt } from '@/lib/utils'

export interface MevPreferenceResult {
  meta: MetaQuoteResult | null
  /** True when path 2 actively promoted CoW into best. */
  smartMevApplied: boolean
  /** True when best stayed non-MEV-protected and the user hasn't forced. */
  mevExposedBest: boolean
}

export function selectBestWithMevPreference(
  rawMeta: MetaQuoteResult | null,
  mevProtected: boolean,
  aggregatorMeta: typeof AGGREGATOR_META,
  threshold: number,
): MevPreferenceResult {
  if (!rawMeta) {
    return { meta: null, smartMevApplied: false, mevExposedBest: false }
  }

  // Path 1: forced — strict MEV-only filter.
  if (mevProtected) {
    const mevSources = rawMeta.all.filter(q => aggregatorMeta[q.source]?.mevProtected)
    if (mevSources.length === 0) {
      return { meta: null, smartMevApplied: false, mevExposedBest: false }
    }
    return {
      meta: { ...rawMeta, best: mevSources[0], all: mevSources },
      smartMevApplied: false, // user forced it; not a smart-routing event
      mevExposedBest: false,
    }
  }

  // Path 2: smart preference — promote CoW if within threshold of best.
  const bestIsMevProtected = aggregatorMeta[rawMeta.best.source]?.mevProtected ?? false
  if (bestIsMevProtected) {
    // Best already happens to be MEV-protected. No promotion needed; no
    // exposure warning needed.
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

  // Best stays as-is; non-MEV-protected → mark exposed for the UI hint.
  return { meta: rawMeta, smartMevApplied: false, mevExposedBest: true }
}
