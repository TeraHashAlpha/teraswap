/**
 * [CHORE-DCA-UX-FIXES] Bug 3b — human reason for a failed order.
 *
 * The keeper marks an order 'failed' (e.g. after executeOrder reverts for an unroutable pair) but
 * does NOT persist an error message, so the UI's `error` field is usually null. This supplies a clear
 * default so a failed order is always shown as "Failed" WITH context — never a bare "Failed" and never
 * silently vanishing.
 */

export const DEFAULT_FAILED_REASON =
  'This order could not be executed on-chain (the swap route may have become unavailable). No funds were moved — you can remove it and try again with a different token, amount, or network.'

export function failedOrderReason(error: string | null | undefined): string {
  return error && error.trim() ? error : DEFAULT_FAILED_REASON
}
