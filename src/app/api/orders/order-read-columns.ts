/**
 * [fix/order-signature-not-returned] S-13 of the PR #689 audit (owner decision 2026-11-17): the columns an `orders`
 * READ may return to a browser. Never `*`: a read used to return the whole row, including the order's EIP-712
 * `signature`, to anyone who knew the wallet address (terminal statuses need no read signature, read-auth.ts). An
 * order cancelled only in our database stays valid on-chain until it expires, and the browser never uses the stored
 * signature (useOrderEngine.ts rowToOrder copied it and nothing read the copy), so no read returns it, with or without
 * a read signature.
 *
 * The list is the browser's OrderRow contract (src/lib/order-engine/supabase.ts) minus `signature`: everything the
 * site reads, nothing else. Columns no page reads (updated_at, price_condition, current_price, dca_last_exec,
 * fee_amount, gas_used, executed_price, the keeper's retry and infra-miss trail) stay on the server too.
 *
 * floor_tier / floor_ack_at come from migration 20261011120000, which a database may not have yet (AUDIT-TOTAL.md:1595
 * recorded it NOT applied). `select('*')` worked either way; a named missing column fails the whole read (Postgres
 * 42703), so withOrderReadColumns retries ONCE without those two. Pinned by orders-read-no-signature.test.ts and
 * orders-read-select-guard.test.ts.
 */

export const ORDER_READ_COLUMNS = [
  'id', 'wallet', 'order_hash', 'order_type', 'status', 'chain_id',
  'token_in', 'token_out', 'token_in_symbol', 'token_out_symbol', 'token_in_decimals', 'token_out_decimals',
  'floor_tier', 'floor_ack_at',
  'amount_in', 'min_amount_out', 'target_price', 'price_feed', 'expiry', 'nonce', 'router',
  'dca_interval', 'dca_total', 'dca_executed', 'order_data',
  'tx_hash', 'amount_out', 'error', 'created_at', 'executed_at',
] as const

/** One row as an `orders` read returns it: the allow-listed columns only (a migration column may be absent). */
export type OrderReadRow = { [K in (typeof ORDER_READ_COLUMNS)[number]]?: unknown } & { id: string; status: string }

/** Added by migration 20261011120000; a database without it still serves every other column. */
export const ORDER_READ_MIGRATION_COLUMNS: readonly string[] = ['floor_tier', 'floor_ack_at']

export const ORDER_READ_SELECT = ORDER_READ_COLUMNS.join(',')
export const ORDER_READ_SELECT_WITHOUT_MIGRATION = ORDER_READ_COLUMNS.filter(
  (c) => !ORDER_READ_MIGRATION_COLUMNS.includes(c),
).join(',')

/** Postgres 42703 (undefined_column) as PostgREST passes it on; PGRST204 is PostgREST's own "column not found". */
export function isMissingColumnError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === '42703' || error.code === 'PGRST204' || /column .* does not exist/i.test(error.message ?? '')
}

/**
 * Run an `orders` read with the allow-list; if the database lacks a migration column, run it once more without the
 * migration columns. `read` must pass its argument to `.select()` unchanged.
 */
export async function withOrderReadColumns<R extends { error: { code?: string; message?: string } | null }>(
  read: (columns: string) => PromiseLike<R>,
): Promise<R> {
  const first = await read(ORDER_READ_SELECT)
  return isMissingColumnError(first.error) ? read(ORDER_READ_SELECT_WITHOUT_MIGRATION) : first
}
