/**
 * [A87b R2-1, owner decision 2026-11-18] GET /api/orders/:id/executions returns every fill of an order plus its progress
 * (dca_total, dca_executed, last tx hash, pair, chain). For an order that is not finished that now needs the wallet's
 * read signature, exactly as reading the order itself does (orders/[id]/route.ts); a finished order stays readable with
 * the wallet parameter only.
 *
 * End to end on the local test setup: the REAL route handlers, real viem read signatures (Anvil account #0) and a fake
 * PostgREST client. The matrix is every status the route can meet (the six the `orders.status` CHECK allows, plus
 * `partially_filled` and a made-up one, which must default to PROTECTED) x four auth states:
 *   none | the wallet's own valid signature | another wallet's signature | an expired one (25 h old).
 * "Another wallet's" is read both ways: a stranger signing the message for the owner's address, and the stranger's
 * own valid signature for the stranger's address presented for the owner's wallet.
 *   live:     401 READ_AUTH_REQUIRED (byte-for-byte the by-id answer) without the owner's valid signature, the fills with it;
 *   finished: the fills in all four cases (the headers are never even looked at).
 * Wrong wallet, unknown id and a missing wallet keep the answers they always had. Fill hashes are compared in the
 * responses; no signature value is printed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { privateKeyToAccount } from 'viem/accounts'
import {
  buildOrdersReadTypedData,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
  PUBLIC_ORDER_STATUSES,
} from '@/lib/order-engine/read-auth'
import type { Row } from '@/test-utils/fake-postgrest'
import { DB_ORDER_STATUSES, makeExecutionRow, makeOrderRow, makeOrdersDb, prng, randomHex } from '@/test-utils/orders-db-fixture'

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
import { GET as BY_ID } from './[id]/route'

// Published Anvil/Hardhat default account #0 (value-allowlisted in .gitleaks.toml) and the all-ones throwaway key
// route.hardening.test.ts already uses for "another wallet". Neither is a secret.
const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const stranger = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111')
const WALLET = owner.address.toLowerCase()
const STRANGER = stranger.address.toLowerCase()

const STATUSES = [...DB_ORDER_STATUSES, 'partially_filled', 'made_up_status'] as const
const isFinished = (status: string) => PUBLIC_ORDER_STATUSES.has(status)
const AUTH_STATES = ['none', 'own', 'stranger-signs-for-owner', 'stranger-own-signature', 'expired'] as const
type AuthState = (typeof AUTH_STATES)[number]

let mine: Row[] = []
let theirs: Row
let fillHash = new Map<string, string>()
let progressHash = new Map<string, string>()

function seed() {
  const rand = prng(20261118)
  mine = STATUSES.map((status) =>
    makeOrderRow(rand, {
      wallet: WALLET,
      status,
      order_type: 'dca',
      // Progress markers a leak would carry: a last tx hash and an amount, on every order whatever its status.
      tx_hash: randomHex(rand, 32),
      amount_out: String(7_000_000 + Math.floor(rand() * 1e6)),
      dca_executed: 2,
      dca_total: 5,
    }),
  )
  theirs = makeOrderRow(rand, { wallet: STRANGER, status: 'active', order_type: 'dca', tx_hash: randomHex(rand, 32) })
  const fills = [...mine, theirs].map((o) => makeExecutionRow(rand, o, 1))
  fillHash = new Map(fills.map((f) => [String(f.order_id), String(f.tx_hash)]))
  progressHash = new Map([...mine, theirs].map((o) => [String(o.id), String(o.tx_hash)]))
  db = makeOrdersDb({ orders: [...mine, theirs], order_executions: fills, swaps: [] })
}

async function headersFor(state: AuthState): Promise<Record<string, string>> {
  const now = Math.floor(Date.now() / 1000)
  const signed = async (signer: typeof owner, forWallet: string, issuedAt: number) => ({
    [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: await signer.signTypedData(buildOrdersReadTypedData(forWallet, issuedAt)),
  })
  switch (state) {
    case 'none':
      return {}
    case 'own':
      return signed(owner, WALLET, now)
    case 'stranger-signs-for-owner':
      return signed(stranger, WALLET, now)
    case 'stranger-own-signature':
      return signed(stranger, STRANGER, now)
    case 'expired':
      return signed(owner, WALLET, now - 25 * 3600)
  }
}

const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { headers })
const idParams = (id: unknown) => ({ params: Promise.resolve({ id: String(id) }) })
const orderOf = (status: string) => mine.find((o) => o.status === status)!
const executionsPath = (o: Row, wallet = WALLET) => `/api/orders/${o.id}/executions?wallet=${wallet}`
const fillSelects = () => db.selects.filter((s) => s.table === 'order_executions')

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
  seed()
})

describe('every status x every auth state', () => {
  const cases = STATUSES.flatMap((status) => AUTH_STATES.map((state) => [status, state] as const))

  it.each(cases)('%s order, auth %s', async (status, state) => {
    const order = orderOf(status)
    const headers = await headersFor(state)
    const res = await EXECUTIONS(req(executionsPath(order), headers), idParams(order.id))
    const body = await res.json()
    const text = JSON.stringify(body)
    const fill = fillHash.get(String(order.id))!
    const progress = progressHash.get(String(order.id))!

    if (isFinished(status) || state === 'own') {
      // Finished: readable in all four cases. Live: only with the owner's own valid signature.
      expect(res.status).toBe(200)
      expect(body.executions).toHaveLength(1)
      expect(body.executions[0].tx_hash).toBe(fill)
      expect(body.order.dca_executed).toBe(2)
      expect(body.order.dca_total).toBe(5)
      expect(body.order.tx_hash).toBe(progress)
      return
    }
    // Live without the owner's valid signature: 401 and not one fill or progress field in the body ...
    expect(res.status).toBe(401)
    expect(body.code).toBe('READ_AUTH_REQUIRED')
    expect(String(body.error)).toMatch(/^Reading an active order requires a wallet signature: /)
    expect(body.executions).toBeUndefined()
    expect(body.order).toBeUndefined()
    expect(text).not.toContain(fill)
    expect(text).not.toContain(progress)
    // ... and the fills table was never even read.
    expect(fillSelects()).toEqual([])
  })

  it.each(cases.filter(([status, state]) => !isFinished(status) && state !== 'own'))(
    'the 401 for a %s order, auth %s, is the by-id route\'s 401 (same status, code and body)',
    async (status, state) => {
      const order = orderOf(status)
      const headers = await headersFor(state)
      const exec = await EXECUTIONS(req(executionsPath(order), headers), idParams(order.id))
      const byId = await BY_ID(req(`/api/orders/${order.id}?wallet=${WALLET}`, headers), idParams(order.id))
      expect(exec.status).toBe(byId.status)
      expect(await exec.json()).toEqual(await byId.json())
    },
  )

  it('an unknown status is protected by default (nothing outside the terminal set is public)', () => {
    expect(isFinished('made_up_status')).toBe(false)
    expect(isFinished('partially_filled')).toBe(false)
    expect([...PUBLIC_ORDER_STATUSES].sort()).toEqual(['cancelled', 'executed', 'expired', 'failed'])
  })

  it('the owner\'s signature is read for the requested wallet only: it does not open the order of a wallet it did not sign for', async () => {
    const order = theirs // active, owned by STRANGER
    const res = await EXECUTIONS(req(executionsPath(order, WALLET), await headersFor('own')), idParams(order.id))
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain(fillHash.get(String(order.id))!)
    expect(fillSelects()).toEqual([])
  })
})

describe('unchanged answers: wrong wallet, unknown id, missing wallet', () => {
  it.each(AUTH_STATES)('a live order asked with the wrong wallet, auth %s: 403 Not authorized, no fill', async (state) => {
    const order = orderOf('active')
    const res = await EXECUTIONS(req(executionsPath(order, STRANGER), await headersFor(state)), idParams(order.id))
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body).toEqual({ executions: [], order: null, error: 'Not authorized' })
    expect(fillSelects()).toEqual([])
  })

  it.each(AUTH_STATES)('a finished order asked with the wrong wallet, auth %s: 403 Not authorized, no fill', async (state) => {
    const order = orderOf('executed')
    const res = await EXECUTIONS(req(executionsPath(order, STRANGER), await headersFor(state)), idParams(order.id))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ executions: [], order: null, error: 'Not authorized' })
  })

  it.each(AUTH_STATES)('an unknown id, auth %s: 403 Not authorized', async (state) => {
    const res = await EXECUTIONS(req(`/api/orders/no-such-order/executions?wallet=${WALLET}`, await headersFor(state)), idParams('no-such-order'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ executions: [], order: null, error: 'Not authorized' })
  })

  it('a missing or malformed wallet parameter: 400 (before anything is read)', async () => {
    const order = orderOf('active')
    const none = await EXECUTIONS(req(`/api/orders/${order.id}/executions`, await headersFor('own')), idParams(order.id))
    expect(none.status).toBe(400)
    const bad = await EXECUTIONS(req(`/api/orders/${order.id}/executions?wallet=0xnope`, await headersFor('own')), idParams(order.id))
    expect(bad.status).toBe(400)
    expect(db.selects).toEqual([])
  })
})

describe('what a finished order returns is byte-for-byte what it returned before (no status field added)', () => {
  it.each(['executed', 'cancelled', 'expired', 'failed'] as const)('a %s order: the same keys as before the change', async (status) => {
    const order = orderOf(status)
    const body = await (await EXECUTIONS(req(executionsPath(order)), idParams(order.id))).json()
    expect(Object.keys(body).sort()).toEqual(['executions', 'order'])
    expect(Object.keys(body.order).sort()).toEqual(
      [
        'amount_out', 'chain_id', 'dca_executed', 'dca_total', 'executed_at', 'executed_price', 'gas_used',
        'token_in_decimals', 'token_in_symbol', 'token_out_decimals', 'token_out_symbol', 'tx_hash',
      ].sort(),
    )
  })
})
