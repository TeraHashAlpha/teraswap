/**
 * [A87b R2-1] Property: for seeded random `orders` tables (three wallets, every status the database allows plus
 * `partially_filled` and a made-up one, 0 to 3 fills each, unknown ids), a seeded random requested wallet and a seeded
 * random auth state (none, the requested wallet's own valid read signature, a stranger's signature for it, a stranger's own
 * signature, expired, malformed, issued in the future):
 *
 *   NEVER: a live order's fills or progress (any fill row id or tx hash, the order's last tx hash or amount) appear in a response
 *          unless the request carried the OWNER's valid read signature for the wallet it named, and that wallet owns the order.
 *   ALWAYS (so the property is not vacuous): with that signature the live order's fills are all there; a finished order's fills
 *          are there with every auth state; the wrong wallet and an unknown id are 403 whatever the auth.
 *
 * A failing case names its seed, case number, status, auth state and path, never a signature value. Replay one case by
 * running its seed alone.
 *
 * [A97 S-5] Which statuses count as finished is written out below (FINISHED), not read from the code: the oracle of a
 * property must not be the set under test, or a change to that set changes what the property expects with it.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  buildOrdersReadTypedData,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
} from '@/lib/order-engine/read-auth'

/** The orders whose fills anyone may read with the wallet parameter: finished ones (owner-decided boundary, A87b R2-1). */
const FINISHED: ReadonlySet<string> = new Set(['executed', 'cancelled', 'expired', 'failed'])
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

// Wallet #0 is the published Anvil/Hardhat default account (value-allowlisted in .gitleaks.toml, NOT a secret); the two strangers
// are generated per run, so no other key is written down. Which wallet owns what is drawn from the seed by INDEX, so a run
// is replayable from its seed whatever the generated addresses are.
const accounts = [
  privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
  privateKeyToAccount(generatePrivateKey()),
  privateKeyToAccount(generatePrivateKey()),
]
const WALLETS = accounts.map((a) => a.address.toLowerCase())

const STATUSES = [...DB_ORDER_STATUSES, 'partially_filled', 'made_up_status'] as const
const STATES = ['none', 'own', 'stranger-signs-for-wallet', 'stranger-own-signature', 'expired', 'malformed', 'future'] as const
type State = (typeof STATES)[number]

const SEEDS = [1, 7, 42, 1117, 20261118] as const
const CASES_PER_SEED = 120

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)]
}

/** Every (requested wallet, auth state) header set, signed once. */
async function buildHeaderSets() {
  const now = Math.floor(Date.now() / 1000)
  const sets = new Map<string, Record<string, string>>()
  for (let w = 0; w < WALLETS.length; w++) {
    const other = (w + 1) % WALLETS.length
    const sign = async (signer: (typeof accounts)[number], forWallet: string, issuedAt: number) => ({
      [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
      [ORDERS_READ_HEADER_SIGNATURE]: await signer.signTypedData(buildOrdersReadTypedData(forWallet, issuedAt)),
    })
    const byState: Record<State, Record<string, string>> = {
      none: {},
      own: await sign(accounts[w], WALLETS[w], now),
      'stranger-signs-for-wallet': await sign(accounts[other], WALLETS[w], now),
      'stranger-own-signature': await sign(accounts[other], WALLETS[other], now),
      expired: await sign(accounts[w], WALLETS[w], now - 25 * 3600),
      malformed: { [ORDERS_READ_HEADER_ISSUED]: String(now), [ORDERS_READ_HEADER_SIGNATURE]: '0x1234' },
      future: await sign(accounts[w], WALLETS[w], now + 3600),
    }
    for (const s of STATES) sets.set(`${w}:${s}`, byState[s])
  }
  return sets
}

describe('property: a live order\'s fills and progress never leave without the owner\'s valid read signature', () => {
  it.each(SEEDS)('seed %i', async (seed) => {
    vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
    const rand = prng(seed)
    const sets = await buildHeaderSets()
    const failures: string[] = []
    const seen = { liveProtected: 0, liveOwnerSigned: 0, finishedOpen: 0, wrongWallet: 0, unknownId: 0 }

    for (let i = 0; i < CASES_PER_SEED; i++) {
      // Random tables: 0..12 orders, any wallet, any status, each with 0..3 fills; a progress marker on every order.
      const orders: Row[] = []
      const n = 1 + Math.floor(rand() * 12)
      for (let k = 0; k < n; k++) {
        orders.push(
          makeOrderRow(rand, {
            wallet: pick(rand, WALLETS),
            status: pick(rand, STATUSES),
            order_type: 'dca',
            tx_hash: randomHex(rand, 32),
            amount_out: String(7_000_000 + Math.floor(rand() * 1e6)),
            dca_executed: Math.floor(rand() * 5),
          }),
        )
      }
      const fills: Row[] = []
      for (const o of orders) for (let f = 1; f <= Math.floor(rand() * 4); f++) fills.push(makeExecutionRow(rand, o, f))
      db = makeOrdersDb({ orders, order_executions: fills, swaps: [] })

      const target = orders[Math.floor(rand() * orders.length)]
      const unknownId = rand() < 0.1
      const id = unknownId ? 'no-such-order' : String(target.id)
      const requestedIdx = rand() < 0.75 ? WALLETS.indexOf(String(target.wallet)) : Math.floor(rand() * WALLETS.length)
      const requested = WALLETS[requestedIdx]
      const state = pick(rand, STATES)
      const status = String(target.status)
      const finished = FINISHED.has(status)
      const owns = requested === String(target.wallet)
      const path = `/api/orders/${id}/executions?wallet=${requested}`
      const label = `seed ${seed} case ${i}: ${unknownId ? 'unknown id' : status} auth=${state} ${owns ? 'owner' : 'not-owner'}`

      const res = await EXECUTIONS(new NextRequest(`http://localhost${path}`, { headers: sets.get(`${requestedIdx}:${state}`)! }), {
        params: Promise.resolve({ id }),
      })
      const body = await res.json()
      const text = JSON.stringify(body)
      const myFills = fills.filter((f) => f.order_id === target.id)
      const secrets = [
        ...myFills.flatMap((f) => [String(f.tx_hash), String(f.id)]),
        String(target.tx_hash),
        String(target.amount_out),
      ]

      if (unknownId || !owns) {
        seen[unknownId ? 'unknownId' : 'wrongWallet']++
        if (res.status !== 403) failures.push(`${label}: expected 403, got ${res.status}`)
        if (secrets.some((s) => text.includes(s))) failures.push(`${label}: fill or progress in a 403 body`)
        continue
      }
      if (finished) {
        seen.finishedOpen++
        if (res.status !== 200) failures.push(`${label}: finished order expected 200, got ${res.status}`)
        if (body.executions?.length !== myFills.length) failures.push(`${label}: finished order lost fills`)
        continue
      }
      // A live order of the wallet that asked.
      if (state === 'own') {
        seen.liveOwnerSigned++
        if (res.status !== 200) failures.push(`${label}: owner-signed expected 200, got ${res.status}`)
        if (body.executions?.length !== myFills.length) failures.push(`${label}: owner-signed lost fills`)
        if (body.order?.tx_hash !== target.tx_hash) failures.push(`${label}: owner-signed lost progress`)
      } else {
        seen.liveProtected++
        if (res.status !== 401) failures.push(`${label}: expected 401, got ${res.status}`)
        if (secrets.some((s) => text.includes(s))) failures.push(`${label}: LEAK, a fill or progress value is in the response`)
        if (body.executions !== undefined || body.order !== undefined) failures.push(`${label}: executions/order key present`)
      }
    }

    expect(failures).toEqual([])
    // Not vacuous: this seed exercised every branch.
    expect(seen.liveProtected).toBeGreaterThan(0)
    expect(seen.liveOwnerSigned).toBeGreaterThan(0)
    expect(seen.finishedOpen).toBeGreaterThan(0)
    expect(seen.wrongWallet).toBeGreaterThan(0)
    expect(seen.unknownId).toBeGreaterThan(0)
  })
})
