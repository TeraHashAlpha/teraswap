// @vitest-environment node
/**
 * [A97 S-7] GET /api/orders, GET /api/orders/:id and GET /api/orders/:id/executions answer one wallet, and a live order only
 * with that wallet's read signature (headers): every answer they give, 200 and 4xx alike, says
 * `Cache-Control: private, no-store`, so neither a browser nor a shared cache keeps or reuses one. Real handlers, fake PostgREST.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { privateKeyToAccount } from 'viem/accounts'
import {
  buildOrdersReadTypedData,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
} from '@/lib/order-engine/read-auth'
import type { Row } from '@/test-utils/fake-postgrest'
import { makeExecutionRow, makeOrderRow, makeOrdersDb, prng } from '@/test-utils/orders-db-fixture'

let db = makeOrdersDb({ orders: [] })
vi.mock('@supabase/supabase-js', () => ({ createClient: () => db.client }))
vi.mock('@/lib/kv-rate-limiter', async () => ({
  ...(await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')),
  checkRateLimit: async () => ({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 }),
}))

import { GET as LIST } from './route'
import { GET as BY_ID } from './[id]/route'
import { GET as EXECUTIONS } from './[id]/executions/route'

// Anvil #0 (value-allowlisted in .gitleaks.toml, NOT a secret).
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const WALLET = account.address.toLowerCase()
const OTHER = '0x' + '5e'.repeat(20)
let live: Row
let finished: Row

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
  const rand = prng(20261119)
  live = makeOrderRow(rand, { wallet: WALLET, status: 'active', order_type: 'dca' })
  finished = makeOrderRow(rand, { wallet: WALLET, status: 'executed', order_type: 'dca' })
  db = makeOrdersDb({ orders: [live, finished], order_executions: [makeExecutionRow(rand, live, 1), makeExecutionRow(rand, finished, 1)], swaps: [] })
})

async function signed(): Promise<Record<string, string>> {
  const issuedAt = Math.floor(Date.now() / 1000)
  return {
    [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: await account.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt)),
  }
}
const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { headers })
const idParams = (id: unknown) => ({ params: Promise.resolve({ id: String(id) }) })

describe('every answer of the three orders reads is private, no-store (A97 S-7)', () => {
  it('GET /api/orders: 400, 401, 200 (signed), 200 (finished statuses only)', async () => {
    const answers = [
      await LIST(req('/api/orders')),
      await LIST(req(`/api/orders?wallet=${WALLET}`)),
      await LIST(req(`/api/orders?wallet=${WALLET}`, await signed())),
      await LIST(req(`/api/orders?wallet=${WALLET}&status=executed,cancelled`)),
    ]
    expect(answers.map((r) => r.status)).toEqual([400, 401, 200, 200])
    for (const r of answers) expect(r.headers.get('cache-control')).toBe('private, no-store')
  })

  it('GET /api/orders/:id: 400, 404, 401 (live, unsigned), 200 (live, signed), 200 (finished)', async () => {
    const answers = [
      await BY_ID(req(`/api/orders/${live.id}`), idParams(live.id)),
      await BY_ID(req(`/api/orders/no-such?wallet=${WALLET}`), idParams('no-such')),
      await BY_ID(req(`/api/orders/${live.id}?wallet=${WALLET}`), idParams(live.id)),
      await BY_ID(req(`/api/orders/${live.id}?wallet=${WALLET}`, await signed()), idParams(live.id)),
      await BY_ID(req(`/api/orders/${finished.id}?wallet=${WALLET}`), idParams(finished.id)),
    ]
    expect(answers.map((r) => r.status)).toEqual([400, 404, 401, 200, 200])
    for (const r of answers) expect(r.headers.get('cache-control')).toBe('private, no-store')
  })

  it('GET /api/orders/:id/executions: 400, 403, 401 (live, unsigned), 200 (live, signed), 200 (finished)', async () => {
    const answers = [
      await EXECUTIONS(req(`/api/orders/${live.id}/executions`), idParams(live.id)),
      await EXECUTIONS(req(`/api/orders/${live.id}/executions?wallet=${OTHER}`), idParams(live.id)),
      await EXECUTIONS(req(`/api/orders/${live.id}/executions?wallet=${WALLET}`), idParams(live.id)),
      await EXECUTIONS(req(`/api/orders/${live.id}/executions?wallet=${WALLET}`, await signed()), idParams(live.id)),
      await EXECUTIONS(req(`/api/orders/${finished.id}/executions?wallet=${WALLET}`), idParams(finished.id)),
    ]
    expect(answers.map((r) => r.status)).toEqual([400, 403, 401, 200, 200])
    for (const r of answers) expect(r.headers.get('cache-control')).toBe('private, no-store')
  })
})
