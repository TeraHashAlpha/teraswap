/**
 * [ADR-029] The database steps of the swap log, one function per step, so each rule sits in one place:
 *
 *   - a row is looked up, written and deleted only together with ITS wallet (never a row of another wallet);
 *   - a pending row never carries a transaction hash: the hash is written by a verification and by nothing else, so
 *     "pending with a hash" (which the public counters of main read as a swap) can not be made by a caller. A hash the
 *     chain could not answer yet is kept in the PRIVATE claim columns (ADR-029 7.3), which no reader returns, on a CLAIM
 *     ROW of its own (ADR-029 8.3): a POST row never holds a claim, and /api/history leaves claim rows out;
 *   - one transaction counts once per wallet (ADR-029 7.4): checked here, and enforced by the partial unique index
 *     (chain_id, lower(tx_hash), lower(wallet)) of the migration, whose violation (23505) is reported as `duplicate`;
 *   - before the migration is applied (columns missing) nothing is written.
 *
 * Every function takes the Supabase client it may use: reads, updates, deletes and the route's own inserts of a
 * verified or claim row need the service role; a POST's pending row uses the insert-only logger client (P114/M-03).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VerifiedKind } from '@/lib/swap-verify/verify-swap-on-chain'

/**
 * [details J of goal 133b, P.4 of goal 133c] A POST row is private SCRATCH, never a reason to refuse: at PENDING_CAP POST
 * rows of a wallet created within PENDING_CAP_WINDOW_MS, a new POST row first retires (deletes) that wallet's oldest one.
 * A scratch POST row is pending, hash-less, unverified, holds no claim, and was created within PENDING_CAP_WINDOW_MS. A
 * claim row is never touched by this rule, and a row older than that window is never deleted by it.
 */
export const PENDING_CAP = 5
export const PENDING_CAP_WINDOW_MS = 60 * 60 * 1000
/** A confirmation attaches to a POST row of the wallet created within this window. */
export const PENDING_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000

/**
 * [ADR-029 8.3, details P of goal 133c] A CLAIM is a row of its own: pending, no tokens, `claimed_tx_hash` set; one per
 * (wallet, claimed chain or none, hash). It is removed only by the chain's answer (the transaction verified and recorded,
 * or rejected, or found on no chain) or by age (CLAIM_EXPIRES_AFTER_MS), never by anyone's requests:
 *   - at most CLAIM_CAP live claims per wallet; at the cap, a new claim first asks the chain about at most
 *     CLAIM_CHECKS_PER_REQUEST of that wallet's claims older than CLAIM_CHECK_AFTER_MS, oldest first (confirm.ts);
 *   - a claim older than CLAIM_EXPIRES_AFTER_MS may be deleted by any later request of that wallet.
 */
export const CLAIM_CAP = 20
export const CLAIM_CHECK_AFTER_MS = 10 * 60 * 1000
export const CLAIM_CHECKS_PER_REQUEST = 3
export const CLAIM_EXPIRES_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** The five columns of the ADR-029 migration: the two verification columns and the three private claim columns. */
export const MIGRATION_COLUMNS = 'verified_at, verified_kind, claimed_tx_hash, claimed_chain_id, claimed_at'

/** What a confirmation needs to know of a pending row, the claim columns included (server-side only). */
const CANDIDATE_COLUMNS =
  'id, wallet, chain_id, source, status, tx_hash, token_in, token_out, verified_at, created_at, claimed_tx_hash, claimed_chain_id, claimed_at'

/** A pending row of a wallet as a confirmation sees it: a POST row, or a claim row (`claimed_tx_hash` set). */
export interface PendingCandidate {
  id: string
  wallet: string
  chain_id: number
  source: string
  status: string
  tx_hash: string | null
  /** null only on a claim row: a POST row always has both tokens. */
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
 * The rows of THAT wallet a confirmation of `txHash` may attach to: its POST rows (no hash, unverified, no claim) created
 * since `sinceIso`, newest first; plus the claim rows of `txHash` (any chain), whatever their age. A claim row of ANOTHER
 * hash is never a candidate (P.2). Two plain reads, merged by id.
 */
export async function findCandidateRows(db: SupabaseClient, wallet: string, txHash: string, sinceIso: string): Promise<PendingCandidate[] | 'error'> {
  const recent = await db
    .from('swaps')
    .select(CANDIDATE_COLUMNS)
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('tx_hash', null)
    .is('verified_at', null)
    .is('claimed_tx_hash', null)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(50)
  if (recent.error) return 'error'
  const claimed = await db
    .from('swaps')
    .select(CANDIDATE_COLUMNS)
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('tx_hash', null)
    .is('verified_at', null)
    .ilike('claimed_tx_hash', txHash)
    .order('created_at', { ascending: false })
    .limit(10)
  if (claimed.error) return 'error'
  const byId = new Map<string, PendingCandidate>()
  for (const row of [...(recent.data ?? []), ...(claimed.data ?? [])] as PendingCandidate[]) byId.set(String(row.id), row)
  return [...byId.values()].sort((a, b) => time(b.created_at) - time(a.created_at))
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

/**
 * A claim row (P.1): a pending row of THAT wallet with no tokens, holding one claim and nothing else. A POST row never
 * receives a claim.
 */
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

/** A timestamp as Postgres (`…+00:00`, microseconds) or JavaScript (`…Z`) writes it, in milliseconds; NaN sorts first. */
function time(value: string | null): number {
  const ms = value === null ? Number.NaN : Date.parse(value)
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

/**
 * Details J / P.4: makes room for one more POST row of THAT wallet. Never refuses. At PENDING_CAP POST rows created
 * within PENDING_CAP_WINDOW_MS, the oldest of them is retired (deleted: private scratch written by this code). A claim
 * row is never looked at. Returns the ids it retired; `error` when the rows could not be read (the caller inserts anyway).
 */
export async function makeRoomForPending(db: SupabaseClient, wallet: string, now: Date): Promise<string[] | 'error'> {
  const since = new Date(now.getTime() - PENDING_CAP_WINDOW_MS).toISOString()
  // The filters say what a scratch POST row is; the delete below repeats them, so nothing else can go.
  const { data, error } = await db
    .from('swaps')
    .select('id, created_at')
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('tx_hash', null)
    .is('verified_at', null)
    .is('claimed_tx_hash', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) return 'error'
  const rows = ((data ?? []) as Array<{ id: string; created_at: string }>).sort((a, b) => time(a.created_at) - time(b.created_at))
  if (rows.length < PENDING_CAP) return []
  const { data: gone, error: deleteError } = await db
    .from('swaps')
    .delete()
    .eq('id', rows[0].id)
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('tx_hash', null)
    .is('verified_at', null)
    .is('claimed_tx_hash', null)
    .gte('created_at', since)
    .select('id')
  return !deleteError && (gone ?? []).length === 1 ? [rows[0].id] : []
}

/** A live claim row of a wallet, as the claim rules see it. */
export interface ClaimRow {
  id: string
  chain_id: number
  claimed_tx_hash: string
  claimed_chain_id: number | null
  claimed_at: string | null
  created_at: string
}

const CLAIM_COLUMNS = 'id, chain_id, claimed_tx_hash, claimed_chain_id, claimed_at, created_at'

/** THAT wallet's live claim rows, the oldest claim first. */
export async function findClaimRows(db: SupabaseClient, wallet: string): Promise<ClaimRow[] | 'error'> {
  const { data, error } = await db
    .from('swaps')
    .select(CLAIM_COLUMNS)
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('tx_hash', null)
    .is('verified_at', null)
    .not('claimed_tx_hash', 'is', null)
    .order('claimed_at', { ascending: true })
    .limit(200)
  if (error) return 'error'
  return ((data ?? []) as ClaimRow[]).sort((a, b) => time(a.claimed_at) - time(b.claimed_at))
}

/**
 * The claim rows of `txHash` of THAT wallet (every chain) are deleted: the chain answered for that hash (it is recorded,
 * or it is not this wallet's swap). The filters repeat what makes a row a claim row, so no other row can go; a claim
 * row a verification just reused no longer holds its claim.
 */
export async function deleteClaimsOf(db: SupabaseClient, wallet: string, txHash: string): Promise<void> {
  await db
    .from('swaps')
    .delete()
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('tx_hash', null)
    .is('verified_at', null)
    .ilike('claimed_tx_hash', txHash)
}

/** P.3: one claim row of THAT wallet, whose transaction no chain has. The filters repeat what makes it a claim row. */
export async function deleteClaimRow(db: SupabaseClient, wallet: string, id: string): Promise<boolean> {
  const { data, error } = await db
    .from('swaps')
    .delete()
    .eq('id', id)
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('tx_hash', null)
    .is('verified_at', null)
    .not('claimed_tx_hash', 'is', null)
    .select('id')
  return !error && (data ?? []).length === 1
}

/** P.3: THAT wallet's claims older than CLAIM_EXPIRES_AFTER_MS, which any later request may delete. */
export async function deleteExpiredClaims(db: SupabaseClient, wallet: string, now: Date): Promise<void> {
  await db
    .from('swaps')
    .delete()
    .eq('wallet', wallet)
    .eq('status', 'pending')
    .is('tx_hash', null)
    .is('verified_at', null)
    .not('claimed_tx_hash', 'is', null)
    .lt('claimed_at', new Date(now.getTime() - CLAIM_EXPIRES_AFTER_MS).toISOString())
}
