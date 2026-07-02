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
