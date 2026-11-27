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

/** [ADR-029 9.3, A106 R3-3] A query of `swaps` narrowed to the rows that are not claim rows (`claimed_tx_hash is null`). */
export function withoutClaimRows<Q extends { is(column: string, value: null): Q }>(query: Q): Q {
  return query.is('claimed_tx_hash', null)
}

/**
 * [ADR-029 9.3] The database refused a filter on the claim column because it does not exist yet (the migration is not
 * applied, so no claim row can exist either): Postgres 42703 or PostgREST's PGRST204, naming that column.
 */
export function isMissingClaimColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  if (error.code !== '42703' && error.code !== 'PGRST204') return false
  return /claimed_tx_hash/.test(String(error.message ?? ''))
}

/** A copy of `row` without the private columns. Every other key, and the key order, is kept. */
export function withoutPrivateSwapColumns<T extends Record<string, unknown>>(row: T): T {
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (!(SWAP_PRIVATE_COLUMNS as readonly string[]).includes(key)) copy[key] = value
  }
  return copy as T
}
