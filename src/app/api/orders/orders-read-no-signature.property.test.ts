/**
 * [fix/order-signature-not-returned] Property: for seeded random `orders` tables (every status, three wallets, fills,
 * swaps, sometimes a database without the floor-tier migration) and seeded random query strings (`status` single, list,
 * unknown or empty; `hashes` known, unknown, duplicated; both mixed), no read route ever returns a stored signature:
 * not as a `signature` key, not as a value anywhere in the body. Run without a read signature, and with three INVALID
 * ones (wrong signer, expired, malformed), which must behave as none; then once more with a VALID read signature,
 * because the owner dropped `signature` from authenticated reads too (2026-11-17).
 *
 * A failing case names its seed, case number, route and query, never a signature value. Replay one case by running
 * its seed alone.
 */
import { describe, it, expect, vi } from 'vitest'
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
  randomHex,
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

// Published Anvil/Hardhat default account #0 (value-allowlisted in .gitleaks.toml) and the all-ones throwaway key
// route.hardening.test.ts already uses for "another wallet". Neither is a secret.
const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const stranger = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111')
const WALLET = owner.address.toLowerCase()
const WALLETS = [WALLET, '0x' + '5e'.repeat(20), '0x' + '7a'.repeat(20)]

const SEEDS = [1, 7, 42, 1117, 20261117] as const
const CASES_PER_SEED = 80

const STATUS_PARAMS = [...DB_ORDER_STATUSES, 'partially_filled', 'bogus', '', 'EXECUTED']

async function headerSet(kind: 'none' | 'wrong-signer' | 'expired' | 'malformed' | 'valid'): Promise<Record<string, string>> {
  const now = Math.floor(Date.now() / 1000)
  if (kind === 'none') return {}
  if (kind === 'malformed') return { [ORDERS_READ_HEADER_ISSUED]: String(now), [ORDERS_READ_HEADER_SIGNATURE]: '0x1234' }
  const issuedAt = kind === 'expired' ? now - 25 * 3600 : now
  const signer = kind === 'wrong-signer' ? stranger : owner
  return {
    [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: await signer.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt)),
  }
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)]
}

function randomTables(rand: () => number) {
  const orders: Row[] = []
  const n = Math.floor(rand() * 13)
  for (let i = 0; i < n; i++) orders.push(makeOrderRow(rand, { wallet: pick(rand, WALLETS), status: pick(rand, DB_ORDER_STATUSES) }))
  const fills = orders.filter(() => rand() < 0.5).map((o, i) => makeExecutionRow(rand, o, i + 1))
  const swaps = WALLETS.filter(() => rand() < 0.6).map((w) => makeSwapRow(rand, w))
  const missing = rand() < 0.25 ? ['floor_tier', 'floor_ack_at'] : []
  return { orders, fills, swaps, missing }
}

function randomStatusParam(rand: () => number): string | null {
  const r = rand()
  if (r < 0.2) return null
  if (r < 0.5) return pick(rand, STATUS_PARAMS)
  const k = 1 + Math.floor(rand() * 4)
  return Array.from({ length: k }, () => pick(rand, STATUS_PARAMS)).join(',')
}

function randomHashesParam(rand: () => number, orders: Row[]): string | null {
  if (rand() < 0.5) return null
  const known = orders.filter(() => rand() < 0.6).map((o) => String(o.order_hash))
  const unknown = Array.from({ length: Math.floor(rand() * 3) }, () => randomHex(rand, 32))
  const list = [...known, ...unknown, ...(known.length && rand() < 0.3 ? [known[0]] : [])]
  return list.length ? list.join(',') : randomHex(rand, 32)
}

interface CaseResult { label: string; leaks: string[]; rows: number }

async function runCase(rand: () => number, headers: Record<string, string>): Promise<CaseResult> {
  const t = randomTables(rand)
  db = makeOrdersDb({ orders: t.orders, order_executions: t.fills, swaps: t.swaps }, t.missing)
  const stored = t.orders.map((o) => String(o.signature))
  const wallet = pick(rand, WALLETS)
  const route = pick(rand, ['list', 'list', 'list', 'by-id', 'by-id', 'stats', 'executions', 'history'] as const)
  const someId = t.orders.length && rand() < 0.8 ? String(pick(rand, t.orders).id) : 'no-such-id'
  const params = { params: Promise.resolve({ id: someId }) }
  let path: string
  let res: Response
  if (route === 'list') {
    const q = new URLSearchParams({ wallet })
    const status = randomStatusParam(rand)
    const hashes = randomHashesParam(rand, t.orders)
    if (status !== null) q.set('status', status)
    if (hashes !== null) q.set('hashes', hashes)
    path = `/api/orders?${q.toString().replace(/%2C/g, ',')}`
    res = await LIST(new NextRequest(`http://localhost${path}`, { headers }))
  } else if (route === 'by-id') {
    path = `/api/orders/${someId}?wallet=${wallet}`
    res = await BY_ID(new NextRequest(`http://localhost${path}`, { headers }), params)
  } else if (route === 'stats') {
    path = rand() < 0.5 ? `/api/orders/stats?wallet=${wallet}` : '/api/orders/stats'
    res = await STATS(new NextRequest(`http://localhost${path}`, { headers }))
  } else if (route === 'executions') {
    path = `/api/orders/${someId}/executions?wallet=${wallet}`
    res = await EXECUTIONS(new NextRequest(`http://localhost${path}`, { headers }), params)
  } else {
    path = `/api/history?wallet=${wallet}`
    res = await HISTORY(new NextRequest(`http://localhost${path}`, { headers }))
  }
  const body = await res.json()
  const rows = Array.isArray(body.orders) ? body.orders.length : body.order ? 1 : 0
  return { label: `${res.status} ${path}${t.missing.length ? ' [no floor columns]' : ''}`, leaks: findSignatureLeaks(body, stored), rows }
}

describe('property: no stored order signature in any read response', () => {
  it.each(SEEDS)('seed %i: random tables and queries, no or invalid read signature', async (seed) => {
    vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
    const rand = prng(seed)
    const sets = await Promise.all((['none', 'wrong-signer', 'expired', 'malformed'] as const).map(headerSet))
    const failures: string[] = []
    let rowsSeen = 0
    for (let i = 0; i < CASES_PER_SEED; i++) {
      const r = await runCase(rand, pick(rand, sets))
      rowsSeen += r.rows
      if (r.leaks.length) failures.push(`seed ${seed} case ${i}: ${r.label} -> ${r.leaks.join(', ')}`)
    }
    expect(failures).toEqual([])
    // Not vacuous: the public terminal reads did return order rows in this seed.
    expect(rowsSeen).toBeGreaterThan(0)
  })

  it.each(SEEDS)('seed %i: the same, WITH a valid read signature (dropped there too)', async (seed) => {
    vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
    const rand = prng(seed ^ 0x5eed)
    const valid = await headerSet('valid')
    const failures: string[] = []
    let rowsSeen = 0
    for (let i = 0; i < CASES_PER_SEED; i++) {
      const r = await runCase(rand, valid)
      rowsSeen += r.rows
      if (r.leaks.length) failures.push(`seed ${seed} case ${i}: ${r.label} -> ${r.leaks.join(', ')}`)
    }
    expect(failures).toEqual([])
    expect(rowsSeen).toBeGreaterThan(0)
  })
})
