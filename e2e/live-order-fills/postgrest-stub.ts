/**
 * [fix/live-order-fills-need-signature] A PostgREST-over-HTTP shim for the Orders-tab e2e.
 *
 * The real Next server's routes build a supabase-js client from SUPABASE_URL and send `GET /rest/v1/<table>?...` requests.
 * This answers them from the SAME in-memory fake database the vitest route tests use (src/test-utils/fake-postgrest.ts, which
 * honours `select`, `eq`, `in`, `order`, `limit`, `single` the way PostgREST does), so the routes under test run unmodified.
 * Only reads are served (the Orders tab reads). A request it cannot map answers 501 and is listed in `unmapped`, so a gap in
 * the shim is a failing assertion, never a silent empty answer.
 */
import { createServer, type Server } from 'node:http'
import { createFakePostgrest, type Row } from '../../src/test-utils/fake-postgrest'
import { EXECUTIONS_SCHEMA, ORDERS_SCHEMA, SWAPS_SCHEMA } from '../../src/test-utils/orders-db-fixture'

export interface StubDb {
  server: Server
  /** Every request the shim served: `table?query` (no values of any signature column are ever logged). */
  requests: string[]
  unmapped: string[]
  close: () => Promise<void>
}

/** `in.(a,b,"c d")` → ['a','b','c d'] */
function parseInList(raw: string): string[] {
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '')
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter((s) => s.length > 0)
}

export async function startPostgrestStub(port: number, tables: { orders: Row[]; order_executions: Row[]; swaps?: Row[] }): Promise<StubDb> {
  const { client } = createFakePostgrest({
    tables: { orders: tables.orders, order_executions: tables.order_executions, swaps: tables.swaps ?? [] },
    schema: { orders: ORDERS_SCHEMA, order_executions: EXECUTIONS_SCHEMA, swaps: SWAPS_SCHEMA },
    relations: { 'order_executions.orders': { table: 'orders', localKey: 'order_id', foreignKey: 'id' } },
  })
  const requests: string[] = []
  const unmapped: string[] = []

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === '/') return void res.writeHead(200).end('postgrest-stub ok') // the readiness probe
    const m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)
    if (!m || req.method !== 'GET') {
      unmapped.push(`${req.method} ${url.pathname}`)
      return send(501, { message: 'postgrest-stub: not mapped' })
    }
    requests.push(`${m[1]}?${[...url.searchParams.keys()].join('&')}`)
    try {
      // The fake exposes the supabase-js builder; apply the query string to it the way PostgREST reads it.
      let q = client.from(m[1]).select(url.searchParams.get('select') ?? '*') as unknown as Record<string, (...a: unknown[]) => unknown> & PromiseLike<{ data: Row[] | null; error: { code?: string; message: string } | null }>
      for (const [key, value] of url.searchParams) {
        if (key === 'select') continue
        if (key === 'order') {
          const [col, dir] = value.split('.')
          q = q.order(col, { ascending: dir !== 'desc' }) as typeof q
        } else if (key === 'limit') {
          q = q.limit(Number(value)) as typeof q
        } else if (value.startsWith('eq.')) {
          q = q.eq(key, value.slice(3)) as typeof q
        } else if (value.startsWith('in.')) {
          q = q.in(key, parseInList(value.slice(3))) as typeof q
        } else {
          unmapped.push(`${m[1]}: filter ${key}=${value.split('.')[0]}`)
          return send(501, { message: `postgrest-stub: filter ${key} not mapped` })
        }
      }
      const wantsObject = (req.headers.accept ?? '').includes('application/vnd.pgrst.object+json')
      const result = wantsObject ? await (q.single as unknown as () => Promise<{ data: Row | null; error: { code?: string; message: string } | null }>)() : await q
      if (result.error) return send(wantsObject ? 406 : 400, result.error)
      return send(200, result.data)
    } catch (err) {
      unmapped.push(`${m[1]}: ${String(err).slice(0, 120)}`)
      return send(500, { message: 'postgrest-stub: failed' })
    }
  })
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done))
  return { server, requests, unmapped, close: () => new Promise<void>((done) => server.close(() => done())) }
}
