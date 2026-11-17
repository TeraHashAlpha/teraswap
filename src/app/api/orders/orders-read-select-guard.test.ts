/**
 * [fix/order-signature-not-returned] Guard: a read of `orders` selects an explicit column list, never `*`, never
 * `signature`. Two layers:
 *   1. Dynamic: every UNAUTHENTICATED read path is driven through the fake PostgREST client and every `orders` select
 *      it sends (top level, or an `orders(...)` embed from another table) is checked.
 *   2. Static: every `.from('orders')` chain in src/ (tests excluded) that does not write (insert / update / upsert /
 *      delete) must not select `*`, must not call `.select()` empty (= `*`), and must not name `signature`; an
 *      `orders(...)` / `orders!inner(...)` embed anywhere in src/ must not either. A select whose argument is not a
 *      string literal is allowed only in a file that imports the allow-list module (layer 1 checks its value).
 * Each layer's checker is first shown to FAIL on a `*` select, so the guard cannot pass vacuously.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
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

const WALLET = '0x' + '3c'.repeat(20)
let seeded: Row[] = []

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

describe('guard, layer 1: the unauthenticated read paths select an explicit orders column list', () => {
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

  it('every orders select of every unauthenticated read path is explicit', async () => {
    const terminal = 'executed,cancelled,expired,failed'
    const byId = (id: unknown) => ({ params: Promise.resolve({ id: String(id) }) })
    await LIST(new NextRequest(`http://localhost/api/orders?wallet=${WALLET}&status=${terminal}`))
    await LIST(new NextRequest(`http://localhost/api/orders?wallet=${WALLET}&status=cancelled&hashes=0x${'11'.repeat(32)}`))
    for (const order of seeded) {
      await BY_ID(new NextRequest(`http://localhost/api/orders/${order.id}?wallet=${WALLET}`), byId(order.id))
      await EXECUTIONS(new NextRequest(`http://localhost/api/orders/${order.id}/executions?wallet=${WALLET}`), byId(order.id))
    }
    await STATS(new NextRequest(`http://localhost/api/orders/stats?wallet=${WALLET}`))
    await STATS(new NextRequest('http://localhost/api/orders/stats'))
    await HISTORY(new NextRequest(`http://localhost/api/history?wallet=${WALLET}`))
    await ANALYTICS()

    const touchingOrders = db.selects.filter((s) => s.table === 'orders' || /\borders\s*(!\w+)?\s*\(/.test(s.columns))
    // Not vacuous: list, by-id x6, executions x6, stats x12 and the analytics embed all reached `orders`.
    expect(touchingOrders.length).toBeGreaterThanOrEqual(20)
    expect(touchingOrders.flatMap(ordersSelectProblems)).toEqual([])
  })
})

// ── Layer 2: every orders read chain in the source ──────────────────────────────────────────────────────────────────
interface Call { name: string; args: string }
interface Chain { file: string; line: number; calls: Call[] }

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

function ordersChains(file: string, src: string): Chain[] {
  const out: Chain[] = []
  const re = /\.from\(\s*(?:(['"`])orders\1|SUPABASE_ORDERS_TABLE)\s*\)/g
  for (const m of src.matchAll(re)) {
    let i = (m.index ?? 0) + m[0].length
    const calls: Call[] = []
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
    out.push({ file, line: src.slice(0, m.index).split('\n').length, calls })
  }
  return out
}

/** The text of a select's FIRST argument when it is a string literal or literals joined by `+`; null otherwise. */
function literalArg(args: string): string | null {
  let depth = 0
  let first = ''
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i
      for (i++; i < args.length && args[i] !== ch; i++) if (args[i] === '\\') i++
      first += args.slice(start, i + 1)
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) break
    first += ch
  }
  const parts = first.split('+').map((p) => p.trim())
  if (parts.length === 1 && parts[0] === '') return ''
  if (!parts.every((p) => /^(['"`])[^]*\1$/.test(p) && !p.includes('${'))) return null
  return parts.map((p) => p.slice(1, -1)).join('')
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const ALLOW_LIST_IMPORT = /from\s+['"](?:@\/app\/api\/orders\/|\.\.?\/(?:\.\.\/)*(?:orders\/)?)order-read-columns['"]/

function chainProblems(chain: Chain, fileSrc: string): string[] {
  if (chain.calls.some((c) => WRITES.has(c.name))) return []
  const where = `${chain.file}:${chain.line}`
  const problems: string[] = []
  for (const c of chain.calls.filter((x) => x.name === 'select')) {
    const lit = literalArg(c.args)
    if (lit === null) {
      if (!ALLOW_LIST_IMPORT.test(fileSrc)) problems.push(`${where}: select(${c.args.trim()}) is not a literal and the file does not import order-read-columns`)
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

describe('guard, layer 2: no orders read chain in src/ selects * or signature', () => {
  it('the scanner itself fails * / empty / signature selects and orders(*) embeds, and passes writes', () => {
    const bad = [
      "supabase.from('orders').select('*').eq('wallet', w)",
      'sb\n  .from("orders")\n  // comment\n  .select()\n  .limit(1)',
      "supabase.from('orders').select('id, ' +\n 'signature').single()",
      'supabase.from(SUPABASE_ORDERS_TABLE).select(cols)',
    ]
    for (const src of bad) {
      const chains = ordersChains('x.ts', src)
      expect(chains).toHaveLength(1)
      expect(chainProblems(chains[0], src).length).toBeGreaterThan(0)
    }
    expect(embedProblems('x.ts', ".from('order_executions').select('id, orders!inner(*)')")).toHaveLength(1)
    expect(embedProblems('x.ts', ".select('id,' +\n 'orders(wallet,signature)')")).toHaveLength(1)
    const write = "supabase.from('orders').insert({ a: 1 }).select().single()"
    expect(chainProblems(ordersChains('x.ts', write)[0], write)).toEqual([])
    const ok = "supabase.from('orders').select('id, status', { count: 'exact', head: true }).eq('a', 1)"
    expect(chainProblems(ordersChains('x.ts', ok)[0], ok)).toEqual([])
  })

  it('src/ has no orders read chain selecting * or signature, and no such embed', () => {
    const root = path.resolve(process.cwd(), 'src')
    const problems: string[] = []
    let chains = 0
    for (const file of sourceFiles(root)) {
      const src = fs.readFileSync(file, 'utf8')
      const rel = path.relative(process.cwd(), file)
      for (const chain of ordersChains(rel, src)) {
        chains++
        problems.push(...chainProblems(chain, src))
      }
      problems.push(...embedProblems(rel, src))
    }
    // Not vacuous: the four API routes, keeper-health-monitor and monitoring-loop read orders (>= 8 chains today).
    expect(chains).toBeGreaterThanOrEqual(8)
    expect(problems).toEqual([])
  })
})
