/**
 * [AUDIT-W2 / W2-L-01] FeeCollector minimumOutput derivation — single source
 * of truth for the three call sites (useSwap, useSplitSwap, buildSimulationTx).
 *
 * minimumOutput = toAmount * (10000 - slippageBps) / 10000 — the floor the
 * deployed FeeCollector enforces ON-CHAIN against the user's own tokenOut
 * balance delta (InsufficientOutput revert). It is the last line of defence
 * on the fee-routed swap path.
 *
 * Previously a malformed / zero / unparseable quote toAmount fell back to
 * minimumOutput = 0n ("better degraded than dead", 10-L-01) — which silently
 * DISABLED that on-chain check for the swap (or split leg). Per W2-L-01 an
 * unusable quote must instead REFUSE the swap: this throws UnusableQuoteError,
 * which callers surface as a normal refusal (single-swap error + 9O fallback
 * walk to the next source / skipped split leg — never a signed transaction).
 *
 * Slippage >= 100% with a VALID toAmount still yields 0n: that is an explicit
 * user setting, not a malformed quote (behaviour unchanged, UI caps apply).
 */
import { safeBigInt } from '@/lib/utils'
import type { AggregatorName } from '@/lib/constants'

export class UnusableQuoteError extends Error {
  /** Raw toAmount as received (truncated) — for diagnostics, never re-parsed. */
  readonly rawToAmount: string

  constructor(toAmount: unknown) {
    super(
      'Unusable quote: no valid output amount — swap refused to keep the ' +
        'on-chain minimum-output protection active. Try another source.',
    )
    this.name = 'UnusableQuoteError'
    this.rawToAmount = String(toAmount).slice(0, 64)
  }
}

/**
 * Derive the FeeCollector `minimumOutput` argument from a quote's `toAmount`
 * and the user's slippage tolerance (percentage, e.g. 0.5 = 0.5%).
 *
 * @throws UnusableQuoteError when `toAmount` is missing, non-numeric or <= 0 —
 *         callers must treat this as "refuse the swap", NOT as minimumOutput 0.
 */
export function deriveMinimumOutput(toAmount: unknown, slippagePercent: number): bigint {
  const toAmountBn = safeBigInt(toAmount)
  if (toAmountBn === null || toAmountBn <= 0n) {
    throw new UnusableQuoteError(toAmount)
  }
  const slippageBpsBn = BigInt(Math.max(0, Math.round(slippagePercent * 100)))
  if (slippageBpsBn >= 10_000n) return 0n
  return (toAmountBn * (10_000n - slippageBpsBn)) / 10_000n
}

// ══════════════════════════════════════════════════════════
//  [fix/swap-toamount-lower-bound-vs-quote] Quote-vs-swap floor
// ══════════════════════════════════════════════════════════
//
// Architect ruling on Auditor H-01 (PR #524 docs/feedback/
// fix-r1-augustus-v6-group-f-decoded.md): `deriveMinimumOutput` above derives
// the FeeCollector floor from `swapData.toAmount` — the SAME /swap response
// it is meant to bound. `validateFeeIntegrity` (api.ts) only rejects a swap
// output that is implausibly HIGH (+2% ceiling, FEE_NATIVE_SOURCES only). A
// tampered or degraded /swap response with a tiny toAmount therefore
// produces a tiny on-chain floor with nothing generic standing in the way
// (only the server-side oracle guard, −8%, priced tokens only). This closes
// that class for every source: the /swap output must be consistent with the
// /price quote the user actually accepted, floor side, not just ceiling side.

/** 0.5% — quote age (time between /price and /swap) + normal routing/pool
 *  drift, calibrated the same way as the ceiling side (api.ts
 *  validateFeeIntegrity uses a 2% one-sided tolerance for the same reason).
 *  Kept far tighter than that ceiling because this is a FLOOR: a legitimate
 *  swap should track its own quote closely, whereas the ceiling has to
 *  tolerate an aggregator's output landing anywhere UP TO a real price move. */
export const SWAP_QUOTE_TOLERANCE_BPS = 50

// Mirrors api.ts validateFeeIntegrity's `skipSources` EXACTLY. These are
// sources where quote-vs-build divergence is expected and NOT a tampering
// signal:
//   - 'uniswapv3' / 'curve'  direct on-chain pools — the build reads live
//     reserves at execution time, so a quote taken seconds earlier can
//     legitimately land outside a tight floor on a fast-moving pool.
//   - 'cowswap'              intent-based; a solver can fill ABOVE (surplus)
//     or, for a partial/competitive fill, at a different price than the
//     indicative quote. Neither is tampering.
// No shared export to import from: api.ts pulls in server-only adapter/
// rate-limiter modules this client hook must not bundle. Kept in sync
// manually — same trade-off already accepted for FEE_INCOMPATIBLE_SOURCES
// vs FEE_NATIVE_SOURCES in constants.ts (measured coincidence, not a
// definition, per that file's own comment).
const QUOTE_FLOOR_SKIP_SOURCES: readonly AggregatorName[] = ['uniswapv3', 'curve', 'cowswap']

export class StaleOrTamperedSwapError extends Error {
  /** Positive percentage the swap output landed below the accepted quote. */
  readonly deviationPercent: number

  constructor(deviationPercent: number) {
    super(
      `Swap output is below the quote you accepted (−${deviationPercent.toFixed(1)}%). ` +
        'The route was refreshed — please review and try again.',
    )
    this.name = 'StaleOrTamperedSwapError'
    this.deviationPercent = deviationPercent
  }
}

export interface AssertSwapConsistentWithQuoteParams {
  /** toAmount from the /price quote the user reviewed before confirming. */
  quoteToAmount: unknown
  /** toAmount from the /swap response about to become minimumOutput's basis. */
  swapToAmount: unknown
  /** User's slippage tolerance, percentage (e.g. 0.5 = 0.5%). */
  slippagePercent: number
  source: AggregatorName
}

/**
 * Floor counterpart to `validateFeeIntegrity`'s ceiling: throws when a
 * /swap response's `toAmount` is lower than the /price quote can plausibly
 * explain — i.e. below `quoteToAmount * (1 - slippage - tolerance)`.
 *
 * Complementary to `validateFeeIntegrity`, never a replacement for it:
 * that check catches an implausibly HIGH output (ceiling, partner-fee
 * sources only); this one catches an implausibly LOW output (floor, every
 * source not on the skip list above).
 *
 * @throws UnusableQuoteError when either amount is missing/non-numeric —
 *         the same refusal shape `deriveMinimumOutput` already uses, so
 *         callers see one consistent "unusable quote" failure mode.
 * @throws StaleOrTamperedSwapError when `swapToAmount` is below the floor.
 */
export function assertSwapConsistentWithQuote(params: AssertSwapConsistentWithQuoteParams): void {
  const { quoteToAmount, swapToAmount, slippagePercent, source } = params
  if (QUOTE_FLOOR_SKIP_SOURCES.includes(source)) return

  const quotedBn = safeBigInt(quoteToAmount)
  const swappedBn = safeBigInt(swapToAmount)
  if (quotedBn === null || quotedBn <= 0n || swappedBn === null || swappedBn < 0n) {
    throw new UnusableQuoteError(swapToAmount)
  }

  const slippageBpsBn = BigInt(Math.max(0, Math.round(slippagePercent * 100)))
  const combinedBpsBn = slippageBpsBn + BigInt(SWAP_QUOTE_TOLERANCE_BPS)
  const floorBn = combinedBpsBn >= 10_000n ? 0n : (quotedBn * (10_000n - combinedBpsBn)) / 10_000n

  if (swappedBn < floorBn) {
    const deviationPercent = Number(((quotedBn - swappedBn) * 10_000n) / quotedBn) / 100
    throw new StaleOrTamperedSwapError(deviationPercent)
  }
}
