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
 */
import type { DerivedSwap, VerifiedKind, VerifySwapInput, VerifySwapResult } from '@/lib/swap-verify/verify-swap-on-chain'

/** The receipt's amount-out must be at least half and at most twice the stored (quoted) one. */
export const OUT_RATIO_MIN_NUM = 1n
export const OUT_RATIO_MIN_DEN = 2n
export const OUT_RATIO_MAX_NUM = 2n
export const OUT_RATIO_MAX_DEN = 1n

/** The columns the script reads. */
export const STORED_COLUMNS = 'id, wallet, chain_id, source, tx_hash, status, token_in, token_out, amount_in, amount_out, verified_at, created_at'
export const STORED_COLUMNS_BEFORE_MIGRATION = 'id, wallet, chain_id, source, tx_hash, status, token_in, token_out, amount_in, amount_out, created_at'

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

export type Applied = 'marked' | 'already_verified' | 'duplicate_tx' | 'error'

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

/** A stored amount as digits: an integer string, or a numeric with a zero fraction ("1000.00"). null: not an integer. */
function digits(v: unknown): string | null {
  const t = text(v)
  if (t === null) return null
  const whole = /^(\d{1,78})(?:\.0*)?$/.exec(t.trim())
  return whole ? BigInt(whole[1]).toString() : null
}

function ratio4(numerator: bigint, denominator: bigint): string {
  const scaled = (numerator * 10_000n) / denominator
  const whole = scaled / 10_000n
  return `${whole}.${(scaled % 10_000n).toString().padStart(4, '0')}`
}

/** The comparison of one verified row with its receipt. */
export function compareStored(
  row: Record<string, unknown>,
  outcome: 'confirmed' | 'failed',
  derived: DerivedSwap,
): { statusAgrees: boolean; differs: string[]; outRatio: string | null } {
  const status = text(row.status)
  const statusAgrees = outcome === 'confirmed' ? status === 'confirmed' || status === 'pending' : status === 'failed'

  const differs: string[] = []
  const storedIn = text(row.token_in)?.toLowerCase() ?? null
  const storedOut = text(row.token_out)?.toLowerCase() ?? null
  if (derived.tokenIn === null || storedIn !== derived.tokenIn) differs.push('token_in')
  if (derived.tokenOut === null || storedOut !== derived.tokenOut) differs.push('token_out')

  const storedAmountIn = digits(row.amount_in)
  if (derived.amountIn === null || storedAmountIn === null || BigInt(storedAmountIn) !== BigInt(derived.amountIn)) differs.push('amount_in')

  const storedAmountOut = digits(row.amount_out)
  let outRatio: string | null = null
  if (derived.amountOut === null || storedAmountOut === null || BigInt(storedAmountOut) === 0n) {
    differs.push('amount_out')
  } else {
    const got = BigInt(derived.amountOut)
    const quoted = BigInt(storedAmountOut)
    outRatio = ratio4(got, quoted)
    const atLeastHalf = got * OUT_RATIO_MIN_DEN >= quoted * OUT_RATIO_MIN_NUM
    const atMostTwice = got * OUT_RATIO_MAX_DEN <= quoted * OUT_RATIO_MAX_NUM
    if (!atLeastHalf || !atMostTwice) differs.push('amount_out')
  }
  return { statusAgrees, differs, outRatio }
}

export type Verify = (input: VerifySwapInput) => Promise<VerifySwapResult>

/** Checks ONE stored row. Never writes. */
export async function checkRow(raw: unknown, verify: Verify): Promise<RowReport> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { id: null, chain: null, decision: 'bad_row', reason: 'not_an_object' }
  const row = raw as Record<string, unknown>
  const id = text(row.id)
  const chain = typeof row.chain_id === 'number' ? row.chain_id : typeof row.chain_id === 'string' && /^\d+$/.test(row.chain_id) ? Number(row.chain_id) : null
  const base = { id, chain }

  if (row.verified_at !== null && row.verified_at !== undefined) return { ...base, decision: 'already_verified' }
  if (id === null) return { ...base, decision: 'bad_row', reason: 'no_id' }
  if (row.tx_hash === null || row.tx_hash === undefined || row.tx_hash === '') return { ...base, decision: 'no_tx_hash' }
  const txHash = text(row.tx_hash)
  const wallet = text(row.wallet)
  const source = text(row.source)
  if (chain === null) return { ...base, decision: 'bad_row', reason: 'no_chain_id' }
  if (txHash === null || !TX_HASH_RE.test(txHash)) return { ...base, decision: 'rejected', outcome: 'rejected', reason: 'bad_tx_hash' }
  if (wallet === null || source === null) return { ...base, decision: 'bad_row', reason: 'no_wallet_or_source' }

  const result = await verify({ chainId: chain, txHash, wallet, source })
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
  if (!compared.statusAgrees || compared.differs.length > 0) {
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

export interface RunOptions {
  rows: readonly unknown[]
  verify: Verify
  emit: (line: RowReport | Summary) => Promise<void> | void
  /** Present only in apply mode. */
  mark?: Mark
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
    const report = await checkRow(raw, options.verify)
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
    // Only a row that was looked up on-chain costs a read.
    if (report.outcome !== undefined && options.pause) await options.pause()
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
  'status, token_in, token_out, amount_in, amount_out, verified_at), { "rows": [...] }, or one object per line.',
  '',
  '  --from-db       read the rows from the database (env SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)',
  '  --apply         set verified_at and verified_kind on the rows whose decision is "mark" (needs the database)',
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
  return !!error && (error.code === '42703' || error.code === 'PGRST204') && /verified_(at|kind)/.test(String(error.message ?? ''))
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
