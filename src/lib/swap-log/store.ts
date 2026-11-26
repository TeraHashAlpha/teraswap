/**
 * [ADR-029] The database steps of the swap log, one function per step, so each rule sits in one place:
 *
 *   - a row is looked up, written and deleted only together with ITS wallet (never a row of another wallet);
 *   - a pending row never carries a transaction hash: the hash is written by a verification and by nothing else, so
 *     "pending with a hash" (which the public counters of main read as a swap) can not be made by a caller. A hash the
 *     chain could not answer yet is kept in the PRIVATE claim columns (ADR-029 7.3), which no reader returns;
 *   - one transaction counts once per wallet (ADR-029 7.4): checked here, and enforced by the partial unique index
 *     (chain_id, lower(tx_hash), lower(wallet)) of the migration, whose violation (23505) is reported as `duplicate`;
 *   - before the migration is applied (columns missing) nothing is written.
 *
 * Every function takes the Supabase client it may use: reads, updates, deletes and the route's own inserts of a
 * verified or claim row need the service role; a POST's pending row uses the insert-only logger client (P114/M-03).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VerifiedKind } from '@/lib/swap-verify/verify-swap-on-chain'

/** At most this many pending rows per wallet created within PENDING_CAP_WINDOW_MS: the next POST gets 429. */
export const PENDING_CAP = 5
export const PENDING_CAP_WINDOW_MS = 60 * 60 * 1000
/** A confirmation attaches to a pending row of the wallet created within this window (or one holding its claim). */
export const PENDING_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000

/** The five columns of the ADR-029 migration: the two verification columns and the three private claim columns. */
export const MIGRATION_COLUMNS = 'verified_at, verified_kind, claimed_tx_hash, claimed_chain_id, claimed_at'

/** What a confirmation needs to know of a pending row, the claim columns included (server-side only). */
const CANDIDATE_COLUMNS =
  'id, wallet, chain_id, source, status, tx_hash, token_in, token_out, verified_at, created_at, claimed_tx_hash, claimed_chain_id, claimed_at'

/** A pending row of a wallet as a confirmation sees it. */
export interface PendingCandidate {
  id: string
  wallet: string
  chain_id: number
  source: string
  status: string
  tx_hash: string | null
  /** null only on a claim row (written by a confirmation that found no pending row): a POST row always has both tokens. */
  token_in: string | null
  token_out: string | null
  verified_at: string | null
  created_at: string
  claimed_tx_hash: string | null
  claimed_chain_id: number | null
  claimed_at: string | null
}

interface PgError {
  code?: string
  message?: string
}

/** Postgres "undefined column" (42703) or PostgREST "column not in the schema cache" (PGRST204), for one of the five. */
function isMissingVerifiedColumn(error: PgError | null | undefined): boolean {
  if (!error) return false
  if (error.code !== '42703' && error.code !== 'PGRST204') return false
  return /verified_(at|kind)|claimed_(tx_hash|chain_id|at)/.test(String(error.message ?? ''))
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
 * Are the five columns of the migration there? `present` is remembered for five minutes per process (one small read
 * saved per request); `missing` is asked again on every request, so the code starts writing as soon as the migration
 * is applied. `unknown`: the probe failed for another reason (an outage): the caller does not write.
 */
export async function verifiedColumnsState(db: SupabaseClient, now: number = Date.now()): Promise<ColumnsState> {
  if (columnsSeenAt !== null && now - columnsSeenAt < VERIFIED_COLUMNS_SEEN_TTL_MS) return 'present'
  const { error } = await db.from('swaps').select(MIGRATION_COLUMNS).limit(1)
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

/** Does THAT wallet already have a verified row for this hash (either letter case)? `error`: it could not be read. */
export async function findWalletVerifiedByTx(db: SupabaseClient, wallet: string, txHash: string): Promise<boolean | 'error'> {
  const { data, error } = await db
    .from('swaps')
    .select('id')
    .eq('wallet', wallet)
    .ilike('tx_hash', txHash)
    .not('verified_at', 'is', null)
    .limit(1)
  if (error) return isMissingVerifiedColumn(error) ? false : 'error'
  return (data ?? []).length > 0
}

/**
 * The pending rows of THAT wallet a confirmation may attach to: no hash, unverified, created since `sinceIso`, newest
 * first; plus the rows that hold a claim of `txHash`, whatever their age. Two plain reads, merged by id.
 */
export async function findCandidateRows(db: SupabaseClient, wallet: string, txHash: string, sinceIso: string): Promise<PendingCandidate[] | 'error'> {
  const recent = await db
    .from('swaps')
    .select(CANDIDATE_COLUMNS)
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('tx_hash', null)
    .is('verified_at', null)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(50)
  if (recent.error) return 'error'
  const claimed = await db
    .from('swaps')
    .select(CANDIDATE_COLUMNS)
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('verified_at', null)
    .ilike('claimed_tx_hash', txHash)
    .order('created_at', { ascending: false })
    .limit(5)
  if (claimed.error) return 'error'
  const byId = new Map<string, PendingCandidate>()
  for (const row of [...(recent.data ?? []), ...(claimed.data ?? [])] as PendingCandidate[]) byId.set(String(row.id), row)
  return [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
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
  /** A decided claim is cleared with the verification. */
  claimed_tx_hash: null
  claimed_chain_id: null
  claimed_at: null
}

export type MarkResult = 'updated' | 'not_unverified' | 'duplicate' | 'columns_missing' | 'error'

function writeError(error: PgError): 'duplicate' | 'columns_missing' | 'error' {
  if (error.code === '23505') return 'duplicate'
  if (isMissingVerifiedColumn(error)) return 'columns_missing'
  return 'error'
}

/**
 * The verification of a pending row: one UPDATE naming the row by id AND wallet and requiring it to be still
 * unverified, so two requests for the same row write once, and no request can write a row of another wallet.
 * `chainId` is set only on a claim row (it was written before the chain was known).
 */
export async function markVerified(db: SupabaseClient, rowId: string, wallet: string, update: VerifiedUpdate, chainId?: number): Promise<MarkResult> {
  const values = chainId === undefined ? update : { ...update, chain_id: chainId }
  const { data, error } = await db.from('swaps').update(values).eq('id', rowId).eq('wallet', wallet).is('verified_at', null).select('id')
  if (error) return writeError(error as PgError)
  return (data ?? []).length === 1 ? 'updated' : 'not_unverified'
}

/** The verified row a transaction makes when the wallet has no pending row that agrees with it (details I.2). */
export async function insertVerified(
  db: SupabaseClient,
  row: { id: string; wallet: string; chain_id: number } & VerifiedUpdate,
): Promise<'inserted' | 'duplicate' | 'columns_missing' | 'error'> {
  const { error } = await db.from('swaps').insert(row)
  if (error) return writeError(error as PgError)
  return 'inserted'
}

export interface Claim {
  claimed_tx_hash: string
  claimed_chain_id: number | null
  claimed_at: string
}

/** Puts a claim on one pending row of THAT wallet that holds none yet. `taken`: it holds one now (or is verified). */
export async function storeClaimOn(db: SupabaseClient, rowId: string, wallet: string, claim: Claim): Promise<'stored' | 'taken' | 'columns_missing' | 'error'> {
  const { data, error } = await db
    .from('swaps')
    .update(claim)
    .eq('id', rowId)
    .eq('wallet', wallet)
    .is('claimed_tx_hash', null)
    .is('verified_at', null)
    .select('id')
  if (error) {
    const kind = writeError(error as PgError)
    return kind === 'duplicate' ? 'error' : kind
  }
  return (data ?? []).length === 1 ? 'stored' : 'taken'
}

/** A claim stored without a chain learns it from a later confirmation that named one. */
export async function setClaimChain(db: SupabaseClient, rowId: string, wallet: string, chainId: number): Promise<void> {
  await db.from('swaps').update({ claimed_chain_id: chainId }).eq('id', rowId).eq('wallet', wallet).is('claimed_chain_id', null).is('verified_at', null)
}

/** A claim row: a pending row of THAT wallet with no tokens, written when the wallet has no pending row to hold the claim. */
export async function insertClaimRow(db: SupabaseClient, row: { id: string; wallet: string; chain_id: number; source: string } & Claim): Promise<'inserted' | 'columns_missing' | 'error'> {
  const { error } = await db.from('swaps').insert({
    ...row,
    status: 'pending',
    tx_hash: null,
    token_in: null,
    token_in_symbol: null,
    token_out: null,
    token_out_symbol: null,
    amount_in: null,
    amount_out: null,
    amount_in_usd: null,
    amount_out_usd: null,
    fee_amount: null,
    mev_savings_estimate: null,
    mev_savings_actual: null,
  })
  if (error) {
    const kind = writeError(error as PgError)
    return kind === 'duplicate' ? 'error' : kind
  }
  return 'inserted'
}

/** A decided claim (verified, or rejected by the chain) is cleared from THAT wallet's unverified rows. */
export async function clearClaim(db: SupabaseClient, wallet: string, txHash: string): Promise<void> {
  await db
    .from('swaps')
    .update({ claimed_tx_hash: null, claimed_chain_id: null, claimed_at: null })
    .eq('wallet', wallet)
    .ilike('claimed_tx_hash', txHash)
    .is('verified_at', null)
}
