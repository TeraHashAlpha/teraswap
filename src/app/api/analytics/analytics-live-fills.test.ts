// @vitest-environment node
/**
 * [A97 S-2, owner decision 2026-11-19] GET /api/analytics: the public recent-trades list shows only fills of FINISHED orders;
 * every total and count still counts every fill.
 *
 * Differential, seeded: the real GET on random tables (swaps, orders in every status incl. partially_filled, an unknown one
 * and none, 0..4 confirmed fills each plus some unconfirmed, some fills sharing a swap's tx) against the real GET on their
 * TWIN, the same tables with every order 'executed'. With every order finished the route answers what origin/main answers
 * (main never reads the status; the scratch run against main's own route is in the feedback file), so:
 *   - every field except `recentTrades` is byte-identical between the two (allTime, last24h/7d/30d, bySource, byHour,
 *     topPairs, totalWallets, dailyVolume), and so are `enabled` and the Cache-Control header;
 *   - `recentTrades` = the twin's list minus the fills of orders that are not finished, in the twin's order.
 * The terminal set is written out here (not read from the code), so a change to the code's set fails this test.
 * Not vacuous: each seed removes live fills from the list, keeps finished ones, and has more than 50 events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Row } from '@/test-utils/fake-postgrest'
import { makeExecutionRow, makeOrderRow, makeOrdersDb, makeSwapRow, prng } from '@/test-utils/orders-db-fixture'

let db = makeOrdersDb({ orders: [] })
vi.mock('@/lib/supabase', () => ({ getSupabase: () => db.client, getSupabaseLogger: () => null, isSupabaseEnabled: () => true }))

import { GET } from './route'

/** The orders whose fills may be listed publicly: finished. Written out on purpose (A97 S-5). */
const FINISHED = new Set(['executed', 'cancelled', 'expired', 'failed'])
const STATUSES: Array<string | null> = ['active', 'executing', 'executed', 'cancelled', 'expired', 'failed', 'partially_filled', 'made_up_status', null]
const WALLETS = ['0x' + '1a'.repeat(20), '0x' + '2b'.repeat(20), '0x' + '3c'.repeat(20)]
const NOW = Date.UTC(2026, 10, 12, 12)
const SEEDS = [5, 19, 404, 1119, 20261119] as const

function tables(rand: () => number) {
  const swaps: Row[] = Array.from({ length: 40 + Math.floor(rand() * 30) }, () => makeSwapRow(rand, WALLETS[Math.floor(rand() * 3)]))
  const orders: Row[] = Array.from({ length: 12 + Math.floor(rand() * 10) }, () => {
    const status = STATUSES[Math.floor(rand() * STATUSES.length)]
    return makeOrderRow(rand, { wallet: WALLETS[Math.floor(rand() * 3)], status: status as string, order_type: 'dca' })
  })
  const fills: Row[] = []
  for (const o of orders) {
    const n = Math.floor(rand() * 5)
    for (let k = 1; k <= n; k++) {
      const f = makeExecutionRow(rand, o, k)
      f.created_at = new Date(Date.parse(String(o.created_at)) + k * 3_600_000).toISOString()
      if (rand() < 0.1) f.status = 'failed' // never read by the route (confirmed only), on main or here
      if (rand() < 0.05 && swaps.length > 0) f.tx_hash = swaps[Math.floor(rand() * swaps.length)].tx_hash // the swap row wins
      fills.push(f)
    }
  }
  return { swaps, orders, fills }
}

async function dashboard(t: { swaps: Row[]; orders: Row[]; fills: Row[] }) {
  db = makeOrdersDb({ orders: t.orders, order_executions: t.fills, swaps: t.swaps })
  const res = await GET()
  const body = await res.json()
  return { body, cacheControl: res.headers.get('cache-control') }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/analytics: recentTrades lists only fills of finished orders; every total is unchanged (A97 S-2)', () => {
  it.each(SEEDS)('seed %i: differential against the all-finished twin (= origin/main\'s answer)', async (seed) => {
    const t = tables(prng(seed))
    const twin = { ...t, orders: t.orders.map((o) => ({ ...o, status: 'executed' })) }
    const here = await dashboard(t)
    const main = await dashboard(twin)

    expect(here.body.enabled).toBe(main.body.enabled)
    expect(here.cacheControl).toBe(main.cacheControl)
    const { recentTrades: hereTrades, ...hereRest } = here.body.dashboard
    const { recentTrades: mainTrades, ...mainRest } = main.body.dashboard
    expect(JSON.stringify(hereRest)).toBe(JSON.stringify(mainRest))

    const statusOf = new Map(t.orders.map((o) => [String(o.id), o.status as string | null]))
    const liveFillIds = new Set(t.fills.filter((f) => !FINISHED.has(String(statusOf.get(String(f.order_id))))).map((f) => String(f.id)))
    const expected = (mainTrades as Array<{ id: string }>).filter((e) => !liveFillIds.has(e.id))
    expect(JSON.stringify(hereTrades)).toBe(JSON.stringify(expected))

    // Not vacuous: something was removed, finished fills and swaps were kept, and the 50-row window was full on main.
    expect((mainTrades as unknown[]).length - (hereTrades as unknown[]).length).toBeGreaterThan(0)
    const finishedFillIds = new Set(t.fills.filter((f) => FINISHED.has(String(statusOf.get(String(f.order_id))))).map((f) => String(f.id)))
    expect((hereTrades as Array<{ id: string }>).some((e) => finishedFillIds.has(e.id))).toBe(true)
    expect(main.body.dashboard.allTime.tradeCount).toBeGreaterThan(50)
  })

  it('a live DCA\'s fills are counted but not listed; once it finishes they are listed, in place', async () => {
    const rand = prng(7)
    const dca = makeOrderRow(rand, { wallet: WALLETS[0], status: 'active', order_type: 'dca', created_at: new Date(NOW - 5 * 3_600_000).toISOString() })
    const fills: Row[] = [1, 2].map((k) => ({ ...makeExecutionRow(rand, dca, k), created_at: new Date(NOW - (5 - k) * 3_600_000).toISOString() }))
    const swaps: Row[] = [makeSwapRow(rand, WALLETS[1])].map((s) => ({ ...s, created_at: new Date(NOW - 3_600_000).toISOString() }))
    const live = await dashboard({ swaps, orders: [dca], fills })
    expect(live.body.dashboard.allTime.tradeCount).toBe(3)
    expect(live.body.dashboard.last24h.tradeCount).toBe(3)
    expect(live.body.dashboard.recentTrades.map((e: { txHash: string }) => e.txHash)).toEqual([swaps[0].tx_hash])

    for (const status of ['executed', 'cancelled', 'expired', 'failed']) {
      const done = await dashboard({ swaps, orders: [{ ...dca, status }], fills })
      expect(done.body.dashboard.allTime).toEqual(live.body.dashboard.allTime)
      expect(done.body.dashboard.recentTrades.map((e: { txHash: string }) => e.txHash)).toEqual([swaps[0].tx_hash, fills[1].tx_hash, fills[0].tx_hash])
    }
    for (const status of ['executing', 'partially_filled', 'made_up_status', null]) {
      const still = await dashboard({ swaps, orders: [{ ...dca, status }], fills })
      expect(still.body.dashboard.recentTrades.map((e: { txHash: string }) => e.txHash)).toEqual([swaps[0].tx_hash])
    }
  })
})
