// @vitest-environment node
/**
 * [A97 S-3] GET /api/orders/stats?wallet=W: `recentExecutions24h` counts W's fills of the last 24 h, LIVE orders included (their
 * progress), so it is returned only with W's own valid read signature. Without it (none, another wallet's, expired, malformed)
 * the field is absent and order_executions is never read. The counts by status (total, active, executed, cancelled, expired,
 * failed) are the same in every case. With no wallet the all-wallets count is unchanged.
 * Real route, fake PostgREST that honours count/head/eq/gte and records every select; real signatures (viem local accounts).
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

import { GET } from './route'

// Anvil #0 (value-allowlisted in .gitleaks.toml, NOT a secret); the stranger is generated per run.
const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const stranger = privateKeyToAccount(generatePrivateKey())
const WALLET = owner.address.toLowerCase()

async function headersFor(signer: typeof owner, forWallet: string, issuedAt = Math.floor(Date.now() / 1000)) {
  return {
    [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: await signer.signTypedData(buildOrdersReadTypedData(forWallet, issuedAt)),
  }
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
  const rand = prng(20261119)
  const now = Date.now()
  const orders: Row[] = [
    ...DB_ORDER_STATUSES.map((status) => makeOrderRow(rand, { wallet: WALLET, status, order_type: 'dca' })),
    makeOrderRow(rand, { wallet: stranger.address.toLowerCase(), status: 'active', order_type: 'dca' }),
  ]
  // Two recent fills on each of the owner's orders (live ones included), one on the stranger's, one old fill.
  const fills = orders.flatMap((o, i) => [1, 2].map((n) => ({ ...makeExecutionRow(rand, o, n), created_at: new Date(now - (i + n) * 600_000).toISOString() })))
  fills.push({ ...makeExecutionRow(rand, orders[0], 3), created_at: new Date(now - 3 * 86_400_000).toISOString() })
  db = makeOrdersDb({ orders, order_executions: fills, swaps: [] })
})

const get = (query: string, headers: Record<string, string> = {}) => GET(new NextRequest(`http://localhost/api/orders/stats${query}`, { headers }))
const COUNTS = { total: 6, active: 1, executed: 1, cancelled: 1, expired: 1, failed: 1 }

describe('GET /api/orders/stats: the wallet\'s 24 h fill count needs its read signature (A97 S-3)', () => {
  it('with the wallet\'s own valid read signature: the counts by status AND recentExecutions24h (its 12 recent fills)', async () => {
    const res = await get(`?wallet=${WALLET}`, await headersFor(owner, WALLET))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...COUNTS, recentExecutions24h: 12 })
  })

  it.each([
    ['no signature', async () => ({})],
    ['a stranger\'s signature over the wallet\'s message', async () => headersFor(stranger, WALLET)],
    ['the stranger\'s own signature', async () => headersFor(stranger, stranger.address.toLowerCase())],
    ['an expired signature', async () => headersFor(owner, WALLET, Math.floor(Date.now() / 1000) - 25 * 3600)],
    ['a malformed signature', async () => ({ [ORDERS_READ_HEADER_ISSUED]: String(Math.floor(Date.now() / 1000)), [ORDERS_READ_HEADER_SIGNATURE]: '0x1234' })],
  ])('%s: the same counts by status, no recentExecutions24h, and the fills table is never read', async (_label, headers) => {
    const res = await get(`?wallet=${WALLET}`, await headers())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(COUNTS)
    expect('recentExecutions24h' in body).toBe(false)
    expect(db.selects.filter((s) => s.table === 'order_executions')).toEqual([])
  })

  it('no wallet: every wallet\'s fills of the last 24 h, as before (no signature asked)', async () => {
    const res = await get('')
    const body = await res.json()
    expect(body.recentExecutions24h).toBe(14)
    expect(body.total).toBe(7)
  })

  it('no wallet, whatever read headers come along (none, valid, malformed): the same all-wallets answer', async () => {
    const answers = []
    const headerSets: Array<Record<string, string>> = [
      {},
      await headersFor(owner, WALLET),
      { [ORDERS_READ_HEADER_ISSUED]: 'x', [ORDERS_READ_HEADER_SIGNATURE]: '0x12' },
    ]
    for (const headers of headerSets) {
      const res = await get('', headers)
      expect(res.status).toBe(200)
      answers.push(await res.json())
    }
    expect(answers.map((a) => a.recentExecutions24h)).toEqual([14, 14, 14])
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
  })
})
