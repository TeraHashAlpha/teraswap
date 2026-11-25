/**
 * [ADR-029] An in-memory stand-in for the Supabase client, for driving the REAL /api/log-swap handlers and the REAL
 * readers of `swaps` end to end. It behaves like the database in the ways these tests depend on:
 *
 *   - a column the table does not have is error 42703 (so "migration not applied" is a schema without the two columns);
 *   - NOT NULL columns refuse null (23502); the migration's dropped NOT NULLs are a different schema;
 *   - the migration's partial unique index on (chain_id, lower(tx_hash)) where verified_at is not null refuses a
 *     second verified row for one transaction (23505), and its CHECK refuses an unknown verified_kind (23514);
 *   - the `logger` client may INSERT only (P114/M-03): a select or an update with it is 42501;
 *   - filters: eq, neq, in, is, not(.., 'is', null), gt, gte, lt, lte, ilike and PostgREST's `or(...)` text;
 *     order, limit, range; `{ count, head }`; `update(...).select()`; `rpc('gasless_stats')` as the SQL function
 *     of migration 20260514 computes it.
 *
 * Every call is recorded in `ops`, so a test can say what a route asked the database for and what it wrote.
 */

export type Row = Record<string, unknown>

/** `swaps` as supabase/schema.sql creates it, plus the columns later migrations added (before ADR-029). */
export const SWAPS_COLUMNS_BEFORE = [
  'id', 'created_at', 'wallet', 'tx_hash', 'chain_id', 'status', 'source',
  'token_in', 'token_in_symbol', 'token_out', 'token_out_symbol', 'amount_in', 'amount_out', 'amount_in_usd', 'amount_out_usd',
  'slippage', 'mev_protected', 'fee_collected', 'fee_amount', 'gas_used', 'gas_price',
  'mev_savings_estimate', 'mev_savings_actual', 'is_gasless', 'gas_savings_usd', 'expected_output',
] as const

/** After the ADR-029 migration. */
export const SWAPS_COLUMNS_AFTER = [...SWAPS_COLUMNS_BEFORE, 'verified_at', 'verified_kind'] as const

/** The six columns the ADR-029 migration drops NOT NULL on. */
export const SWAPS_SIDE_COLUMNS = ['token_in', 'token_in_symbol', 'token_out', 'token_out_symbol', 'amount_in', 'amount_out'] as const

/** NOT NULL after the migration: schema.sql:10-38 less the six side columns, plus migration 20260513's two. */
export const SWAPS_NOT_NULL_AFTER = [
  'id', 'created_at', 'wallet', 'chain_id', 'status', 'source', 'slippage', 'mev_protected', 'fee_collected', 'is_gasless', 'gas_savings_usd',
] as const

/** NOT NULL before the migration. */
export const SWAPS_NOT_NULL_BEFORE = [...SWAPS_NOT_NULL_AFTER, ...SWAPS_SIDE_COLUMNS] as const

/** Column defaults of the table (schema.sql, migration 20260513). */
const SWAPS_DEFAULTS: Row = { chain_id: 1, status: 'pending', slippage: 0.5, mev_protected: false, fee_collected: false, is_gasless: false, gas_savings_usd: 0 }

const VERIFIED_KINDS = new Set(['fee_collector', 'router', 'cow'])

export interface FakeSwapsDbOptions {
  /** false: the schema before the ADR-029 migration. Default true. */
  migrated?: boolean
  swaps?: Row[]
  /** Rows of any other table a reader touches (`quotes`, `order_executions`, ...). Unknown tables are empty. */
  tables?: Record<string, Row[]>
  now?: () => Date
}

export interface RecordedOp {
  role: 'service' | 'logger'
  kind: 'select' | 'insert' | 'update' | 'rpc'
  table: string
  /** select: the column text. insert / update: the written object. */
  detail: unknown
  filters: string[]
}

interface PgError {
  code: string
  message: string
}

type Result = { data: Row[] | null; error: PgError | null; count: number | null }

type Predicate = (row: Row) => boolean

function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  if (current !== '') parts.push(current)
  return parts
}

function coerce(text: string): unknown {
  if (text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  return text
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

function test(op: string, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq': return actual !== null && actual !== undefined && String(actual) === String(expected)
    case 'neq': return actual !== null && actual !== undefined && String(actual) !== String(expected)
    case 'is': return expected === null ? actual === null || actual === undefined : actual === expected
    case 'gt': return actual !== null && actual !== undefined && compare(actual, expected) > 0
    case 'gte': return actual !== null && actual !== undefined && compare(actual, expected) >= 0
    case 'lt': return actual !== null && actual !== undefined && compare(actual, expected) < 0
    case 'lte': return actual !== null && actual !== undefined && compare(actual, expected) <= 0
    // ilike with no wildcard: case-insensitive equality. `%` and `_` are honoured, as Postgres does.
    case 'ilike': {
      if (actual === null || actual === undefined) return false
      const pattern = String(expected).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')
      return new RegExp(`^${pattern}$`, 'i').test(String(actual))
    }
    default: throw new Error(`fake-swaps-db: unsupported operator ${op}`)
  }
}

/** PostgREST's logic-tree text, e.g. `status.eq.confirmed,and(status.eq.pending,tx_hash.not.is.null)`. */
function parseLogic(text: string, joiner: 'or' | 'and', columns: Set<string>): Predicate {
  const terms = splitTopLevel(text).map((term): Predicate => {
    const group = /^(and|or)\((.*)\)$/.exec(term)
    if (group) return parseLogic(group[2], group[1] as 'and' | 'or', columns)
    const [column, ...rest] = term.split('.')
    columns.add(column)
    const negated = rest[0] === 'not'
    const op = negated ? rest[1] : rest[0]
    const value = coerce((negated ? rest.slice(2) : rest.slice(1)).join('.'))
    return (row) => test(op, row[column], value) !== negated
  })
  return joiner === 'or' ? (row) => terms.some((t) => t(row)) : (row) => terms.every((t) => t(row))
}

export function createFakeSwapsDb(options: FakeSwapsDbOptions = {}) {
  const migrated = options.migrated !== false
  const columns: readonly string[] = migrated ? SWAPS_COLUMNS_AFTER : SWAPS_COLUMNS_BEFORE
  const notNull: readonly string[] = migrated ? SWAPS_NOT_NULL_AFTER : SWAPS_NOT_NULL_BEFORE
  const now = options.now ?? (() => new Date())
  // A Map, never a plain object: a table name can come from a request (the HTTP shim of e2e/swap-log), and a name
  // must not be able to reach a property of Object.prototype.
  const tables = new Map<string, Row[]>(Object.entries(options.tables ?? {}))
  tables.set('swaps', (options.swaps ?? []).map((r) => ({ ...r })))
  const ops: RecordedOp[] = []
  let sequence = 0

  const rowsOf = (table: string): Row[] => {
    let rows = tables.get(table)
    if (!rows) {
      rows = []
      tables.set(table, rows)
    }
    return rows
  }
  const missingColumn = (table: string, column: string): PgError => ({ code: '42703', message: `column ${table}.${column} does not exist` })

  function checkColumns(table: string, used: Iterable<string>): PgError | null {
    if (table !== 'swaps') return null
    for (const c of used) if (!columns.includes(c)) return missingColumn(table, c)
    return null
  }

  function constraintError(row: Row, others: Row[]): PgError | null {
    for (const c of notNull) {
      if (row[c] === null || row[c] === undefined) return { code: '23502', message: `null value in column "${c}" of relation "swaps" violates not-null constraint` }
    }
    if (!migrated) return null
    if (row.verified_kind !== null && row.verified_kind !== undefined && !VERIFIED_KINDS.has(String(row.verified_kind))) {
      return { code: '23514', message: 'new row for relation "swaps" violates check constraint "swaps_verified_kind_check"' }
    }
    if (row.verified_at !== null && row.verified_at !== undefined && row.tx_hash !== null && row.tx_hash !== undefined) {
      const key = `${row.chain_id}|${String(row.tx_hash).toLowerCase()}`
      const clash = others.some((o) => o !== row && o.verified_at !== null && o.verified_at !== undefined && o.tx_hash !== null && o.tx_hash !== undefined && `${o.chain_id}|${String(o.tx_hash).toLowerCase()}` === key)
      if (clash) return { code: '23505', message: 'duplicate key value violates unique constraint "idx_swaps_verified_tx"' }
    }
    return null
  }

  function project(table: string, row: Row, selectText: string): Row {
    const text = selectText.trim()
    if (text === '' || text === '*') return table === 'swaps' ? Object.fromEntries(columns.map((c) => [c, row[c] ?? null])) : { ...row }
    const names = splitTopLevel(text).map((s) => {
      const item = s.trim()
      const open = item.indexOf('(')
      // An embed (`orders(...)`, `orders!inner(...)`): the stored parent object, as it is.
      return open === -1 ? item : item.slice(0, open).split('!')[0]
    })
    // Own properties of the row only, so a selected name can not read (or, in the copy, become) anything inherited.
    return Object.fromEntries(names.map((name) => [name, Object.prototype.hasOwnProperty.call(row, name) ? (row[name] ?? null) : null]))
  }

  function selectColumns(selectText: string): string[] {
    const text = selectText.trim()
    if (text === '' || text === '*') return []
    return splitTopLevel(text).map((s) => s.trim()).filter((s) => !s.includes('('))
  }

  function builder(role: 'service' | 'logger', table: string) {
    const predicates: Predicate[] = []
    const filterText: string[] = []
    const used = new Set<string>()
    let mode: 'select' | 'insert' | 'update' = 'select'
    let selectText = '*'
    let returning = false
    let head = false
    let countMode: string | null = null
    let payload: Row | Row[] = {}
    let orderBy: { column: string; ascending: boolean } | null = null
    let limitTo: number | null = null
    let rangeOf: [number, number] | null = null

    const filter = (text: string, column: string, predicate: Predicate) => {
      // A filter on an embedded table (`orders.wallet`) is not a column of this one.
      if (!column.includes('.')) used.add(column)
      filterText.push(text)
      predicates.push(predicate)
      return api
    }

    function run(): Result {
      const denied: PgError = { code: '42501', message: `permission denied for table ${table}` }
      const all = rowsOf(table)

      if (mode === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ ...r }))
        ops.push({ role, kind: 'insert', table, detail: Array.isArray(payload) ? list : list[0], filters: [] })
        const inserted: Row[] = []
        for (const input of list) {
          const columnError = checkColumns(table, Object.keys(input))
          if (columnError) return { data: null, error: columnError, count: null }
          const row: Row = table === 'swaps'
            ? {
                ...Object.fromEntries(columns.map((c) => [c, null])),
                id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
                created_at: now().toISOString(),
                ...SWAPS_DEFAULTS,
                ...input,
              }
            : { ...input }
          if (table === 'swaps') {
            const error = constraintError(row, all)
            if (error) return { data: null, error, count: null }
          }
          all.push(row)
          inserted.push(row)
        }
        if (returning && role === 'logger') return { data: null, error: denied, count: null }
        return { data: returning ? inserted.map((r) => project(table, r, selectText)) : null, error: null, count: null }
      }

      if (role === 'logger') {
        ops.push({ role, kind: mode, table, detail: mode === 'select' ? selectText : payload, filters: [...filterText] })
        return { data: null, error: denied, count: null }
      }

      const columnError = checkColumns(table, [...used, ...selectColumns(selectText), ...(mode === 'update' ? Object.keys(payload as Row) : [])])
      if (mode === 'update') ops.push({ role, kind: 'update', table, detail: { ...(payload as Row) }, filters: [...filterText] })
      else ops.push({ role, kind: 'select', table, detail: selectText, filters: [...filterText] })
      if (columnError) return { data: null, error: columnError, count: null }

      let matched = all.filter((row) => predicates.every((p) => p(row)))
      if (orderBy) {
        const { column, ascending } = orderBy
        matched = [...matched].sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]))
      }

      if (mode === 'update') {
        if (limitTo !== null) matched = matched.slice(0, limitTo)
        for (const row of matched) {
          const next = { ...row, ...(payload as Row) }
          const error = table === 'swaps' ? constraintError(next, all.filter((o) => o !== row)) : null
          if (error) return { data: null, error, count: null }
        }
        for (const row of matched) Object.assign(row, payload as Row)
        return { data: returning ? matched.map((r) => project(table, r, selectText)) : null, error: null, count: null }
      }

      const count = countMode ? matched.length : null
      let page = matched
      if (rangeOf) page = page.slice(rangeOf[0], rangeOf[1] + 1)
      if (limitTo !== null) page = page.slice(0, limitTo)
      return { data: head ? null : page.map((r) => project(table, r, selectText)), error: null, count }
    }

    const api = {
      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        if (mode === 'select') {
          head = opts?.head === true
          countMode = opts?.count ?? null
        } else returning = true
        selectText = cols ?? '*'
        return api
      },
      insert(value: Row | Row[]) {
        mode = 'insert'
        payload = value
        return api
      },
      update(value: Row) {
        mode = 'update'
        payload = value
        return api
      },
      eq: (column: string, value: unknown) => filter(`${column}=eq.${String(value)}`, column, (row) => test('eq', row[column], value)),
      neq: (column: string, value: unknown) => filter(`${column}=neq.${String(value)}`, column, (row) => test('neq', row[column], value)),
      in: (column: string, values: unknown[]) => filter(`${column}=in.(${values.join(',')})`, column, (row) => values.some((v) => test('eq', row[column], v))),
      is: (column: string, value: unknown) => filter(`${column}=is.${String(value)}`, column, (row) => test('is', row[column], value)),
      not: (column: string, op: string, value: unknown) => filter(`${column}=not.${op}.${String(value)}`, column, (row) => !test(op, row[column], value)),
      gt: (column: string, value: unknown) => filter(`${column}=gt.${String(value)}`, column, (row) => test('gt', row[column], value)),
      gte: (column: string, value: unknown) => filter(`${column}=gte.${String(value)}`, column, (row) => test('gte', row[column], value)),
      lt: (column: string, value: unknown) => filter(`${column}=lt.${String(value)}`, column, (row) => test('lt', row[column], value)),
      lte: (column: string, value: unknown) => filter(`${column}=lte.${String(value)}`, column, (row) => test('lte', row[column], value)),
      ilike: (column: string, value: string) => filter(`${column}=ilike.${value}`, column, (row) => test('ilike', row[column], value)),
      or(text: string) {
        const named = new Set<string>()
        const predicate = parseLogic(text, 'or', named)
        for (const c of named) used.add(c)
        filterText.push(`or=(${text})`)
        predicates.push(predicate)
        return api
      },
      order(column: string, opts?: { ascending?: boolean }) {
        used.add(column)
        orderBy = { column, ascending: opts?.ascending !== false }
        filterText.push(`order=${column}.${opts?.ascending === false ? 'desc' : 'asc'}`)
        return api
      },
      limit(n: number) {
        limitTo = n
        filterText.push(`limit=${n}`)
        return api
      },
      range(from: number, to: number) {
        rangeOf = [from, to]
        filterText.push(`range=${from}-${to}`)
        return api
      },
      then<T1 = Result, T2 = never>(resolve?: ((v: Result) => T1 | PromiseLike<T1>) | null, reject?: ((e: unknown) => T2 | PromiseLike<T2>) | null) {
        return Promise.resolve().then(run).then(resolve, reject)
      },
    }
    return api
  }

  function client(role: 'service' | 'logger') {
    return {
      from: (table: string) => builder(role, table),
      rpc(name: string) {
        ops.push({ role, kind: 'rpc', table: name, detail: null, filters: [] })
        if (name !== 'gasless_stats') return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `function ${name} not found` } })
        // supabase/migrations/20260514_gasless_stats_rpc.sql, as written.
        const rows = rowsOf('swaps').filter((r) => r.is_gasless === true && (r.status === 'confirmed' || (r.status === 'pending' && r.tx_hash !== null && r.tx_hash !== undefined)))
        const total = rows.reduce((sum, r) => sum + (Number(r.gas_savings_usd) || 0), 0)
        return Promise.resolve({ data: [{ total_gasless: rows.length, total_gas_saved: total }], error: null })
      },
    }
  }

  return {
    /** The service-role client (reads, updates). */
    service: client('service'),
    /** The insert-only logger client. */
    logger: client('logger'),
    /** The live rows of a table. */
    rows: (table = 'swaps') => rowsOf(table),
    ops,
    /** What was written to `swaps` (inserts and updates), in order. */
    writes: () => ops.filter((o) => o.table === 'swaps' && (o.kind === 'insert' || o.kind === 'update')),
    migrated,
  }
}

export type FakeSwapsDb = ReturnType<typeof createFakeSwapsDb>
