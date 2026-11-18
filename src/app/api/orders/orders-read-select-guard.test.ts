/**
 * [fix/order-signature-not-returned] Guard: a read of `orders` selects an explicit column list, never `*`, never
 * `signature`. Two layers:
 *   1. Dynamic: every read path is driven through the fake PostgREST client, WITHOUT a read signature and WITH one
 *      (the authenticated poll, live orders, history fills), and every `orders` select it sends (top level, or an
 *      `orders(...)` embed from another table) is checked.
 *   2. Static: every `.from(<table>)` chain in src/ (tests excluded) that does not write (insert / update / upsert /
 *      delete) and selects: the table argument must be a string literal or resolve to a `const` string (in the file, or
 *      an exported constant of src/); a chain on `orders` must not select `*`, must not call `.select()` empty (= `*`),
 *      and must not name `signature`; an `orders(...)` / `orders!inner(...)` embed anywhere in src/ must not either.
 *      A select whose argument is not a string literal is accepted ONLY when it is, bare, the columns parameter of the
 *      `withOrderReadColumns((columns) => ...)` callback it sits in (order-read-columns.ts), never a variable, spread,
 *      ternary or concatenation.
 * Each layer's checker is first shown to FAIL on a `*` select, so the guard cannot pass vacuously. [A87 S-5]
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { buildOrdersReadTypedData, ORDERS_READ_HEADER_ISSUED, ORDERS_READ_HEADER_SIGNATURE } from '@/lib/order-engine/read-auth'
import { escapeRegExp } from '@/test-utils/escape-regexp'
import { parseSelect, type RecordedSelect, type Row } from '@/test-utils/fake-postgrest'
import { DB_ORDER_STATUSES, makeExecutionRow, makeOrderRow, makeOrdersDb, makeSwapRow, prng } from '@/test-utils/orders-db-fixture'

let db = makeOrdersDb({ orders: [] })
vi.mock('@supabase/supabase-js', () => ({ createClient: () => db.client }))
vi.mock('@/lib/supabase', async () => ({
  ...(await vi.importActual<typeof import('@/lib/supabase')>('@/lib/supabase')),
  getSupabase: () => db.client,
}))
vi.mock('@/lib/kv-rate-limiter', async () => ({
  ...(await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')),
  checkRateLimit: async () => ({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 }),
}))
vi.mock('@/lib/dca-freeze', () => ({ getDcaFreezeState: vi.fn(async () => ({ frozen: false })) }))

import { GET as LIST } from './route'
import { GET as BY_ID } from './[id]/route'
import { GET as EXECUTIONS } from './[id]/executions/route'
import { GET as STATS } from './stats/route'
import { GET as HISTORY } from '../history/route'
import { GET as ANALYTICS } from '../analytics/route'

// Published Anvil/Hardhat default account #0 key, value-allowlisted in .gitleaks.toml (NOT a secret).
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const WALLET = account.address.toLowerCase()
let seeded: Row[] = []

async function readAuth(): Promise<Record<string, string>> {
  const issuedAt = Math.floor(Date.now() / 1000)
  return {
    [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: await account.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt)),
  }
}

// ── Layer 1: what the unauthenticated read paths ask the database for ─────────────────────────────────────────────
/** Problems with one recorded select, as text; [] when it is an explicit list without `signature`. */
function ordersSelectProblems(s: RecordedSelect): string[] {
  const problems: string[] = []
  const check = (columns: string, where: string) => {
    if (columns.trim() === '') problems.push(`${where}: empty select (PostgREST reads it as *)`)
    for (const item of parseSelect(columns)) {
      if (item.kind === 'star') problems.push(`${where}: selects *`)
      if (item.kind === 'column' && item.name === 'signature') problems.push(`${where}: selects signature`)
    }
  }
  if (s.table === 'orders') check(s.columns, 'orders')
  const embedsOfOrders = (items: ReturnType<typeof parseSelect>): void => {
    for (const item of items) {
      if (item.kind !== 'embed') continue
      if (item.name === 'orders') {
        for (const c of item.children ?? []) {
          if (c.kind === 'star') problems.push(`${s.table} -> orders embed: selects *`)
          if (c.kind === 'column' && c.name === 'signature') problems.push(`${s.table} -> orders embed: selects signature`)
        }
      }
      embedsOfOrders(item.children ?? [])
    }
  }
  if (s.columns.trim() !== '') embedsOfOrders(parseSelect(s.columns))
  return problems
}

describe('guard, layer 1: every read path, without and with a read signature, selects an explicit orders column list', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
    const rand = prng(99)
    seeded = DB_ORDER_STATUSES.map((status) => makeOrderRow(rand, { wallet: WALLET, status }))
    db = makeOrdersDb({ orders: seeded, order_executions: seeded.map((o, i) => makeExecutionRow(rand, o, i + 1)), swaps: [makeSwapRow(rand, WALLET)] })
  })

  it('the checker itself fails a * select, an empty select, a signature column and an orders(*) embed', () => {
    expect(ordersSelectProblems({ table: 'orders', columns: '*', head: false })).toEqual(['orders: selects *'])
    expect(ordersSelectProblems({ table: 'orders', columns: '', head: false })).toHaveLength(1)
    expect(ordersSelectProblems({ table: 'orders', columns: 'id, signature', head: false })).toEqual(['orders: selects signature'])
    expect(ordersSelectProblems({ table: 'order_executions', columns: 'id, orders!inner(*)', head: false })).toHaveLength(1)
    expect(ordersSelectProblems({ table: 'orders', columns: 'id,status', head: true })).toEqual([])
  })

  const byId = (id: unknown) => ({ params: Promise.resolve({ id: String(id) }) })
  const get = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { headers })
  const reachesOrders = (sel: RecordedSelect) => sel.table === 'orders' || /\borders\s*(!\w+)?\s*\(/.test(sel.columns)

  it('every orders select of every unauthenticated read path is explicit', async () => {
    const terminal = 'executed,cancelled,expired,failed'
    await LIST(get(`/api/orders?wallet=${WALLET}&status=${terminal}`))
    await LIST(get(`/api/orders?wallet=${WALLET}&status=cancelled&hashes=0x${'11'.repeat(32)}`))
    for (const order of seeded) {
      await BY_ID(get(`/api/orders/${order.id}?wallet=${WALLET}`), byId(order.id))
      await EXECUTIONS(get(`/api/orders/${order.id}/executions?wallet=${WALLET}`), byId(order.id))
    }
    await STATS(get(`/api/orders/stats?wallet=${WALLET}`))
    await STATS(get('/api/orders/stats'))
    await HISTORY(get(`/api/history?wallet=${WALLET}`))
    await ANALYTICS()

    const touchingOrders = db.selects.filter(reachesOrders)
    // Not vacuous: list, by-id x6, executions x6, stats x12 and the analytics embed all reached `orders`.
    expect(touchingOrders.length).toBeGreaterThanOrEqual(20)
    expect(touchingOrders.flatMap(ordersSelectProblems)).toEqual([])
  })

  // [A87 S-5] A `*` that only a signed read gets (the authenticated by-hash poll, live orders, history fills) never ran above.
  it('every orders select of every AUTHENTICATED read path is explicit: the poll, live orders, history fills', async () => {
    const auth = await readAuth()
    const hashes = seeded.map((o) => String(o.order_hash)).join(',')
    const shapes = [
      '', // no status filter = everything, live included
      'status=active',
      'status=executing',
      'status=active,executing',
      'status=executed,cancelled,expired,failed',
      `hashes=${hashes}`, // the browser's poll (supabase.ts fetchActiveOrders): no status, the hashes it tracks
      `status=active,executing&hashes=${hashes}`,
    ]
    const listStatuses: number[] = []
    for (const q of shapes) listStatuses.push((await LIST(get(`/api/orders?wallet=${WALLET}${q ? `&${q}` : ''}`, auth))).status)
    for (const order of seeded) {
      await BY_ID(get(`/api/orders/${order.id}?wallet=${WALLET}`, auth), byId(order.id))
      await EXECUTIONS(get(`/api/orders/${order.id}/executions?wallet=${WALLET}`, auth), byId(order.id))
    }
    await STATS(get(`/api/orders/stats?wallet=${WALLET}`, auth))
    const history = await (await HISTORY(get(`/api/history?wallet=${WALLET}`, auth))).json()
    await ANALYTICS()

    // Not vacuous: the read signature was accepted (no 401), and the fills path (orders!inner embed) ran.
    expect(listStatuses).toEqual(shapes.map(() => 200))
    expect(history.fillsIncluded).toBe(true)
    const touchingOrders = db.selects.filter(reachesOrders)
    expect(touchingOrders.length).toBeGreaterThanOrEqual(25)
    expect(touchingOrders.flatMap(ordersSelectProblems)).toEqual([])
  })
})

// ── Layer 2: every orders read chain in the source ──────────────────────────────────────────────────────────────────
interface Call { name: string; args: string }
interface Chain { file: string; line: number; index: number; tableArg: string; calls: Call[] }

function skipTrivia(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue }
    return i
  }
}

/** Index of the `)` matching the `(` at `open`, skipping string literals. */
function matchParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++
      continue
    }
    if (ch === '(') depth++
    if (ch === ')' && --depth === 0) return i
  }
  return src.length
}

/** Every `.from(<arg>)` and the calls chained on it. The table is resolved later (resolveTable), not matched here. */
function fromChains(file: string, src: string): Chain[] {
  const out: Chain[] = []
  for (const m of src.matchAll(/\.from\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1
    const argClose = matchParen(src, open)
    const calls: Call[] = []
    let i = argClose + 1
    for (;;) {
      i = skipTrivia(src, i)
      if (src[i] !== '.') break
      const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i + 1))
      if (!id) break
      i = skipTrivia(src, i + 1 + id[0].length)
      if (src[i] !== '(') break
      const close = matchParen(src, i)
      calls.push({ name: id[0], args: src.slice(i + 1, close) })
      i = close + 1
    }
    out.push({ file, line: src.slice(0, m.index).split('\n').length, index: m.index ?? 0, tableArg: src.slice(open + 1, argClose).trim(), calls })
  }
  return out
}

/** `const NAME = 'text'` constants exported anywhere in src/ (a name defined twice with different text is ambiguous: null). */
function exportedStringConstants(files: { src: string }[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const { src } of files) {
    for (const m of src.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?=\s*(['"`])([^'"`$\\\n]*)\2\s*(?:as const)?\s*[;\n]/g)) {
      out.set(m[1], out.has(m[1]) && out.get(m[1]) !== m[3] ? null : m[3])
    }
  }
  return out
}

/**
 * The table a `.from(<arg>)` names: a string literal, or an identifier that is a `const` string in the file or an exported
 * string constant of src/. Anything else (a `let`, a call, a template with `${}`, a member) is null = cannot be told.
 */
function resolveTable(arg: string, fileSrc: string, exported: Map<string, string | null>): string | null {
  const lit = /^(['"`])([^'"`$\\]*)\1$/.exec(arg)
  if (lit) return lit[2]
  if (!/^[A-Za-z_$][\w$]*$/.test(arg)) return null
  const local = new RegExp(`\\bconst\\s+${escapeRegExp(arg)}\\s*(?::\\s*[^=\\n]+)?=\\s*(['"\`])([^'"\`$\\\\\\n]*)\\1\\s*(?:as const)?\\s*[;\\n]`).exec(fileSrc)
  if (local) return local[2]
  return exported.get(arg) ?? null
}

/** The first argument of a call, as text (up to the first top-level comma; string literals are skipped whole). */
function firstArg(args: string): string {
  let depth = 0
  let end = args.length
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < args.length && args[i] !== ch; i++) if (args[i] === '\\') i++
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) { end = i; break }
  }
  return args.slice(0, end).trim()
}

/** A select's first argument when it is a string literal or literals joined by `+`; null otherwise. */
function literalArg(first: string): string | null {
  const parts = first.split('+').map((p) => p.trim())
  if (parts.length === 1 && parts[0] === '') return ''
  if (!parts.every((p) => /^(['"`])[^]*\1$/.test(p) && !p.includes('${'))) return null
  return parts.map((p) => p.slice(1, -1)).join('')
}

/**
 * True when `first` is, bare, the columns parameter of the `withOrderReadColumns(...)` callback that contains the chain at
 * `index`, and the callback never assigns to it. Nothing else non-literal is accepted: not a variable, a spread, a ternary,
 * a concatenation, and not `columns` outside that callback.
 */
function isOrderReadColumnsParam(src: string, index: number, first: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(first)) return false
  for (const m of src.matchAll(/\bwithOrderReadColumns\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1
    const close = matchParen(src, open)
    if (index <= open || index >= close) continue
    const inner = src.slice(open + 1, close)
    const cb = /^\s*(?:async\s*)?(?:\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)|([A-Za-z_$][\w$]*))\s*=>/.exec(inner)
    const param = cb ? (cb[1] ?? cb[2]) : undefined
    if (param !== first) continue
    if (new RegExp(`(?<![\\w$.])${escapeRegExp(first)}\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|\\?\\?|&&|\\|\\|)?=(?![=>])`).test(inner.slice(cb![0].length))) continue
    return true
  }
  return false
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])

function chainProblems(chain: Chain, fileSrc: string, exported: Map<string, string | null>): string[] {
  if (chain.calls.some((c) => WRITES.has(c.name))) return []
  const selects = chain.calls.filter((x) => x.name === 'select')
  if (selects.length === 0) return []
  const where = `${chain.file}:${chain.line}`
  const table = resolveTable(chain.tableArg, fileSrc, exported)
  if (table === null) return [`${where}: .from(${chain.tableArg}) is not a string literal and does not resolve to a const string: the table this select reads cannot be told`]
  if (table !== 'orders') return []
  const problems: string[] = []
  for (const c of selects) {
    const first = firstArg(c.args)
    const lit = literalArg(first)
    if (lit === null) {
      if (!isOrderReadColumnsParam(fileSrc, chain.index, first)) problems.push(`${where}: select(${first}) is not a literal and is not the columns parameter of withOrderReadColumns`)
      continue
    }
    if (lit.trim() === '') problems.push(`${where}: select() with no columns reads *`)
    for (const item of parseSelect(lit)) {
      if (item.kind === 'star') problems.push(`${where}: select('*') on orders`)
      if (item.kind === 'column' && item.name === 'signature') problems.push(`${where}: selects signature`)
    }
  }
  return problems
}

function embedProblems(file: string, src: string): string[] {
  const problems: string[] = []
  for (const m of src.matchAll(/\borders\s*(?:!\w+)?\(([^)]*)\)/g)) {
    // Only inside string literals that look like a PostgREST select (a comma list or a single column).
    const inner = m[1].replace(/['"`]\s*\+\s*['"`]/g, '').replace(/\s+/g, '')
    if (!/^[\w*,]*$/.test(inner)) continue
    const line = src.slice(0, m.index).split('\n').length
    if (inner.split(',').includes('*')) problems.push(`${file}:${line}: orders(*) embed`)
    if (inner.split(',').includes('signature')) problems.push(`${file}:${line}: orders embed selects signature`)
  }
  return problems
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name === 'test-utils') continue
      out.push(...sourceFiles(p))
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/** One source text through the scanner: every problem its chains and embeds have. */
function scan(src: string, exported: Map<string, string | null> = new Map()): string[] {
  return [...fromChains('x.ts', src).flatMap((c) => chainProblems(c, src, exported)), ...embedProblems('x.ts', src)]
}

describe('guard, layer 2: no orders read chain in src/ selects * or signature', () => {
  const ORDERS_TABLE = new Map([['SUPABASE_ORDERS_TABLE', 'orders']])

  it('the scanner itself fails * / empty / signature selects and orders(*) embeds, and passes writes', () => {
    const bad = [
      "supabase.from('orders').select('*').eq('wallet', w)",
      'sb\n  .from("orders")\n  // comment\n  .select()\n  .limit(1)',
      "supabase.from('orders').select('id, ' +\n 'signature').single()",
      'supabase.from(SUPABASE_ORDERS_TABLE).select(cols)',
    ]
    for (const src of bad) expect(scan(src, ORDERS_TABLE).length).toBeGreaterThan(0)
    expect(embedProblems('x.ts', ".from('order_executions').select('id, orders!inner(*)')")).toHaveLength(1)
    expect(embedProblems('x.ts', ".select('id,' +\n 'orders(wallet,signature)')")).toHaveLength(1)
    expect(scan("supabase.from('orders').insert({ a: 1 }).select().single()")).toEqual([])
    expect(scan("supabase.from('orders').select('id, status', { count: 'exact', head: true }).eq('a', 1)")).toEqual([])
  })

  // [A87 S-5] The four evasions the Auditor found: each must fail the STATIC layer by itself (layer 1 needs the path to run).
  it('the scanner fails a * in a ternary, a * in a variable, a spread, and a table name in a variable', () => {
    const inCallback = (select: string, pre = '') => `${pre}\nawait withOrderReadColumns((columns) => supabase.from('orders').${select}.eq('wallet', w))`
    expect(scan(inCallback("select(hashes ? '*' : columns)"))).toEqual([expect.stringContaining('not the columns parameter')])
    expect(scan(inCallback('select(cols)', "const cols = '*'"))).toEqual([expect.stringContaining('not the columns parameter')])
    expect(scan(inCallback("select(...['*'])"))).toEqual([expect.stringContaining('not the columns parameter')])
    expect(scan("const t = 'orders'\nsupabase.from(t).select('*')")).toEqual([expect.stringContaining("select('*') on orders")])
    expect(scan("let t = 'orders'\nsupabase.from(t).select('id')")).toEqual([expect.stringContaining('cannot be told')])
    expect(scan("supabase.from(tableFor(kind)).select('id')")).toEqual([expect.stringContaining('cannot be told')])
    expect(scan('supabase.from(`orders${x}`).select(\'id\')')).toEqual([expect.stringContaining('cannot be told')])
    // The table constant still resolves through an exported const, and its `*` is then caught like a literal's.
    expect(scan('supabase.from(SUPABASE_ORDERS_TABLE).select("*")', ORDERS_TABLE)).toEqual([expect.stringContaining("select('*') on orders")])
    // Concatenation is not the parameter either, nor is a different identifier, nor `columns` outside the callback.
    expect(scan(inCallback("select(columns + ',signature')"))).toHaveLength(1)
    expect(scan(inCallback('select(other)'))).toHaveLength(1)
    expect(scan("supabase.from('orders').select(columns)")).toHaveLength(1)
    // A callback that overwrites its parameter is not accepted.
    expect(scan("await withOrderReadColumns((columns) => { columns = '*'; return supabase.from('orders').select(columns) })")).toHaveLength(1)
    expect(scan("await withOrderReadColumns((columns) => { columns += ',signature'; return supabase.from('orders').select(columns) })")).toHaveLength(1)
  })

  it('the scanner passes the one shape the routes use: the columns parameter of withOrderReadColumns, and a const table', () => {
    const arrow = "await withOrderReadColumns((columns) => supabase.from('orders').select(columns).eq('id', id).single())"
    const block = "await withOrderReadColumns((columns) => {\n  let query = supabase\n    .from('orders')\n    .select(columns, { count: 'exact' })\n  return query\n})"
    const typed = "await withOrderReadColumns(async (cols: string) => supabase.from(SUPABASE_ORDERS_TABLE).select(cols))"
    expect(scan(arrow)).toEqual([])
    expect(scan(block)).toEqual([])
    expect(scan(typed, ORDERS_TABLE)).toEqual([])
    expect(scan("const T = 'circuit_breaker'\nsb.from(T).select('*')")).toEqual([])
  })

  it('src/ has no orders read chain selecting * or signature, and no such embed', () => {
    const root = path.resolve(process.cwd(), 'src')
    const files = sourceFiles(root).map((file) => ({ file, src: fs.readFileSync(file, 'utf8') }))
    const exported = exportedStringConstants(files)
    const problems: string[] = []
    let ordersChains = 0
    for (const { file, src } of files) {
      const rel = path.relative(process.cwd(), file)
      for (const chain of fromChains(rel, src)) {
        if (resolveTable(chain.tableArg, src, exported) === 'orders') ordersChains++
        problems.push(...chainProblems(chain, src, exported))
      }
      problems.push(...embedProblems(rel, src))
    }
    // Not vacuous: the four API routes, keeper-health-monitor and monitoring-loop read orders (>= 8 chains today).
    expect(ordersChains).toBeGreaterThanOrEqual(8)
    expect(problems).toEqual([])
  })
})
