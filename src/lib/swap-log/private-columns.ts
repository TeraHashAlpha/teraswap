/**
 * [ADR-029 section 7.3, details I.4 of goal 133b] The PRIVATE columns of `swaps`: a transaction hash a wallet's
 * confirmation named while the chain could not answer yet, the chain it named, and when. Only the swap log itself
 * (src/lib/swap-log/store.ts) and the stored-rows script read or write them. No reader of the app returns them, public
 * or private: a reader that selects `*` passes its rows through `withoutPrivateSwapColumns`, and
 * src/app/api/swaps-read-claim-columns.guard.test.ts holds every reader to that.
 */
export const SWAP_PRIVATE_COLUMNS = ['claimed_tx_hash', 'claimed_chain_id', 'claimed_at'] as const

/**
 * [ADR-029 8.3] A claim row: a row of its own that holds a claimed hash and nothing else (no tokens, no transaction).
 * A row without the column (before the migration, or a row main wrote) is never one.
 */
export function isSwapClaimRow(row: Record<string, unknown>): boolean {
  const claimed = row.claimed_tx_hash
  return claimed !== null && claimed !== undefined
}

/** A copy of `row` without the private columns. Every other key, and the key order, is kept. */
export function withoutPrivateSwapColumns<T extends Record<string, unknown>>(row: T): T {
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (!(SWAP_PRIVATE_COLUMNS as readonly string[]).includes(key)) copy[key] = value
  }
  return copy as T
}
