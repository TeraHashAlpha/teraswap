/**
 * [fix/order-signature-not-returned] S-13 of the PR #689 audit (owner decision 2026-11-17): no READ response carries
 * an order's EIP-712 `signature`, with or without the wallet's read signature (the browser never uses it:
 * useOrderEngine.ts rowToOrder is its only reader and nothing reads the copy). Terminal orders, history and totals stay
 * readable without a read signature, exactly as before.
 *
 * End to end on the local test setup: the REAL route handlers, real viem read signatures (Anvil account #0), and a fake
 * PostgREST client that honours `select` the way PostgREST does (`*` returns every column, `signature` included), so a
 * route that asks for `signature` (or `*`) leaks it here as it would in production. Assertions report the PATH of a
 * leak, never the value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { privateKeyToAccount } from 'viem/accounts'
import {
  buildOrdersReadTypedData,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
} from '@/lib/order-engine/read-auth'
import { findSignatureLeaks, type Row } from '@/test-utils/fake-postgrest'
import {
  DB_ORDER_STATUSES,
  makeExecutionRow,
  makeOrderRow,
  makeOrdersDb,
  makeSwapRow,
  prng,
} from '@/test-utils/orders-db-fixture'

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
const OTHER = '0x' + '5e'.repeat(20)

/** The owner's allow-list (2026-11-17): the browser's OrderRow columns (src/lib/order-engine/supabase.ts) minus `signature`. */
const ORDER_COLUMNS = [
  'id', 'wallet', 'order_hash', 'order_type', 'status', 'chain_id', 'token_in', 'token_out', 'token_in_symbol',
  'token_out_symbol', 'token_in_decimals', 'token_out_decimals', 'floor_tier', 'floor_ack_at', 'amount_in',
  'min_amount_out', 'target_price', 'price_feed', 'expiry', 'nonce', 'router', 'dca_interval', 'dca_total',
  'dca_executed', 'order_data', 'tx_hash', 'amount_out', 'error', 'created_at', 'executed_at',
].sort()
/** The same list when migration 20261011120000 (floor_tier, floor_ack_at) is not applied. */
const ORDER_COLUMNS_NO_FLOOR = ORDER_COLUMNS.filter((c) => c !== 'floor_tier' && c !== 'floor_ack_at')
const TERMINAL = ['executed', 'cancelled', 'expired', 'failed'] as const
const LIVE = ['active', 'executing'] as const

let mine: Row[] = []
let stored: string[] = []

function seed(missingOrderColumns: readonly string[] = []) {
  const rand = prng(20261117)
  mine = DB_ORDER_STATUSES.map((status) => makeOrderRow(rand, { wallet: WALLET, status, order_type: 'dca' }))
  const theirs = [makeOrderRow(rand, { wallet: OTHER, status: 'cancelled' }), makeOrderRow(rand, { wallet: OTHER, status: 'active' })]
  const orders = [...mine, ...theirs]
  const fills = mine.filter((o) => o.status === 'executed' || o.status === 'active').map((o) => makeExecutionRow(rand, o, 1))
  db = makeOrdersDb({ orders, order_executions: fills, swaps: [makeSwapRow(rand, WALLET), makeSwapRow(rand, OTHER)] }, missingOrderColumns)
  stored = orders.map((o) => String(o.signature))
}

async function readAuth(): Promise<Record<string, string>> {
  const issuedAt = Math.floor(Date.now() / 1000)
  return {
    [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: await account.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt)),
  }
}

const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { headers })
const idParams = (id: unknown) => ({ params: Promise.resolve({ id: String(id) }) })
const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort()

async function bodyOf(res: Response) {
  const body = await res.json()
  return { status: res.status, body, leaks: findSignatureLeaks(body, stored) }
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
  seed()
})

describe('GET /api/orders: no signature in any response', () => {
  it.each(TERMINAL)('status=%s without a read signature: the row, allow-listed columns, no signature', async (status) => {
    const r = await bodyOf(await LIST(req(`/api/orders?wallet=${WALLET}&status=${status}`)))
    expect(r.status).toBe(200)
    expect(r.body.orders).toHaveLength(1)
    expect(r.body.orders[0].status).toBe(status)
    expect(keysOf(r.body.orders[0])).toEqual(ORDER_COLUMNS)
    expect(r.leaks).toEqual([])
  })

  it('every terminal status at once, without a read signature', async () => {
    const r = await bodyOf(await LIST(req(`/api/orders?wallet=${WALLET}&status=${TERMINAL.join(',')}`)))
    expect(r.status).toBe(200)
    expect(r.body.orders.map((o: Row) => o.status).sort()).toEqual([...TERMINAL].sort())
    expect(r.leaks).toEqual([])
  })

  it('by hash with a terminal status filter (the one public by-hash shape), without a read signature', async () => {
    const hashes = mine.map((o) => o.order_hash).join(',')
    const r = await bodyOf(await LIST(req(`/api/orders?wallet=${WALLET}&status=${TERMINAL.join(',')}&hashes=${hashes}`)))
    expect(r.status).toBe(200)
    expect(r.body.orders).toHaveLength(TERMINAL.length)
    expect(r.leaks).toEqual([])
  })

  it.each([...LIVE, 'partially_filled', ''])('status=%s without a read signature: 401, and the 401 carries no signature', async (status) => {
    const r = await bodyOf(await LIST(req(`/api/orders?wallet=${WALLET}${status ? `&status=${status}` : ''}`)))
    expect(r.status).toBe(401)
    expect(r.leaks).toEqual([])
  })

  it.each(DB_ORDER_STATUSES)('status=%s WITH a valid read signature: the row, allow-listed columns, no signature', async (status) => {
    const r = await bodyOf(await LIST(req(`/api/orders?wallet=${WALLET}&status=${status}`, await readAuth())))
    expect(r.status).toBe(200)
    expect(r.body.orders).toHaveLength(1)
    expect(keysOf(r.body.orders[0])).toEqual(ORDER_COLUMNS)
    expect(r.leaks).toEqual([])
  })

  it('no status filter and the by-hash poll, WITH a valid read signature: every own order, no signature', async () => {
    const all = await bodyOf(await LIST(req(`/api/orders?wallet=${WALLET}`, await readAuth())))
    expect(all.status).toBe(200)
    expect(all.body.orders).toHaveLength(DB_ORDER_STATUSES.length)
    expect(all.leaks).toEqual([])
    const hashes = mine.map((o) => o.order_hash).join(',')
    const poll = await bodyOf(await LIST(req(`/api/orders?wallet=${WALLET}&hashes=${hashes}`, await readAuth())))
    expect(poll.status).toBe(200)
    expect(poll.body.orders).toHaveLength(DB_ORDER_STATUSES.length)
    expect(poll.leaks).toEqual([])
  })

  it('a database without the floor-tier columns (migration not applied): still every row, no signature', async () => {
    seed(['floor_tier', 'floor_ack_at'])
    const r = await bodyOf(await LIST(req(`/api/orders?wallet=${WALLET}`, await readAuth())))
    expect(r.status).toBe(200)
    expect(r.body.error).toBeUndefined()
    expect(r.body.orders).toHaveLength(DB_ORDER_STATUSES.length)
    expect(keysOf(r.body.orders[0])).toEqual(ORDER_COLUMNS_NO_FLOOR)
    expect(r.leaks).toEqual([])
    const pub = await bodyOf(await LIST(req(`/api/orders?wallet=${WALLET}&status=cancelled`)))
    expect(pub.body.orders).toHaveLength(1)
    expect(pub.leaks).toEqual([])
  })
})

describe('GET /api/orders/[id]: no signature in any response', () => {
  it.each(TERMINAL)('a %s order without a read signature: the row, allow-listed columns, no signature', async (status) => {
    const order = mine.find((o) => o.status === status)!
    const r = await bodyOf(await BY_ID(req(`/api/orders/${order.id}?wallet=${WALLET}`), idParams(order.id)))
    expect(r.status).toBe(200)
    expect(r.body.order.id).toBe(order.id)
    expect(keysOf(r.body.order)).toEqual(ORDER_COLUMNS)
    expect(r.leaks).toEqual([])
  })

  it.each(LIVE)('a %s order without a read signature: 401, no signature', async (status) => {
    const order = mine.find((o) => o.status === status)!
    const r = await bodyOf(await BY_ID(req(`/api/orders/${order.id}?wallet=${WALLET}`), idParams(order.id)))
    expect(r.status).toBe(401)
    expect(r.leaks).toEqual([])
  })

  it.each(DB_ORDER_STATUSES)('a %s order WITH a valid read signature: the row, no signature', async (status) => {
    const order = mine.find((o) => o.status === status)!
    const r = await bodyOf(await BY_ID(req(`/api/orders/${order.id}?wallet=${WALLET}`, await readAuth()), idParams(order.id)))
    expect(r.status).toBe(200)
    expect(keysOf(r.body.order)).toEqual(ORDER_COLUMNS)
    expect(r.leaks).toEqual([])
  })

  it("another wallet's order: 404, no signature", async () => {
    seed()
    const r = await bodyOf(await BY_ID(req(`/api/orders/x?wallet=${OTHER}`), idParams(mine[3].id)))
    expect(r.status).toBe(404)
    expect(r.leaks).toEqual([])
  })

  it('a database without the floor-tier columns: the row, no signature', async () => {
    seed(['floor_tier', 'floor_ack_at'])
    const order = mine.find((o) => o.status === 'active')!
    const r = await bodyOf(await BY_ID(req(`/api/orders/${order.id}?wallet=${WALLET}`, await readAuth()), idParams(order.id)))
    expect(r.status).toBe(200)
    expect(keysOf(r.body.order)).toEqual(ORDER_COLUMNS_NO_FLOOR)
    expect(r.leaks).toEqual([])
  })
})

describe('the other read routes: totals, fills, history and analytics stay readable, never a signature', () => {
  it('GET /api/orders/stats (per wallet and global): counts by status, no signature', async () => {
    const r = await bodyOf(await STATS(req(`/api/orders/stats?wallet=${WALLET}`)))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ total: 6, active: 1, executed: 1, cancelled: 1, expired: 1, failed: 1 })
    expect(r.leaks).toEqual([])
    const all = await bodyOf(await STATS(req('/api/orders/stats')))
    expect(all.body.total).toBe(8)
    expect(all.leaks).toEqual([])
  })

  it.each(TERMINAL)('GET /api/orders/[id]/executions for a %s order, no read signature: 200, never an order signature', async (status) => {
    const order = mine.find((o) => o.status === status)!
    const r = await bodyOf(await EXECUTIONS(req(`/api/orders/${order.id}/executions?wallet=${WALLET}`), idParams(order.id)))
    expect(r.status).toBe(200)
    expect(r.body.order).not.toBeNull()
    expect(r.leaks).toEqual([])
  })

  // [A87b R2-1] CHANGED EXPECTATION: a LIVE order's fills were 200 with no read signature; now 401 without it, 200 with it.
  it.each(LIVE)('GET /api/orders/[id]/executions for a %s order: 401 without the read signature, 200 with it, never an order signature', async (status) => {
    const order = mine.find((o) => o.status === status)!
    const bare = await bodyOf(await EXECUTIONS(req(`/api/orders/${order.id}/executions?wallet=${WALLET}`), idParams(order.id)))
    expect(bare.status).toBe(401)
    expect(bare.leaks).toEqual([])
    const own = await bodyOf(await EXECUTIONS(req(`/api/orders/${order.id}/executions?wallet=${WALLET}`, await readAuth()), idParams(order.id)))
    expect(own.status).toBe(200)
    expect(own.body.order).not.toBeNull()
    expect(own.leaks).toEqual([])
  })

  it('GET /api/history without and with a read signature: swaps, then swaps + fills, no signature', async () => {
    const pub = await bodyOf(await HISTORY(req(`/api/history?wallet=${WALLET}`)))
    expect(pub.status).toBe(200)
    expect(pub.body.fillsIncluded).toBe(false)
    expect(pub.body.swaps.length).toBeGreaterThan(0)
    expect(pub.leaks).toEqual([])
    const own = await bodyOf(await HISTORY(req(`/api/history?wallet=${WALLET}`, await readAuth())))
    expect(own.body.fillsIncluded).toBe(true)
    expect(own.body.swaps.some((s: Row) => s.kind === 'dca_fill')).toBe(true)
    expect(own.leaks).toEqual([])
  })

  it('GET /api/analytics: the public feed, no signature', async () => {
    const r = await bodyOf(await ANALYTICS())
    expect(r.status).toBe(200)
    expect(r.body.enabled).toBe(true)
    expect(r.leaks).toEqual([])
  })
})
