/**
 * [ADR-029 section 4, details F] The logic of scripts/swaps/verify-stored-swaps.ts, apart from the process (argv,
 * stdin, stdout, exit code) so tests can drive every line of it.
 *
 * Every stored row is checked with the SAME function the route uses (verifySwapOnChain). Report mode writes nothing.
 * Apply mode sets `verified_at` and `verified_kind`, and nothing else, on the rows that pass.
 *
 * Which rows pass (owner's answer of 2026-11-25). A row written before ADR-029 holds what its caller DECLARED, and
 * apply mode may not rewrite it; marking it verified makes those stored values public once the flag is on. So a row is
 * marked only when the chain confirms the transaction AND what the row stores agrees with the receipt:
 *   - the stored status agrees: `confirmed` or `pending` with a confirmed transaction, `failed` with a reverted one;
 *   - both stored token addresses equal the receipt's;
 *   - the stored amount-in equals the receipt's;
 *   - the receipt's amount-out is between 50% and 200% of the stored one (old rows stored the QUOTE, so it is never equal).
 * A side the receipt cannot give counts as differing. Rows that verify but differ are reported with both values and left
 * for the owner to decide (`stored_differs`, `status_differs`).
 * A row it would mark is printed with `callerColumns`: the stored columns that came from the caller and become public
 * with the flag on (goal 133b details L), so the owner decides before the flag goes on (S-7 of A103 stays open).
 *
 * Claims (ADR-029 7.3, details L). A pending row with a `claimed_tx_hash` holds a hash a confirmation named while the
 * chain could not answer yet. Report mode asks the chain (the claimed chain, else every chain of the app) and prints
 * what a confirmation would do: `claim_verifiable`, `claim_not_found` or `claim_rejected`. Apply mode runs THE SAME
 * confirmation the route runs (src/lib/swap-log/confirm.ts, without the alert trackers): the transaction makes its row
 * and the claim is cleared, or the claim stays (`claim_kept`), or a rejected one is cleared (`claim_cleared`).
 */
import { getSupportedChainIds } from '@/lib/chains/registry'
import { compareStored } from '@/lib/swap-log/stored-agreement'
import type { DerivedSwap, VerifiedKind, VerifySwapInput, VerifySwapResult } from '@/lib/swap-verify/verify-swap-on-chain'

// The agreement rule lives in its own module; this script is its one caller (a request never marks a row main stored).
export { compareStored, OUT_RATIO_MAX_DEN, OUT_RATIO_MAX_NUM, OUT_RATIO_MIN_DEN, OUT_RATIO_MIN_NUM } from '@/lib/swap-log/stored-agreement'

/**
 * The stored columns that came from the caller (on main) and that a public reader returns once the row is verified and
 * the flag is on: listed per row the script would mark. Details L names symbols, source, fee and gasless flags and
 * gas_savings_usd; the others are the remaining caller-supplied columns the public readers select (monitor, health,
 * export, analytics, stats, surplus report).
 */
export const CALLER_COLUMNS = [
  'token_in_symbol', 'token_out_symbol', 'source', 'fee_collected', 'is_gasless', 'gas_savings_usd',
  'mev_protected', 'fee_amount', 'amount_out', 'amount_in_usd', 'amount_out_usd', 'gas_used', 'gas_price', 'mev_savings_estimate', 'mev_savings_actual',
] as const

const BASE_COLUMNS = 'id, wallet, chain_id, source, tx_hash, status, token_in, token_out, amount_in, amount_out, created_at'
const CALLER_EXTRA = CALLER_COLUMNS.filter((c) => !BASE_COLUMNS.split(', ').includes(c)).join(', ')

/** The columns the script reads. */
export const STORED_COLUMNS = `${BASE_COLUMNS}, ${CALLER_EXTRA}, verified_at, claimed_tx_hash, claimed_chain_id, claimed_at`
export const STORED_COLUMNS_BEFORE_MIGRATION = `${BASE_COLUMNS}, ${CALLER_EXTRA}`

export type Decision =
  /** Verified and consistent with what the row stores: apply mode marks it. */
  | 'mark'
  | 'already_verified'
  /** The row has no transaction hash: there is nothing to look up. */
  | 'no_tx_hash'
  /** The row lacks a field the check needs. */
  | 'bad_row'
  /** The chain has no such transaction, or could not be read. */
  | 'not_found'
  /** The transaction is not this wallet's swap. */
  | 'rejected'
  /** The transaction is this wallet's swap, but the stored status says otherwise. */
  | 'status_differs'
  /** The transaction is this wallet's swap, but the stored tokens or amounts are not the receipt's. */
  | 'stored_differs'
  /** A claim the chain confirms (or reports reverted): a confirmation would make its row and clear the claim. */
  | 'claim_verifiable'
  /** A claim the chain still has no answer for: it stays. */
  | 'claim_not_found'
  /** A claim of a transaction that is not this wallet's swap: a confirmation would clear it. */
  | 'claim_rejected'

export type Applied =
  | 'marked'
  | 'already_verified'
  | 'duplicate_tx'
  | 'error'
  /** Apply mode, a claim: its row made (or updated) and the claim cleared. */
  | 'claim_verified'
  /** Apply mode, a claim: the chain had no answer; it stays. */
  | 'claim_kept'
  /** Apply mode, a claim: rejected by the chain and cleared. */
  | 'claim_cleared'

export interface RowReport {
  id: string | null
  chain: number | null
  decision: Decision
  outcome?: VerifySwapResult['outcome']
  kind?: VerifiedKind
  reason?: string
  derived?: Pick<DerivedSwap, 'tokenIn' | 'amountIn' | 'tokenOut' | 'amountOut' | 'source'>
  /** What the row stores, printed only when it differs from the receipt. */
  stored?: { status: string | null; tokenIn: string | null; amountIn: string | null; tokenOut: string | null; amountOut: string | null }
  /** Which comparisons failed. */
  differs?: string[]
  /** Receipt amount-out divided by stored amount-out, four decimals; absent when either is unknown. */
  outRatio?: string
  /** A row it would mark: the stored caller-supplied columns that become public (CALLER_COLUMNS), as stored. */
  callerColumns?: Record<string, unknown>
  /** A claim row: the claimed chain (null: none named) and the chain the claim was found on. */
  claim?: { claimedChain: number | null; foundOn: number | null }
  /** Apply mode only: what the write did. */
  applied?: Applied
}

export interface Summary {
  summary: true
  mode: 'report' | 'apply'
  rows: number
  byDecision: Record<string, number>
  byKind: Record<string, number>
  byReason: Record<string, number>
  byChain: Record<string, Record<string, number>>
  applied: Record<string, number>
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

function text(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

// compareStored (and its 50% to 200% band) lives in src/lib/swap-log/stored-agreement.ts, re-exported above.

export type Verify = (input: VerifySwapInput) => Promise<VerifySwapResult>

function chainOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null
}

/** A row that holds a claim (a pending row of this code, written while the chain could not answer yet). */
export function claimOf(raw: unknown): { txHash: string; chainId: number | null; wallet: string } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (row.verified_at !== null && row.verified_at !== undefined) return null
  const txHash = text(row.claimed_tx_hash)
  const wallet = text(row.wallet)
  if (txHash === null || wallet === null) return null
  return { txHash, chainId: chainOf(row.claimed_chain_id), wallet }
}

/** A claim, checked as the route would: the claimed chain, else every chain of the app until one has the transaction. */
async function checkClaim(row: Record<string, unknown>, base: { id: string | null; chain: number | null }, verify: Verify): Promise<RowReport> {
  const claim = claimOf(row)
  if (claim === null) return { ...base, decision: 'bad_row', reason: 'no_wallet' }
  if (!TX_HASH_RE.test(claim.txHash)) return { ...base, decision: 'claim_rejected', outcome: 'rejected', reason: 'bad_tx_hash', claim: { claimedChain: claim.chainId, foundOn: null } }
  const pending = text(row.token_in) === null ? [] : [{ source: text(row.source), tokenIn: text(row.token_in), tokenOut: text(row.token_out) }]
  const chains = claim.chainId !== null ? [claim.chainId] : getSupportedChainIds()
  let last: VerifySwapResult = { outcome: 'not_found', reason: 'tx_missing' }
  let foundOn: number | null = null
  for (const chainId of chains) {
    last = await verify({ chainId, txHash: claim.txHash, wallet: claim.wallet, pending })
    if (last.outcome !== 'not_found' || last.reason === 'receipt_missing') {
      foundOn = chainId
      break
    }
  }
  const report: RowReport = { ...base, decision: 'claim_not_found', outcome: last.outcome, claim: { claimedChain: claim.chainId, foundOn } }
  if (last.reason) report.reason = last.reason
  if (last.outcome === 'rejected') report.decision = 'claim_rejected'
  if ((last.outcome === 'confirmed' || last.outcome === 'failed') && last.kind && last.derived) {
    report.decision = 'claim_verifiable'
    report.kind = last.kind
    report.derived = { tokenIn: last.derived.tokenIn, amountIn: last.derived.amountIn, tokenOut: last.derived.tokenOut, amountOut: last.derived.amountOut, source: last.derived.source }
  }
  return report
}

/** Checks ONE stored row. Never writes. */
export async function checkRow(raw: unknown, verify: Verify): Promise<RowReport> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { id: null, chain: null, decision: 'bad_row', reason: 'not_an_object' }
  const row = raw as Record<string, unknown>
  const id = text(row.id)
  const chain = chainOf(row.chain_id)
  const base = { id, chain }

  if (row.verified_at !== null && row.verified_at !== undefined) return { ...base, decision: 'already_verified' }
  if (id === null) return { ...base, decision: 'bad_row', reason: 'no_id' }
  if (row.claimed_tx_hash !== null && row.claimed_tx_hash !== undefined) return checkClaim(row, base, verify)
  if (row.tx_hash === null || row.tx_hash === undefined || row.tx_hash === '') return { ...base, decision: 'no_tx_hash' }
  const txHash = text(row.tx_hash)
  const wallet = text(row.wallet)
  const source = text(row.source)
  if (chain === null) return { ...base, decision: 'bad_row', reason: 'no_chain_id' }
  if (txHash === null || !TX_HASH_RE.test(txHash)) return { ...base, decision: 'rejected', outcome: 'rejected', reason: 'bad_tx_hash' }
  if (wallet === null || source === null) return { ...base, decision: 'bad_row', reason: 'no_wallet_or_source' }

  // The row's own source and tokens are hints only (a router two sources list; two CoW trades of one wallet).
  const result = await verify({ chainId: chain, txHash, wallet, pending: [{ source, tokenIn: text(row.token_in), tokenOut: text(row.token_out) }] })
  if (result.outcome === 'not_found') return { ...base, decision: 'not_found', outcome: 'not_found', reason: result.reason }
  if (result.outcome === 'rejected' || !result.kind || !result.derived) return { ...base, decision: 'rejected', outcome: 'rejected', reason: result.reason }

  const derived = {
    tokenIn: result.derived.tokenIn,
    amountIn: result.derived.amountIn,
    tokenOut: result.derived.tokenOut,
    amountOut: result.derived.amountOut,
    source: result.derived.source,
  }
  const compared = compareStored(row, result.outcome, result.derived)
  const report: RowReport = { ...base, decision: 'mark', outcome: result.outcome, kind: result.kind, derived }
  if (compared.outRatio !== null) report.outRatio = compared.outRatio
  if (compared.statusAgrees && compared.differs.length === 0) {
    // What --apply would make public as it is stored (details L): the owner decides before the flag goes on.
    report.callerColumns = Object.fromEntries(CALLER_COLUMNS.map((c) => [c, Object.prototype.hasOwnProperty.call(row, c) ? row[c] : null]))
  } else {
    report.decision = compared.statusAgrees ? 'stored_differs' : 'status_differs'
    report.differs = [...(compared.statusAgrees ? [] : ['status']), ...compared.differs]
    report.stored = {
      status: text(row.status),
      tokenIn: text(row.token_in),
      amountIn: text(row.amount_in),
      tokenOut: text(row.token_out),
      amountOut: text(row.amount_out),
    }
  }
  return report
}

/** Apply mode's one write per passing row: the two columns, on that row, only while it is unverified. */
export type Mark = (id: string, kind: VerifiedKind, verifiedAt: string) => Promise<Applied>

/** Apply mode, a claim: the route's own confirmation (src/lib/swap-log/confirm.ts), without the alert trackers. */
export type ConfirmClaim = (claim: { wallet: string; txHash: string; chainId: number | null }) => Promise<
  'verified' | 'not_found' | 'rejected' | 'duplicate' | 'columns_missing' | 'storage_error'
>

/** Apply mode, a claim row: one confirmation, and what it did. */
async function applyClaim(raw: Record<string, unknown>, claim: NonNullable<ReturnType<typeof claimOf>>, confirm: ConfirmClaim): Promise<RowReport> {
  const base = { id: text(raw.id), chain: chainOf(raw.chain_id), claim: { claimedChain: claim.chainId, foundOn: null } }
  if (!TX_HASH_RE.test(claim.txHash)) return { ...base, decision: 'claim_rejected', outcome: 'rejected', reason: 'bad_tx_hash' }
  const result = await confirm(claim)
  if (result === 'columns_missing') throw new ScriptError('migration_not_applied')
  if (result === 'verified') return { ...base, decision: 'claim_verifiable', applied: 'claim_verified' }
  if (result === 'duplicate') return { ...base, decision: 'claim_verifiable', applied: 'duplicate_tx' }
  if (result === 'not_found') return { ...base, decision: 'claim_not_found', outcome: 'not_found', applied: 'claim_kept' }
  if (result === 'rejected') return { ...base, decision: 'claim_rejected', outcome: 'rejected', applied: 'claim_cleared' }
  return { ...base, decision: 'claim_not_found', applied: 'error' }
}

export interface RunOptions {
  rows: readonly unknown[]
  verify: Verify
  emit: (line: RowReport | Summary) => Promise<void> | void
  /** Present only in apply mode. */
  mark?: Mark
  /** Present only in apply mode: how a claim row is decided. */
  confirmClaim?: ConfirmClaim
  /** Pause between rows that read the chain, so a public endpoint is not flooded. */
  pause?: () => Promise<void>
  now?: () => Date
}

export async function run(options: RunOptions): Promise<Summary> {
  const summary: Summary = { summary: true, mode: options.mark ? 'apply' : 'report', rows: 0, byDecision: {}, byKind: {}, byReason: {}, byChain: {}, applied: {} }
  const bump = (bucket: Record<string, number>, key: string) => {
    bucket[key] = (bucket[key] ?? 0) + 1
  }

  for (const raw of options.rows) {
    const claim = options.confirmClaim ? claimOf(raw) : null
    const report = claim !== null && options.confirmClaim
      ? await applyClaim(raw as Record<string, unknown>, claim, options.confirmClaim)
      : await checkRow(raw, options.verify)
    if (report.applied !== undefined) bump(summary.applied, report.applied)
    if (report.decision === 'mark' && options.mark && report.id !== null && report.kind) {
      report.applied = await options.mark(report.id, report.kind, (options.now ?? (() => new Date()))().toISOString())
      bump(summary.applied, report.applied)
    }
    summary.rows += 1
    bump(summary.byDecision, report.decision)
    if (report.kind) bump(summary.byKind, report.kind)
    if (report.reason) bump(summary.byReason, report.reason)
    bump((summary.byChain[String(report.chain)] ??= {}), report.decision)
    await options.emit(report)
    // Only a row that was looked up on-chain costs a read (an applied claim always was).
    if ((report.outcome !== undefined || report.applied?.startsWith('claim_') || report.applied === 'duplicate_tx') && options.pause) await options.pause()
  }
  await options.emit(summary)
  return summary
}

/** stdin: a JSON array of rows, `{ "rows": [...] }`, or one JSON object per line. Throws on anything else. */
export function parseRows(input: string): unknown[] {
  const trimmed = input.trim()
  if (trimmed === '') throw new ScriptError('no input: pipe a JSON array of swaps rows, or use --from-db')
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { rows?: unknown }).rows)) return (parsed as { rows: unknown[] }).rows
    if (typeof parsed === 'object' && parsed !== null) return [parsed]
    throw new Error('not rows')
  } catch {
    // One JSON object per line.
    const lines = trimmed.split('\n').filter((l) => l.trim() !== '')
    try {
      return lines.map((l) => JSON.parse(l) as unknown)
    } catch {
      throw new ScriptError('input is not JSON: expected a JSON array of swaps rows, { "rows": [...] }, or one JSON object per line')
    }
  }
}

export interface Args {
  apply: boolean
  fromDb: boolean
  delayMs: number
  limit: number | null
  help: boolean
}

export const USAGE = [
  'verify-stored-swaps: check stored swaps rows against the chain (ADR-029 section 4).',
  '',
  '  npx --yes tsx --tsconfig tsconfig.json scripts/swaps/verify-stored-swaps.ts < rows.json',
  '  npx --yes tsx --tsconfig tsconfig.json scripts/swaps/verify-stored-swaps.ts --from-db',
  '  npx --yes tsx --tsconfig tsconfig.json scripts/swaps/verify-stored-swaps.ts --from-db --apply',
  '',
  'Report mode (default) writes nothing. stdin: a JSON array of swaps rows (id, wallet, chain_id, source, tx_hash,',
  'status, token_in, token_out, amount_in, amount_out, verified_at, claimed_tx_hash, claimed_chain_id, and the caller',
  'columns listed per "mark" row), { "rows": [...] }, or one object per line.',
  'A row it would mark lists `callerColumns`: what the caller stored that becomes public with the flag on.',
  'A row holding a claim (a hash the chain could not answer yet) is checked on the claimed chain, else every chain.',
  '',
  '  --from-db       read the rows from the database (env SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)',
  '  --apply         set verified_at and verified_kind on the rows whose decision is "mark" (needs the database), and',
  '                  decide each claim as the route does: its verified row is made and the claim cleared',
  '  --delay-ms <n>  pause between rows that read the chain (default 200)',
  '  --limit <n>     check at most n rows',
  '  --help',
  '',
  'Chain reads use RPC_URL_1, RPC_URL_8453, RPC_URL_42161 (else a public endpoint). The Base and Arbitrum FeeCollector',
  'addresses come from NEXT_PUBLIC_BASE_FEE_COLLECTOR and NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR, as in the app: without',
  'them a FeeCollector swap on that chain is reported as rejected (wrong_target).',
  'stdout: one JSON line per row, then one summary line. Exit: 0 the run completed, 1 it could not, 2 bad arguments.',
].join('\n')

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { apply: false, fromDb: false, delayMs: 200, limit: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') args.apply = true
    else if (a === '--from-db') args.fromDb = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (a === '--delay-ms' || a === '--limit') {
      const value = argv[++i]
      if (value === undefined || !/^\d{1,7}$/.test(value)) return { error: `${a} needs a whole number` }
      if (a === '--delay-ms') args.delayMs = Number(value)
      else args.limit = Number(value)
    } else return { error: `unknown argument: ${a.replace(/[^\x20-\x7e]/g, '?').slice(0, 40)}` }
  }
  return args
}

// ── The database side (used only with --from-db and --apply) ────────────────────────────────────────────────────

interface DbError {
  code?: string
  message?: string
}
interface DbResult {
  data: unknown[] | null
  error: DbError | null
}
/** The few calls the script makes on the Supabase client; the real client and the tests' fake both fit. */
export interface SwapsDb {
  from(table: string): {
    select(columns: string): { order(column: string, options: { ascending: boolean }): { range(from: number, to: number): PromiseLike<DbResult> } }
    update(values: Record<string, unknown>): { eq(column: string, value: unknown): { is(column: string, value: null): { select(columns: string): PromiseLike<DbResult> } } }
  }
}

const PAGE = 1000

function missingVerifiedColumn(error: DbError | null): boolean {
  return !!error && (error.code === '42703' || error.code === 'PGRST204') && /verified_(at|kind)|claimed_(tx_hash|chain_id|at)/.test(String(error.message ?? ''))
}

/** A failure whose message is fixed words written in this file: safe to print. */
export class ScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptError'
  }
}

/** Every row of `swaps`, oldest first. Before the migration the table has no verified_at: then every row is unverified. */
export async function readRowsFromDb(db: SwapsDb, limit: number | null, requireMigration: boolean): Promise<unknown[]> {
  const rows: unknown[] = []
  let columns = STORED_COLUMNS
  for (let from = 0; limit === null || rows.length < limit; from += PAGE) {
    let page = await db.from('swaps').select(columns).order('created_at', { ascending: true }).range(from, from + PAGE - 1)
    if (page.error && missingVerifiedColumn(page.error) && columns === STORED_COLUMNS) {
      if (requireMigration) throw new ScriptError('migration_not_applied')
      columns = STORED_COLUMNS_BEFORE_MIGRATION
      page = await db.from('swaps').select(columns).order('created_at', { ascending: true }).range(from, from + PAGE - 1)
    }
    // Only the code: a database error message can carry the project's host.
    if (page.error) throw new ScriptError(`db_read_failed code=${String(page.error.code ?? 'unknown').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20)}`)
    const data = page.data ?? []
    rows.push(...data)
    if (data.length < PAGE) break
  }
  return limit === null ? rows : rows.slice(0, limit)
}

/** Apply mode's write: verified_at and verified_kind, and nothing else, on one row, only while it is unverified. */
export function markWith(db: SwapsDb): Mark {
  return async (id, kind, verifiedAt) => {
    const { data, error } = await db.from('swaps').update({ verified_at: verifiedAt, verified_kind: kind }).eq('id', id).is('verified_at', null).select('id')
    // Without the two columns nothing can be marked: stop the run instead of reporting an error per row.
    if (missingVerifiedColumn(error)) throw new ScriptError('migration_not_applied')
    // 23505: the unique index. Another row already carries this (chain, transaction): one transaction, one row.
    if (error) return error.code === '23505' ? 'duplicate_tx' : 'error'
    return (data ?? []).length === 1 ? 'marked' : 'already_verified'
  }
}

// ── The whole run, with the process handed in ────────────────────────────────────────────────────────────────────

export interface MainDeps {
  argv: readonly string[]
  readStdin: () => Promise<string>
  /** One line to stdout; resolves when the line has been handed to the stream (and the stream has drained). */
  out: (line: string) => Promise<void>
  err: (line: string) => void
  verify: Verify
  /** The service-role client, or null when the two environment names are not both set. */
  db: () => SwapsDb | null
  /** Lines that say how the chain will be read: environment NAMES and public addresses only. */
  describe: () => Array<Record<string, unknown>>
  sleep: (ms: number) => Promise<void>
  now?: () => Date
  /** Apply mode: how a claim row is decided with that database (the route's own confirmation). */
  confirmClaim?: (db: SwapsDb) => ConfirmClaim
}

/** Returns the exit code. Never calls process.exit: the caller sets process.exitCode, so stdout is not cut short. */
export async function main(deps: MainDeps): Promise<number> {
  const args = parseArgs(deps.argv)
  if ('error' in args) {
    deps.err(`verify-stored-swaps: ${args.error}`)
    deps.err(USAGE)
    return 2
  }
  if (args.help) {
    for (const line of USAGE.split('\n')) await deps.out(line)
    return 0
  }

  try {
    const needsDb = args.fromDb || args.apply
    const db = needsDb ? deps.db() : null
    if (needsDb && db === null) throw new ScriptError('database_not_configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')

    let rows: unknown[]
    if (args.fromDb) rows = await readRowsFromDb(db as SwapsDb, args.limit, args.apply)
    else {
      rows = parseRows(await deps.readStdin())
      if (args.limit !== null) rows = rows.slice(0, args.limit)
    }

    await deps.out(JSON.stringify({ info: 'mode', mode: args.apply ? 'apply' : 'report', rows: rows.length, input: args.fromDb ? 'database' : 'stdin' }))
    for (const line of deps.describe()) await deps.out(JSON.stringify(line))

    await run({
      rows,
      verify: deps.verify,
      emit: (line) => deps.out(JSON.stringify(line)),
      mark: args.apply ? markWith(db as SwapsDb) : undefined,
      confirmClaim: args.apply && deps.confirmClaim ? deps.confirmClaim(db as SwapsDb) : undefined,
      pause: args.delayMs > 0 ? () => deps.sleep(args.delayMs) : undefined,
      now: deps.now,
    })
    return 0
  } catch (error) {
    // A ScriptError carries fixed words written in this file. Anything else is not printed: its message could hold a
    // URL (a database host, an RPC endpoint with its key).
    deps.err(`verify-stored-swaps: ${error instanceof ScriptError ? error.message : 'failed'}`)
    return 1
  }
}
