/**
 * [ADR-029] A PostgREST-over-HTTP shim WITH WRITES, for the swap-log browser spec.
 *
 * The real Next server builds a supabase-js client from SUPABASE_URL and sends `/rest/v1/<table>` requests. This answers
 * them from the same in-memory database the vitest route tests use (src/test-utils/fake-swaps-db.ts): filters, `or=(…)`,
 * order, limit and offset, `Prefer: count=…` (HEAD and GET), inserts, updates with `return=representation`, and
 * `/rest/v1/rpc/<function>`. The real /api/log-swap and /api/history handlers therefore run unmodified.
 * A request it cannot map answers 501 and is listed in `unmapped`: a gap in the shim is a failing assertion.
 */
import { createServer, type Server } from 'node:http'
import { createFakeSwapsDb, type FakeSwapsDb, type Row } from '../../src/test-utils/fake-swaps-db'

export interface SwapLogDb {
  server: Server
  db: FakeSwapsDb
  /** `METHOD table` of every request served. */
  requests: string[]
  unmapped: string[]
  close: () => Promise<void>
}

type Builder = Record<string, (...args: unknown[]) => Builder> & PromiseLike<{ data: Row[] | null; error: { code: string; message: string } | null; count: number | null }>

const FILTER = /^(not\.)?(eq|neq|is|gt|gte|lt|lte|ilike|in)\.(.*)$/s

/** `(a,b)` -> `a,b`; anything else as it is. */
const unwrap = (text: string, open: string, close: string) => (text.length >= 2 && text.startsWith(open) && text.endsWith(close) ? text.slice(1, -1) : text)

function value(op: string, raw: string): unknown {
  if (op === 'is') return raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : raw
  if (op === 'in') return unwrap(raw, '(', ')').split(',').map((s) => unwrap(s.trim(), '"', '"')).filter((s) => s !== '')
  return raw
}

/** One filter on the builder. A fixed list of calls: the operator text of a request never names a method itself. */
function applyFilter(q: Builder, column: string, op: string, v: unknown): Builder {
  switch (op) {
    case 'eq': return q.eq(column, v)
    case 'neq': return q.neq(column, v)
    case 'is': return q.is(column, v)
    case 'gt': return q.gt(column, v)
    case 'gte': return q.gte(column, v)
    case 'lt': return q.lt(column, v)
    case 'lte': return q.lte(column, v)
    case 'ilike': return q.ilike(column, v)
    case 'in': return q.in(column, v)
    default: throw new Error('unsupported filter')
  }
}

/** Applies a PostgREST query string to the fake's builder. */
function applyQuery(start: Builder, params: URLSearchParams): Builder {
  let q = start
  for (const [key, raw] of params) {
    if (key === 'select' || key === 'columns') continue
    if (key === 'order') {
      const [column, direction] = raw.split('.')
      q = q.order(column, { ascending: direction !== 'desc' })
    } else if (key === 'limit') {
      q = q.limit(Number(raw))
    } else if (key === 'offset') {
      continue // handled with `limit` by the caller
    } else if (key === 'or') {
      q = q.or(unwrap(raw, '(', ')'))
    } else {
      const m = FILTER.exec(raw)
      if (!m) throw new Error('unsupported filter')
      const [, negated, op, rest] = m
      q = negated ? q.not(key, op, value(op, rest)) : applyFilter(q, key, op, value(op, rest))
    }
  }
  return q
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => done(raw))
  })
}

export async function startSwapLogDb(port: number, options: { swaps?: Row[]; migrated?: boolean } = {}): Promise<SwapLogDb> {
  const db = createFakeSwapsDb({ swaps: options.swaps ?? [], migrated: options.migrated })
  const requests: string[] = []
  const unmapped: string[] = []

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(body === undefined ? '' : JSON.stringify(body))
    if (url.pathname === '/') return void res.writeHead(200).end('swap-log postgrest-stub ok')

    const prefer = String(req.headers.prefer ?? '')
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)
    if (rpc) {
      requests.push(`RPC ${rpc[1]}`)
      const answer = (await db.service.rpc(rpc[1])) as { data: unknown; error: { code: string; message: string } | null }
      return answer.error ? send(404, answer.error) : send(200, answer.data)
    }

    const m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)
    if (!m) {
      unmapped.push(`${req.method} ${url.pathname}`)
      return send(501, { message: 'swap-log postgrest-stub: not mapped' })
    }
    const table = m[1]
    requests.push(`${req.method} ${table}`)

    try {
      const from = () => db.service.from(table) as unknown as Builder
      const select = url.searchParams.get('select') ?? '*'

      if (req.method === 'GET' || req.method === 'HEAD') {
        const head = req.method === 'HEAD'
        const count = /count=(exact|planned|estimated)/.exec(prefer)?.[1]
        let q = applyQuery((from().select as (c: string, o?: unknown) => Builder)(select, count ? { count, head } : undefined), url.searchParams)
        const offset = url.searchParams.get('offset')
        const limit = url.searchParams.get('limit')
        if (offset !== null && limit !== null) q = q.range(Number(offset), Number(offset) + Number(limit) - 1)
        const answer = await q
        if (answer.error) return send(400, answer.error)
        const headers = count ? { 'content-range': `${head ? '*' : `0-${Math.max((answer.data ?? []).length - 1, 0)}`}/${answer.count ?? 0}` } : {}
        return head ? void res.writeHead(200, headers).end() : send(200, answer.data ?? [], headers)
      }

      const raw = await readBody(req)
      const body = raw === '' ? {} : (JSON.parse(raw) as Row | Row[])
      const returning = prefer.includes('return=representation')

      if (req.method === 'POST') {
        const q = (from().insert as (v: unknown) => Builder)(body)
        const answer = await (returning ? (q.select as (c: string) => Builder)(select) : q)
        if (answer.error) return send(answer.error.code === '23505' ? 409 : 400, answer.error)
        return returning ? send(201, answer.data ?? []) : void res.writeHead(201).end()
      }
      if (req.method === 'PATCH') {
        let q = applyQuery((from().update as (v: unknown) => Builder)(body), url.searchParams)
        if (returning) q = (q.select as (c: string) => Builder)(select)
        const answer = await q
        if (answer.error) return send(answer.error.code === '23505' ? 409 : 400, answer.error)
        return returning ? send(200, answer.data ?? []) : void res.writeHead(204).end()
      }
      unmapped.push(`${req.method} ${table}`)
      return send(501, { message: 'swap-log postgrest-stub: method not mapped' })
    } catch {
      unmapped.push(`${req.method} ${table}: query not mapped`)
      return send(501, { message: 'swap-log postgrest-stub: could not map the query' })
    }
  })

  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done))
  return { server, db, requests, unmapped, close: () => new Promise<void>((done) => server.close(() => done())) }
}
