/**
 * [ADR-029] The database steps of the swap log, one function per step, so each rule sits in one place:
 *
 *   - a row is looked up, and updated, only together with ITS wallet (never a row of another wallet);
 *   - a pending row never carries a transaction hash: the hash is written by the verification UPDATE and by nothing
 *     else, so "pending with a hash" (which the public counters of main read as a swap) can not be made by a caller;
 *   - a (chain, transaction hash) pair verifies at most one row: checked here, and enforced by the partial unique
 *     index of the migration, whose violation (23505) is reported as `duplicate`;
 *   - before the migration is applied (columns missing) nothing is written.
 *
 * Every function takes the Supabase client it may use: reads and the UPDATE need the service role, the INSERT uses
 * the insert-only logger client (P114/M-03).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VerifiedKind } from '@/lib/swap-verify/verify-swap-on-chain'

/** At most this many pending rows per wallet created within PENDING_CAP_WINDOW_MS: the next POST gets 429. */
export const PENDING_CAP = 5
export const PENDING_CAP_WINDOW_MS = 60 * 60 * 1000
/** PATCH falls back to the wallet's latest pending row only when it was created within this window. */
export const PENDING_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000

const ROW_COLUMNS = 'id, wallet, chain_id, source, status, tx_hash, verified_at, created_at'

export interface SwapRowRef {
  id: string
  wallet: string
  chain_id: number
  source: string
  status: string
  tx_hash: string | null
  verified_at: string | null
  created_at: string
}

interface PgError {
  code?: string
  message?: string
}

/** Postgres "undefined column" (42703) or PostgREST "column not in the schema cache" (PGRST204), for one of the two columns. */
function isMissingVerifiedColumn(error: PgError | null | undefined): boolean {
  if (!error) return false
  if (error.code !== '42703' && error.code !== 'PGRST204') return false
  return /verified_(at|kind)/.test(String(error.message ?? ''))
}

/** How long a "the columns are there" answer is trusted before it is asked again. */
export const VERIFIED_COLUMNS_SEEN_TTL_MS = 5 * 60 * 1000

let columnsSeenAt: number | null = null

/** Test-only: forget that the columns were seen. */
export function _resetVerifiedColumnsCache(): void {
  columnsSeenAt = null
}

export type ColumnsState = 'present' | 'missing' | 'unknown'

/**
 * Are `verified_at` and `verified_kind` there? `present` is remembered for five minutes per process (one small read
 * saved per request); `missing` is asked again on every request, so the code starts writing as soon as the migration
 * is applied. `unknown`: the probe failed for another reason (an outage): the caller does not write.
 */
export async function verifiedColumnsState(db: SupabaseClient, now: number = Date.now()): Promise<ColumnsState> {
  if (columnsSeenAt !== null && now - columnsSeenAt < VERIFIED_COLUMNS_SEEN_TTL_MS) return 'present'
  const { error } = await db.from('swaps').select('verified_at, verified_kind').limit(1)
  if (!error) {
    columnsSeenAt = now
    return 'present'
  }
  columnsSeenAt = null
  return isMissingVerifiedColumn(error) ? 'missing' : 'unknown'
}

/** How many pending rows this wallet created since `sinceIso`. null: the count could not be read. */
export async function countRecentPending(db: SupabaseClient, wallet: string, sinceIso: string): Promise<number | null> {
  const { count, error } = await db
    .from('swaps')
    .select('id', { count: 'exact', head: true })
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .gte('created_at', sinceIso)
  if (error || typeof count !== 'number') return null
  return count
}

export interface PendingRow {
  id: string
  wallet: string
  chain_id: number
  source: string
  token_in: string
  token_in_symbol: string
  token_out: string
  token_out_symbol: string
  amount_in: string
  amount_out: string
  slippage: number
  mev_protected: boolean
  fee_collected: boolean
  expected_output: string | null
  is_gasless: boolean
  gas_savings_usd: number
}

/** Inserts the PRIVATE pending row. Status, hash, USD, fee and mev columns are fixed here, not taken from anyone. */
export async function insertPending(loggerDb: SupabaseClient, row: PendingRow): Promise<{ ok: true } | { ok: false; code: string }> {
  const { error } = await loggerDb.from('swaps').insert({
    ...row,
    tx_hash: null,
    status: 'pending',
    amount_in_usd: null,
    amount_out_usd: null,
    fee_amount: null,
    mev_savings_estimate: null,
    mev_savings_actual: null,
  })
  if (error) return { ok: false, code: String((error as PgError).code ?? 'unknown') }
  return { ok: true }
}

/** The row of THAT wallet that carries this transaction hash (either letter case), newest first. */
export async function findWalletRowByTx(db: SupabaseClient, wallet: string, txHash: string): Promise<SwapRowRef | null | 'error'> {
  const { data, error } = await db
    .from('swaps')
    .select(ROW_COLUMNS)
    .eq('wallet', wallet)
    .ilike('tx_hash', txHash)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) return isMissingVerifiedColumn(error) ? null : 'error'
  return ((data ?? [])[0] as SwapRowRef | undefined) ?? null
}

/** One row by its id, and only if it belongs to `wallet`. */
export async function findWalletRowById(db: SupabaseClient, wallet: string, id: string): Promise<SwapRowRef | null | 'error'> {
  const { data, error } = await db.from('swaps').select(ROW_COLUMNS).eq('wallet', wallet).eq('id', id).limit(1)
  if (error) return 'error'
  return ((data ?? [])[0] as SwapRowRef | undefined) ?? null
}

/** The latest pending row of THAT wallet with no hash, created since `sinceIso`. */
export async function findLatestPending(db: SupabaseClient, wallet: string, sinceIso: string): Promise<SwapRowRef | null | 'error'> {
  const { data, error } = await db
    .from('swaps')
    .select(ROW_COLUMNS)
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('tx_hash', null)
    .is('verified_at', null)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) return 'error'
  return ((data ?? [])[0] as SwapRowRef | undefined) ?? null
}

/**
 * The row, other than `exceptId`, that this (chain, hash) already verified: its wallet, or null when there is none.
 * `error`: it could not be read (the caller does not write).
 */
export async function findTxVerifiedElsewhere(
  db: SupabaseClient,
  chainId: number,
  txHash: string,
  exceptId: string,
): Promise<{ wallet: string } | null | 'error'> {
  const { data, error } = await db
    .from('swaps')
    .select('id, wallet')
    .eq('chain_id', chainId)
    .ilike('tx_hash', txHash)
    .not('verified_at', 'is', null)
    .neq('id', exceptId)
    .limit(1)
  if (error) return 'error'
  const found = (data ?? [])[0] as { wallet?: unknown } | undefined
  return found ? { wallet: String(found.wallet ?? '').toLowerCase() } : null
}

export interface VerifiedUpdate {
  status: 'confirmed' | 'failed'
  tx_hash: string
  verified_at: string
  verified_kind: VerifiedKind
  source: string
  token_in: string | null
  token_in_symbol: string | null
  token_out: string | null
  token_out_symbol: string | null
  amount_in: string | null
  amount_out: string | null
  amount_in_usd: number | null
  amount_out_usd: number | null
  gas_used: string | null
  gas_price: string | null
  fee_collected: boolean
  fee_amount: null
  is_gasless: boolean
  mev_protected: boolean
  gas_savings_usd: 0
  mev_savings_estimate: null
  mev_savings_actual: null
}

export type MarkResult = 'updated' | 'not_unverified' | 'duplicate' | 'columns_missing' | 'error'

/**
 * The one UPDATE of a verification. It names the row by id AND wallet and requires it to be still unverified, so two
 * requests for the same row write once, and no request can write a row of another wallet.
 */
export async function markVerified(db: SupabaseClient, rowId: string, wallet: string, update: VerifiedUpdate): Promise<MarkResult> {
  const { data, error } = await db.from('swaps').update(update).eq('id', rowId).eq('wallet', wallet).is('verified_at', null).select('id')
  if (error) {
    const pg = error as PgError
    if (pg.code === '23505') return 'duplicate'
    if (isMissingVerifiedColumn(pg)) return 'columns_missing'
    return 'error'
  }
  return (data ?? []).length === 1 ? 'updated' : 'not_unverified'
}
