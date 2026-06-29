// [chore/swap-fee-usd-fix] Platform-fee USD valuation.
//
// The platform fee (FEE_PERCENT %) is taken from the INPUT token, but its USD
// value must NOT be derived by multiplying the input-token fee amount by a price
// borrowed from the OTHER leg. `evaluatePairOracle` (src/lib/chainlink.ts) fills
// `chainlinkPrice` with the cross-leg price when a token lacks a Chainlink feed,
// so for AERO→WETH the AERO-denominated fee was being valued at WETH/ETH's price
// (~$1558), turning a ~$1.87 swap's ~$0.002 fee into ~$5.79.
//
// Instead, value the fee as FEE_PERCENT % of the swap's REAL USD notional, taken
// from whichever side is RELIABLY priced (its own oracle). Input value ≈ output
// value for the same trade, so 0.1% of either equals the fee — and we only ever
// use a price that genuinely belongs to that token. Works without an oracle on
// the fee (input) token. Oracle-input swaps are unchanged: input notional ×
// 0.1% == the previous `feeAbsolute × inputPrice`.

export interface SwapNotionalArgs {
  /** Input token amount (human units). */
  inputAmount: number
  /** Input token's OWN Chainlink USD price, or null if it has no feed. */
  inputPrice: number | null
  /** Output token amount (human units). */
  outputAmount: number
  /** Output token's OWN Chainlink USD price, or null if it has no feed. */
  outputPrice: number | null
}

/**
 * The swap's USD notional from the reliably-priced side. Prefers the INPUT side
 * (keeps oracle-input swaps byte-identical), then the OUTPUT side, and returns
 * null when neither token has its own oracle (so the UI shows no USD rather than
 * a fabricated one). Never substitutes the other leg's price for an unpriced token.
 */
export function swapNotionalUsd({
  inputAmount,
  inputPrice,
  outputAmount,
  outputPrice,
}: SwapNotionalArgs): number | null {
  if (inputPrice != null && inputPrice > 0 && inputAmount > 0) {
    return inputAmount * inputPrice
  }
  if (outputPrice != null && outputPrice > 0 && outputAmount > 0) {
    return outputAmount * outputPrice
  }
  return null
}

/**
 * Fee USD = feePercent % of the trusted notional. Returns null when there is no
 * reliable notional (caller then renders the fee amount with no USD figure).
 */
export function feeUsd(notionalUsd: number | null, feePercent: number): number | null {
  if (notionalUsd == null || !(notionalUsd > 0)) return null
  return notionalUsd * (feePercent / 100)
}

/**
 * Format a fee USD value. Cent-and-above uses 2 decimals ("$2.00"); sub-cent
 * uses 3 decimals so a tiny but real fee stays visible ("0.00187" → "0.002")
 * instead of collapsing to "0.00".
 */
export function formatFeeUsd(usd: number): string {
  if (usd >= 0.01) return usd.toFixed(2)
  if (usd > 0) return usd.toFixed(3)
  return '0.00'
}
