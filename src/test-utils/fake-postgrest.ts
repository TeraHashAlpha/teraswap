/**
 * [fix/order-signature-not-returned] A small in-memory stand-in for the Supabase/PostgREST client, for driving the
 * REAL route handlers end to end. Unlike the permissive builders in older route tests (which return the same rows
 * whatever columns were asked for), this one honours the `select` string the way PostgREST does:
 *   - `*` returns every column of the table, a column list returns exactly those columns;
 *   - an embed `orders(a,b)` / `orders!inner(a,b)` attaches the parent row projected to those columns (inner drops
 *     the child when no parent matches or a filter on the parent fails);
 *   - a column the table does not have (a migration not applied) is an error `{ code: '42703' }`, as Postgres says it;
 *   - `{ count, head: true }` returns only the count.
 * Supported: from, select, eq, in, gte, order, limit, range, single, then (awaiting the builder runs the query). Every
 * `select` is recorded in `selects`, so a test can assert what each route asked the database for.
 */

export type Row = Record<string, unknown>

export interface FakeRelation {
  /** The parent table the embed names (e.g. `orders`). */
  table: string
  /** Column on the child row (e.g. `order_executions.order_id`). */
  localKey: string
  /** Column on the parent row (e.g. `orders.id`). */
  foreignKey: string
}

export interface FakePostgrestOptions {
  /** Rows per table. */
  tables: Record<string, Row[]>
  /** The columns each table HAS. A selected column outside this list is a 42703 error. */
  schema: Record<string, readonly string[]>
  /** `child.embedName` → how the embed joins, e.g. `{ 'order_executions.orders': { table: 'orders', localKey: 'order_id', foreignKey: 'id' } }`. */
  relations?: Record<string, FakeRelation>
}

export interface RecordedSelect {
  table: string
  columns: string
  head: boolean
}

interface PgError {
  code: string
  message: string
}

type Filter =
  | { kind: 'eq'; path: string; value: unknown }
  | { kind: 'in'; path: string; values: unknown[] }
  | { kind: 'gte'; path: string; value: unknown }

interface SelectItem {
  kind: 'star' | 'column' | 'embed'
  name: string
  inner?: boolean
  children?: SelectItem[]
}

/** Split `a, b(c, d), e` at top-level commas. */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter((x) => x.length > 0)
}

export function parseSelect(columns: string): SelectItem[] {
  return splitTopLevel(columns).map((item): SelectItem => {
    if (item === '*') return { kind: 'star', name: '*' }
    const open = item.indexOf('(')
    if (open !== -1 && item.endsWith(')')) {
      const head = item.slice(0, open).trim()
      const [name, hint] = head.split('!')
      return { kind: 'embed', name: name.trim(), inner: hint?.trim() === 'inner', children: parseSelect(item.slice(open + 1, -1)) }
    }
    return { kind: 'column', name: item }
  })
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a ?? '').localeCompare(String(b ?? ''))
}

export function createFakePostgrest(opts: FakePostgrestOptions) {
  const selects: RecordedSelect[] = []
  const relations = opts.relations ?? {}

  function project(table: string, row: Row, items: SelectItem[]): { value: Row | null; error: PgError | null; innerFail: boolean } {
    const schema = opts.schema[table] ?? []
    const out: Row = {}
    for (const item of items) {
      if (item.kind === 'star') {
        for (const col of schema) out[col] = row[col] ?? null
      } else if (item.kind === 'column') {
        if (!schema.includes(item.name)) {
          return { value: null, error: { code: '42703', message: `column ${table}.${item.name} does not exist` }, innerFail: false }
        }
        out[item.name] = row[item.name] ?? null
      } else {
        const rel = relations[`${table}.${item.name}`]
        if (!rel) return { value: null, error: { code: 'PGRST200', message: `no relationship ${table} -> ${item.name}` }, innerFail: false }
        const parent = (opts.tables[rel.table] ?? []).find((p) => String(p[rel.foreignKey]) === String(row[rel.localKey]))
        if (!parent) {
          if (item.inner) return { value: null, error: null, innerFail: true }
          out[item.name] = null
          continue
        }
        const nested = project(rel.table, parent, item.children ?? [])
        if (nested.error) return nested
        out[item.name] = nested.value
      }
    }
    return { value: out, error: null, innerFail: false }
  }

  /** Read a filter path against the ORIGINAL row (`col`) or its embedded parent (`orders.col`). */
  function read(table: string, row: Row, path: string): { found: boolean; value: unknown; embed?: string } {
    const dot = path.indexOf('.')
    if (dot === -1) return { found: true, value: row[path] }
    const embed = path.slice(0, dot)
    const rel = relations[`${table}.${embed}`]
    if (!rel) return { found: false, value: undefined }
    const parent = (opts.tables[rel.table] ?? []).find((p) => String(p[rel.foreignKey]) === String(row[rel.localKey]))
    return { found: !!parent, value: parent ? parent[path.slice(dot + 1)] : undefined, embed }
  }

  function matches(f: Filter, v: unknown): boolean {
    if (f.kind === 'eq') return String(v) === String(f.value)
    if (f.kind === 'in') return f.values.some((x) => String(x) === String(v))
    return compare(v, f.value) >= 0
  }

  function builder(table: string) {
    let columns = '*'
    let head = false
    let countMode: string | null = null
    const filters: Filter[] = []
    let orderBy: { col: string; ascending: boolean } | null = null
    let limitN: number | null = null
    let range: [number, number] | null = null

    function run(): { data: Row[] | null; error: PgError | null; count: number | null } {
      const items = parseSelect(columns)
      // Order by the ORIGINAL row's column, before projection (the column need not be selected), as PostgREST does.
      const rows = [...(opts.tables[table] ?? [])]
      if (orderBy) {
        const { col, ascending } = orderBy
        rows.sort((a, b) => (ascending ? compare(a[col], b[col]) : compare(b[col], a[col])))
      }
      const kept: Row[] = []
      for (const row of rows) {
        let ok = true
        const nulledEmbeds = new Set<string>()
        for (const f of filters) {
          const r = read(table, row, f.path)
          if (r.embed !== undefined) {
            const item = items.find((i) => i.kind === 'embed' && i.name === r.embed)
            const pass = r.found && matches(f, r.value)
            if (!pass) {
              if (item?.inner) ok = false
              else nulledEmbeds.add(r.embed)
            }
          } else if (!matches(f, r.value)) ok = false
        }
        if (!ok) continue
        const p = project(table, row, items)
        if (p.error) return { data: null, error: p.error, count: null }
        if (p.innerFail || !p.value) continue
        for (const e of nulledEmbeds) p.value[e] = null
        kept.push(p.value)
      }
      const count = countMode ? kept.length : null
      let page = kept
      if (range) page = page.slice(range[0], range[1] + 1)
      if (limitN !== null) page = page.slice(0, limitN)
      return { data: head ? null : page, error: null, count }
    }

    const b = {
      select(cols?: string, options?: { count?: string; head?: boolean }) {
        columns = cols === undefined || cols === '' ? '*' : cols
        head = options?.head === true
        countMode = options?.count ?? null
        selects.push({ table, columns: cols ?? '', head })
        return b
      },
      eq(path: string, value: unknown) { filters.push({ kind: 'eq', path, value }); return b },
      in(path: string, values: unknown[]) { filters.push({ kind: 'in', path, values }); return b },
      gte(path: string, value: unknown) { filters.push({ kind: 'gte', path, value }); return b },
      order(col: string, o?: { ascending?: boolean }) { orderBy = { col, ascending: o?.ascending !== false }; return b },
      limit(n: number) { limitN = n; return b },
      range(from: number, to: number) { range = [from, to]; return b },
      async single() {
        const r = run()
        if (r.error) return { data: null, error: r.error }
        if (!r.data || r.data.length !== 1) {
          return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
        }
        return { data: r.data[0], error: null }
      },
      then<T1 = unknown, T2 = never>(
        resolve?: ((v: { data: Row[] | null; error: PgError | null; count: number | null }) => T1 | PromiseLike<T1>) | null,
        reject?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
      ): Promise<T1 | T2> {
        return Promise.resolve().then(run).then(resolve, reject)
      },
    }
    return b
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: async () => ({ data: true, error: null }),
  }
  return { client, selects }
}

/**
 * Every place in a JSON body where an order signature shows: a key named `signature` (any case), or a string value
 * containing one of the stored signatures (hex compared case-insensitively, with or without 0x). Returns PATHS only,
 * never the values, so a failing assertion cannot print a signature.
 */
export function findSignatureLeaks(body: unknown, storedSignatures: readonly string[]): string[] {
  const needles = storedSignatures.map((s) => s.toLowerCase().replace(/^0x/, '')).filter((s) => s.length > 0)
  const leaks: string[] = []
  const hasNeedle = (s: string) => {
    const lower = s.toLowerCase()
    return needles.some((n) => lower.includes(n))
  }
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (hasNeedle(v)) leaks.push(`${path} (value)`)
      return
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`))
      return
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k.toLowerCase() === 'signature') leaks.push(`${path}.${k} (key)`)
        if (hasNeedle(k)) leaks.push(`${path}.<key> (key holds a signature)`)
        walk(x, `${path}.${k}`)
      }
    }
  }
  walk(body, '$')
  if (leaks.length === 0 && hasNeedle(JSON.stringify(body) ?? '')) leaks.push('$ (raw body)')
  return leaks
}
