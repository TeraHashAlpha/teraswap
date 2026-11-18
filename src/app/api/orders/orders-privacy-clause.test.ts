/**
 * [A87 S-1] The privacy sentence (PRIVACY_PUBLIC_ANALYTICS_NOTE, src/config/product-claims.ts) says:
 *   "open orders and the DCA fills in a wallet's history need a signature from that wallet;
 *    the fills of a finished order can be read with its record"
 * Each half is proved against the REAL route handlers on a fake PostgREST that honours `select`:
 *   1. /api/history withholds the DCA fills when the request carries no read signature (and returns them with one,
 *      so the withholding is not vacuous);
 *   2. /api/orders/[id]/executions returns the fills of a FINISHED order with no read signature;
 *   3. what the same route does for a LIVE order TODAY is pinned, not endorsed: it returns the fills with no read
 *      signature (the route asks for the wallet parameter only). This test fails if that changes, so a change of who
 *      may read what is a decision someone makes, never an accident.
 * Fill transaction hashes are compared in the responses; no order signature is read or printed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  buildOrdersReadTypedData,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
} from '@/lib/order-engine/read-auth'
import type { Row } from '@/test-utils/fake-postgrest'
import { DB_ORDER_STATUSES, makeExecutionRow, makeOrderRow, makeOrdersDb, prng } from '@/test-utils/orders-db-fixture'

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

import { GET as EXECUTIONS } from './[id]/executions/route'
import { GET as HISTORY } from '../history/route'

// Published Anvil/Hardhat default account #0 key, value-allowlisted in .gitleaks.toml (NOT a secret).
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const WALLET = account.address.toLowerCase()
const OTHER = '0x' + '5e'.repeat(20)
const FINISHED = ['executed', 'cancelled', 'expired', 'failed'] as const
const LIVE = ['active', 'executing'] as const

let mine: Row[] = []
let fillHashByOrder = new Map<string, string>()

function seed() {
  const rand = prng(20261118)
  mine = DB_ORDER_STATUSES.map((status) => makeOrderRow(rand, { wallet: WALLET, status, order_type: 'dca' }))
  const theirs = [makeOrderRow(rand, { wallet: OTHER, status: 'executed', order_type: 'dca' })]
  const fills = [...mine, ...theirs].map((o) => makeExecutionRow(rand, o, 1))
  fillHashByOrder = new Map(fills.map((f) => [String(f.order_id), String(f.tx_hash)]))
  db = makeOrdersDb({ orders: [...mine, ...theirs], order_executions: fills, swaps: [] })
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
const orderOf = (status: string) => mine.find((o) => o.status === status)!

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
  seed()
})

describe('privacy clause, first half: the DCA fills in a wallet\'s history need a signature', () => {
  it('GET /api/history without a read signature: no fill of any order, fillsIncluded false', async () => {
    const res = await HISTORY(req(`/api/history?wallet=${WALLET}`))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.fillsIncluded).toBe(false)
    const text = JSON.stringify(body)
    for (const o of mine) expect(text).not.toContain(fillHashByOrder.get(String(o.id))!)
    expect(body.swaps.some((s: Row) => s.kind === 'dca_fill')).toBe(false)
  })

  it('GET /api/history with a wrong-signer read signature: still no fill', async () => {
    const issuedAt = Math.floor(Date.now() / 1000)
    const stranger = privateKeyToAccount(generatePrivateKey())
    const res = await HISTORY(
      req(`/api/history?wallet=${WALLET}`, {
        [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
        [ORDERS_READ_HEADER_SIGNATURE]: await stranger.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt)),
      }),
    )
    const body = await res.json()
    expect(body.fillsIncluded).toBe(false)
    expect(body.swaps.some((s: Row) => s.kind === 'dca_fill')).toBe(false)
  })

  it('GET /api/history WITH the wallet\'s read signature: the fills are there (the withholding above is not vacuous)', async () => {
    const res = await HISTORY(req(`/api/history?wallet=${WALLET}`, await readAuth()))
    const body = await res.json()
    expect(body.fillsIncluded).toBe(true)
    const text = JSON.stringify(body)
    expect(text).toContain(fillHashByOrder.get(String(orderOf('executed').id))!)
    expect(body.swaps.some((s: Row) => s.kind === 'dca_fill')).toBe(true)
  })
})

describe('privacy clause, second half: the fills of a finished order can be read with its record', () => {
  it.each(FINISHED)('GET /api/orders/[id]/executions of a %s order, no read signature: 200 and its fill', async (status) => {
    const order = orderOf(status)
    const res = await EXECUTIONS(req(`/api/orders/${order.id}/executions?wallet=${WALLET}`), idParams(order.id))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.order).not.toBeNull()
    expect(body.executions).toHaveLength(1)
    expect(body.executions[0].tx_hash).toBe(fillHashByOrder.get(String(order.id)))
  })
})

describe('LIVE orders, pinned as the route behaves today (A87 S-1: reported, not changed)', () => {
  it.each(LIVE)('GET /api/orders/[id]/executions of a %s order, no read signature: RETURNED (200 with its fill)', async (status) => {
    const order = orderOf(status)
    const res = await EXECUTIONS(req(`/api/orders/${order.id}/executions?wallet=${WALLET}`), idParams(order.id))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.executions).toHaveLength(1)
    expect(body.executions[0].tx_hash).toBe(fillHashByOrder.get(String(order.id)))
  })

  it('the only gate is the wallet parameter: another wallet gets 403 and no fill, a missing wallet gets 400', async () => {
    const order = orderOf('executed')
    const other = await EXECUTIONS(req(`/api/orders/${order.id}/executions?wallet=${OTHER}`), idParams(order.id))
    expect(other.status).toBe(403)
    expect(JSON.stringify(await other.json())).not.toContain(fillHashByOrder.get(String(order.id))!)
    const none = await EXECUTIONS(req(`/api/orders/${order.id}/executions`), idParams(order.id))
    expect(none.status).toBe(400)
  })
})
