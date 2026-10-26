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
import { fmtPct } from '@/lib/format'
import { safeBigInt } from '@/lib/utils'
import { FEE_BPS, type AggregatorName } from '@/lib/constants'
import { sameQuotePair, type QuotePairRef } from '@/lib/quote-identity'

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

// ── Skip list ────────────────────────────────────────────────────────────
// Sources exempt from the floor. This deliberately NO LONGER mirrors api.ts
// `validateFeeIntegrity`'s `skipSources`: that list guards a CEILING for
// partner-fee sources, and copying it onto the floor side did not survive
// review (Auditor M-01/M-02 on this branch). Per entry:
//   - 'uniswapv3'  KEPT — structural divergence, not market drift. The /swap
//     build RE-DETECTS the fee tier and returns THAT tier's output
//     (src/lib/adapters/uniswapv3.ts:247-271 — both branches overwrite the
//     quote's tier with `detection.bestFee`), so when the best tier changes
//     between /price and /swap, quote and swap are measuring two DIFFERENT
//     pools. The gap is then a fee-tier delta plus another pool's depth,
//     which no market-drift tolerance can bound, and it is a legitimate
//     re-route to the best available pool — not a tampering signal.
//   - 'curve'      REMOVED (Auditor M-02: the stated reason did not hold).
//     Quote and build resolve the SAME statically-mapped pool through the
//     same `findPool` lookup (src/lib/adapters/curve.ts:172 quote, :234
//     build) and both read `get_dy` on it, so the only divergence is
//     ordinary market drift — the same class every aggregator has, already
//     absorbed by slippage + SWAP_QUOTE_TOLERANCE_BPS. Now checked wherever
//     a Curve swap step exists, on every chain that has one.
//   - 'cowswap'    REMOVED (Auditor M-01: dead exemption). It cannot reach
//     this function on any path — useSwap's execute() dispatches it to
//     executeCowSwap before executeStandardSwap (src/hooks/useSwap.ts:
//     1058-1059), and SPLIT_ELIGIBLE_SOURCES excludes it
//     (src/lib/split-routing-types.ts:96) so it is never a split leg either.
//     An entry that can only ever be unreachable is worse than no entry: it
//     reads as a considered carve-out for a path nobody has checked.
const QUOTE_FLOOR_SKIP_SOURCES: readonly AggregatorName[] = ['uniswapv3']

/**
 * The basis a /swap response is floored against.
 *
 * The FeeCollector takes FEE_BPS off the INPUT before the router ever prices
 * the trade (`apiAmountBn` in useSwap.ts, `apiAmount` in useSplitSwap.ts), so a
 * fee-routed swap's output sits ~FEE_BPS below the GROSS /price quote by
 * construction. Flooring against the gross quote therefore spent 10 of the 50
 * bps tolerance before any real drift, leaving ~40 — netting the fee out here
 * makes SWAP_QUOTE_TOLERANCE_BPS mean what it says (Architect ruling, round 3).
 *
 * First-order by design: the fee scales the input and output scales ~linearly
 * with input over a 10 bps step. This is not a pool-curve model and does not
 * need to be — it only has to be right to well inside the tolerance it frees.
 */
export function feeAdjustedQuoteBasis(quoteToAmount: bigint, routeViaFeeCollector: boolean): bigint {
  if (!routeViaFeeCollector) return quoteToAmount
  return (quoteToAmount * (10_000n - BigInt(FEE_BPS))) / 10_000n
}

/** Why a swap was refused against the accepted quote. 'below' is the original floor breach. */
export type StaleOrTamperedKind = 'below' | 'above' | 'pair-mismatch'

export class StaleOrTamperedSwapError extends Error {
  /** Positive percentage the swap output landed away from the accepted quote
   *  (below it for 'below', above it for 'above'), or null when there was NO
   *  usable accepted quote to compare against, or the pair did not match. */
  readonly deviationPercent: number | null
  readonly kind: StaleOrTamperedKind

  /** @param deviationPercent null = no accepted quote at all (fail-closed). */
  constructor(deviationPercent: number | null, kind: StaleOrTamperedKind = 'below') {
    super(
      kind === 'pair-mismatch'
        ? 'The quote you accepted was for a different pair or network — swap refused. ' +
            'Please refresh the quote and try again.'
        : deviationPercent === null
          ? 'No accepted quote to compare this swap against — swap refused. ' +
            'Please refresh the quote and try again.'
          : kind === 'above'
            ? `Swap output is above the quote you accepted (+${fmtPct(deviationPercent, 1)}). ` +
              'The route was refreshed — please review and try again.'
            : `Swap output is below the quote you accepted (−${fmtPct(deviationPercent, 1)}). ` +
              'The route was refreshed — please review and try again.',
    )
    this.name = 'StaleOrTamperedSwapError'
    this.deviationPercent = deviationPercent
    this.kind = kind
  }
}

export interface AssertSwapConsistentWithQuoteParams {
  /** toAmount from the /price quote the user reviewed before confirming. */
  quoteToAmount: unknown
  /** toAmount from the /swap response about to become minimumOutput's basis. */
  swapToAmount: unknown
  /** User's slippage tolerance, percentage (e.g. 0.5 = 0.5%). */
  slippagePercent: number
  /** The source whose /swap response is being bounded, or `null` for a
   *  source-agnostic aggregate (a split's total). `null` is NEVER skip-listed
   *  — that is the point: the aggregate still bounds the total of a split
   *  that contains an exempt leg. */
  source: AggregatorName | null
  /** true when this swap routes through the FeeCollector, which takes FEE_BPS
   *  off the input before the router prices it — see feeAdjustedQuoteBasis.
   *  Pass false when the basis handed in is ALREADY net of the fee (the split
   *  aggregate nets it per leg, since legs can be mixed). */
  routeViaFeeCollector: boolean
  /** [fix/stale-quote-pair-flip] Chain/pair/decimals the accepted quote answered. */
  quotePair?: QuotePairRef
  /** [fix/stale-quote-pair-flip] Chain/pair/decimals this /swap response was built for.
   *  Supply BOTH or NEITHER: one without the other is a wiring error and is refused. */
  swapPair?: QuotePairRef
}

/**
 * Floor counterpart to `validateFeeIntegrity`'s ceiling: throws when a
 * /swap response's `toAmount` is lower than the /price quote can plausibly
 * explain. The formula, in full:
 *
 *   basis = routeViaFeeCollector ? quote * (10000 - FEE_BPS) / 10000 : quote
 *   floor = basis * (10000 - slippageBps - SWAP_QUOTE_TOLERANCE_BPS) / 10000
 *   throws  ⟺  swapToAmount < floor
 *
 * [fix/stale-quote-pair-flip] The check is TWO-SIDED with the same tolerance:
 *
 *   ceiling = basis * (10000 + slippageBps + SWAP_QUOTE_TOLERANCE_BPS) / 10000
 *   throws  ⟺  swapToAmount > ceiling      (kind 'above')
 *
 * A quote in a SMALLER raw scale than the fresh swap (e.g. a 6-decimal USDC quote
 * against an 18-decimal ETH swap — the ⇅-flip stale-quote shape) used to pass
 * silently because only "swap below quote" was refused. Also refuses (kind
 * 'pair-mismatch') when `quotePair`/`swapPair` are given and differ — checked
 * BEFORE the skip list, which exempts fee-tier drift, never a different pair.
 *
 * (BigInt floor division throughout, mirroring `deriveMinimumOutput`'s own bps
 * arithmetic.)
 *
 * Complementary to `validateFeeIntegrity`, never a replacement for it:
 * that check catches an implausibly HIGH output (ceiling, partner-fee
 * sources only); this one catches an implausibly LOW output (floor, every
 * source not on the skip list above).
 *
 * FAIL-CLOSED: a missing/unusable `quoteToAmount` is a refusal, not a skip.
 * Every call site runs after the user accepted a quote, so "no quote" is a
 * wiring failure or tampering — and a warn-and-proceed branch there made the
 * whole check a no-op on the normal path (Auditor H-01 on this branch).
 *
 * @throws StaleOrTamperedSwapError with `deviationPercent === null` when
 *         there is no usable accepted quote to compare against.
 * @throws UnusableQuoteError when the SWAP amount is missing/non-numeric —
 *         the same refusal shape `deriveMinimumOutput` already uses, so
 *         callers see one consistent "unusable quote" failure mode.
 * @throws StaleOrTamperedSwapError when `swapToAmount` is below the floor.
 */
export function assertSwapConsistentWithQuote(params: AssertSwapConsistentWithQuoteParams): void {
  const { quoteToAmount, swapToAmount, slippagePercent, source, routeViaFeeCollector, quotePair, swapPair } = params
  if (quotePair !== undefined || swapPair !== undefined) {
    // Both or neither; a lone key can't prove anything, so it refuses (fail closed).
    if (quotePair === undefined || swapPair === undefined || !sameQuotePair(quotePair, swapPair)) {
      throw new StaleOrTamperedSwapError(null, 'pair-mismatch')
    }
  }
  if (source !== null && QUOTE_FLOOR_SKIP_SOURCES.includes(source)) return

  const quotedBn = safeBigInt(quoteToAmount)
  if (quotedBn === null || quotedBn <= 0n) throw new StaleOrTamperedSwapError(null)

  // Only the SWAP side can still be unusable at this point, so the
  // diagnostic carries the swap amount — the value that actually failed to
  // parse. It previously reported `swapToAmount` for a malformed QUOTE too
  // (Auditor L on minimum-output.ts:139).
  const swappedBn = safeBigInt(swapToAmount)
  if (swappedBn === null || swappedBn < 0n) throw new UnusableQuoteError(swapToAmount)

  const basisBn = feeAdjustedQuoteBasis(quotedBn, routeViaFeeCollector)
  const slippageBpsBn = BigInt(Math.max(0, Math.round(slippagePercent * 100)))
  const combinedBpsBn = slippageBpsBn + BigInt(SWAP_QUOTE_TOLERANCE_BPS)
  const floorBn = combinedBpsBn >= 10_000n ? 0n : (basisBn * (10_000n - combinedBpsBn)) / 10_000n

  const ceilingBn = (basisBn * (10_000n + combinedBpsBn)) / 10_000n
  if (swappedBn > ceilingBn) {
    // Against the GROSS quote, same as the floor branch: the figure the user accepted.
    const deviationPercent = Number(((swappedBn - quotedBn) * 10_000n) / quotedBn) / 100
    throw new StaleOrTamperedSwapError(deviationPercent, 'above')
  }

  if (swappedBn < floorBn) {
    // Reported against the GROSS quote, not the fee-adjusted basis: the figure
    // the user accepted is the gross one, and the 0.1% fee is disclosed
    // separately. The floor uses the basis; the copy quotes what they saw.
    const deviationPercent = Number(((quotedBn - swappedBn) * 10_000n) / quotedBn) / 100
    throw new StaleOrTamperedSwapError(deviationPercent)
  }
}
