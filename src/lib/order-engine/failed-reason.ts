/**
 * [CHORE-DCA-UX-FIXES] Bug 3b — human reason for a failed order.
 *
 * The keeper marks an order 'failed' but historically did NOT persist an error message, so the UI's
 * `error` field was usually null. This supplies a clear default so a failed order is always shown as
 * "Failed" WITH context — never a bare "Failed" and never silently vanishing.
 *
 * [chore/dca-resilience] The keeper now ALSO persists a SPECIFIC terminal reason CODE in orders.error
 * (the shared contract with retry-policy.js FAILURE_REASON). failedOrderReason maps each code to a
 * clear, actionable message, replacing the generic "the swap route may have become unavailable" that
 * masked the real cause (e.g. an expiry). Resolution order: known code → its message; else a non-empty
 * legacy free-text error → verbatim; else the default.
 */

export const DEFAULT_FAILED_REASON =
  'This order could not be executed on-chain (the swap route may have become unavailable). No funds were moved — you can remove it and try again with a different token, amount, or network.'

// Keyed by the keeper's FAILURE_REASON codes
// (contracts/order-engine/executor/retry-policy.js). Keep the two in sync.
export const FAILURE_REASON_LABELS: Record<string, string> = {
  expired:
    'This order expired before all buys could complete. Any completed buys are kept and no further funds were moved — create a new order with a longer expiry to finish.',
  no_route_after_retries:
    'No swap route was available for this pair after several automatic retries. Any completed buys are kept and no further funds were moved — you can remove it and try again with a different token, amount, or network.',
  insufficient_balance:
    'Your wallet balance was too low to continue this order. Any completed buys are kept — top up and create a new order to continue.',
  insufficient_allowance:
    'The token approval for this order was revoked or used up. Any completed buys are kept — re-approve and create a new order to continue.',
  nonce_invalid:
    'This order is no longer valid (its nonce was replaced, or it was already executed). No further funds were moved.',
  cancelled: 'This order was cancelled. No further funds were moved.',
  // [FIX-RETRY-CAP-RESTART] Distinct from no_route_after_retries: routes existed, but none could meet the
  // minimum output this order requires (its signed floor). The fix is a different order, not a retry.
  min_output_unreachable:
    'The minimum output this order requires could not be met by any available route after several automatic attempts — the minimum is above what the market can deliver. Any completed buys are kept and no further funds were moved. Cancel this order and re-create it with a realistic minimum.',
}

export function failedOrderReason(error: string | null | undefined): string {
  if (!error || !error.trim()) return DEFAULT_FAILED_REASON
  const code = error.trim().toLowerCase()
  if (code in FAILURE_REASON_LABELS) return FAILURE_REASON_LABELS[code]
  // Legacy / free-text error message — show it verbatim.
  return error
}
