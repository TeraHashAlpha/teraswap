// @vitest-environment node
/**
 * [ADR-029, details D and G] Differential over EVERY reader of `swaps`, on seeded data, with a fixed clock.
 *
 *   Flag off: each reader's answer (status, headers, body bytes) AND the queries it sent to the database are identical
 *             to what main answers and sends. The reference is ./__goldens__/swaps-readers.main.json, recorded by
 *             running THIS file on a checkout of origin/main 5465ceb0 (see `SWAPS_DIFF_WRITE_GOLDEN` below; on main the
 *             only file that has to be copied in is src/test-utils/fake-swaps-db.ts).
 *   Flag on:  each PUBLIC reader answers exactly what it answers, flag off, on a database that holds ONLY the verified
 *             rows; so a reader that ignored the flag fails here. The wallet's own history is the same on and off.
 *
 * To record the reference again (from a checkout of main):
 *   SWAPS_DIFF_WRITE_GOLDEN=/abs/path/swaps-readers.main.json npx vitest run src/app/api/swaps-readers.differential.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => {
  process.env.TZ = 'UTC'
  process.env.MONITOR_SECRET = 'differential-monitor-secret'
  process.env.HEALTH_TOKEN = 'differential-health-token'
  process.env.SUPABASE_URL = 'https://differential.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'differential-not-a-key'
  process.env.RATE_LIMIT_SALT = 'test-only-salt-0123456789-abcdefghijklmnop'
  delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
  return { db: null as unknown as import('@/test-utils/fake-swaps-db').FakeSwapsDb }
})

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => state.db.service,
  getSupabaseLogger: () => state.db.logger,
  isSupabaseEnabled: () => true,
}))
vi.mock('@/lib/kv', async () => {
  const { fakeUpstash } = await import('@/test-utils/fake-upstash-kv')
  return { kv: fakeUpstash.kv, kvRaw: fakeUpstash.kvRaw }
})
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  const allow = async () => ({ allowed: true, remaining: 99, resetAt: 1_900_000_000_000 })
  return { ...actual, checkRateLimit: allow, checkRateLimitWithin: allow }
})
vi.mock('@/lib/source-health-monitor', () => ({ checkSourceHealthAlerts: async () => [] }))

import { generateSurplusReport } from '@/lib/surplus-report'
import { createFakeSwapsDb, type RecordedOp, type Row } from '@/test-utils/fake-swaps-db'
import { fakeUpstash } from '@/test-utils/fake-upstash-kv'
import { GET as analyticsGet } from './analytics/route'
import { GET as exportGet } from './analytics/export/route'
import { GET as personalGet } from './analytics/personal/route'
import { GET as healthGet } from './health/route'
import { GET as historyGet } from './history/route'
import { GET as monitorGet } from './monitor/route'
import { GET as statsGet } from './stats/route'

const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const SEED = 20261125
const GOLDEN = join(process.cwd(), 'src/app/api/__goldens__/swaps-readers.main.json')
const WRITE_GOLDEN = process.env.SWAPS_DIFF_WRITE_GOLDEN

/** Mulberry32: every row below can be replayed from SEED. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hex = (rand: () => number, bytes: number) => {
  let s = '0x'
  for (let i = 0; i < bytes; i++) s += Math.floor(rand() * 256).toString(16).padStart(2, '0')
  return s
}

/** The wallet the per-wallet readers are asked about. */
const WALLET = '0x00000000000000000000000000000000000d1ff1'
/** Marks of rows the server never verified: none may appear in a public answer with the flag on. */
const UNVERIFIED_SYMBOL = 'UNVERIFIEDXSS<img src=x onerror=alert(1)>'
const UNVERIFIED_SOURCE = 'unverified-source'
const UNVERIFIED_TX_PREFIX = '0xdead'

const TOKENS = [
  { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', unit: 10n ** 18n, usd: 3400 },
  { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', unit: 10n ** 6n, usd: 1 },
  { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', unit: 10n ** 6n, usd: 1 },
  { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', unit: 10n ** 18n, usd: 1 },
  { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', unit: 10n ** 8n, usd: 95000 },
]
const SOURCES = ['1inch', '0x', 'velora', 'kyberswap', 'cowswap', 'uniswapv3', 'sushiswap']
const KINDS = ['fee_collector', 'router', 'cow']

function seedSwaps(): Row[] {
  const rand = prng(SEED)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]
  const wallets = [WALLET, ...Array.from({ length: 14 }, () => hex(rand, 20))]
  const rows: Row[] = []

  for (let i = 0; i < 160; i++) {
    const tokenIn = pick(TOKENS)
    const tokenOut = pick(TOKENS.filter((t) => t !== tokenIn))
    const whole = BigInt(1 + Math.floor(rand() * 40))
    const amountIn = (tokenIn.unit * whole) / 10n
    const usd = (Number(whole) / 10) * tokenIn.usd
    const source = pick(SOURCES)
    const wallet = rand() < 0.3 ? WALLET : pick(wallets)
    const ageMs = Math.floor(rand() * 40 * 24 * 3600_000)
    const created = new Date(NOW - ageMs).toISOString()
    const shape = rand()
    const base: Row = {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      created_at: created,
      wallet,
      chain_id: pick([1, 1, 1, 8453, 42161]),
      source,
      token_in: tokenIn.address,
      token_in_symbol: tokenIn.symbol,
      token_out: tokenOut.address,
      token_out_symbol: tokenOut.symbol,
      amount_in: amountIn.toString(),
      amount_out: ((tokenOut.unit * BigInt(Math.round(usd * 100))) / BigInt(Math.round(tokenOut.usd * 100))).toString(),
      amount_in_usd: Math.round(usd * 100) / 100,
      amount_out_usd: Math.round(usd * 99.7) / 100,
      slippage: 0.5,
      mev_protected: source === 'cowswap',
      fee_collected: rand() < 0.6,
      fee_amount: null,
      gas_used: String(120000 + Math.floor(rand() * 200000)),
      gas_price: String(1_000_000_000 + Math.floor(rand() * 9_000_000_000)),
      mev_savings_estimate: null,
      mev_savings_actual: source === 'cowswap' && rand() < 0.5 ? String(Math.floor(rand() * 1e15)) : null,
      is_gasless: source === 'cowswap',
      gas_savings_usd: source === 'cowswap' ? Math.round(rand() * 900) / 100 : 0,
      expected_output: null,
      verified_at: null,
      verified_kind: null,
    }

    if (shape < 0.42) {
      // Verified by the server, confirmed.
      rows.push({ ...base, status: 'confirmed', tx_hash: hex(rand, 32), verified_at: created, verified_kind: source === 'cowswap' ? 'cow' : pick(KINDS.slice(0, 2)), fee_amount: null })
    } else if (shape < 0.48) {
      // Verified, reverted: nothing moved.
      rows.push({ ...base, status: 'failed', tx_hash: hex(rand, 32), verified_at: created, verified_kind: 'router', token_in: null, token_in_symbol: null, token_out: null, token_out_symbol: null, amount_in: null, amount_out: null, amount_in_usd: null, amount_out_usd: null })
    } else if (shape < 0.53) {
      // Verified, the bought side not derivable.
      rows.push({ ...base, status: 'confirmed', tx_hash: hex(rand, 32), verified_at: created, verified_kind: 'router', token_out: null, token_out_symbol: null, amount_out: null, amount_out_usd: null })
    } else if (shape < 0.7) {
      // Written before this change (or by the caller of the incident): "confirmed" by the caller's word only.
      rows.push({ ...base, status: 'confirmed', tx_hash: `${UNVERIFIED_TX_PREFIX}${hex(rand, 30).slice(2)}`, source: rand() < 0.5 ? UNVERIFIED_SOURCE : source, token_in_symbol: rand() < 0.5 ? UNVERIFIED_SYMBOL : tokenIn.symbol, amount_in_usd: rand() < 0.2 ? 1_700_000 : base.amount_in_usd, mev_savings_actual: String(7_777_777_777) })
    } else if (shape < 0.8) {
      // Pending with a hash: main's counters read it as a swap.
      rows.push({ ...base, status: 'pending', tx_hash: `${UNVERIFIED_TX_PREFIX}${hex(rand, 30).slice(2)}`, source: UNVERIFIED_SOURCE })
    } else if (shape < 0.9) {
      // A private pending row, as POST writes it now.
      rows.push({ ...base, status: 'pending', tx_hash: null, amount_in_usd: null, amount_out_usd: null, gas_used: null, gas_price: null })
    } else {
      // The caller's other statuses.
      rows.push({ ...base, status: pick(['failed', 'filled', 'reverted', 'success']), tx_hash: `${UNVERIFIED_TX_PREFIX}${hex(rand, 30).slice(2)}`, token_out_symbol: UNVERIFIED_SYMBOL })
    }
  }
  return rows
}

function seedOther(): Record<string, Row[]> {
  const rand = prng(SEED + 1)
  const quotes: Row[] = Array.from({ length: 60 }, (_, i) => ({
    id: `q-${i}`,
    created_at: new Date(NOW - Math.floor(rand() * 10 * 24 * 3600_000)).toISOString(),
    token_in_symbol: 'WETH', token_out_symbol: 'USDC',
    sources_queried: ['1inch', '0x', 'velora', 'kyberswap'],
    sources_responded: rand() < 0.8 ? ['1inch', '0x', 'velora'] : ['1inch'],
    best_source: ['1inch', '0x', 'velora'][Math.floor(rand() * 3)],
    response_time_ms: 200 + Math.floor(rand() * 900),
    wallet: rand() < 0.3 ? WALLET : null,
  }))
  const order_executions: Row[] = Array.from({ length: 12 }, (_, i) => ({
    id: `e-${i}`,
    created_at: new Date(NOW - Math.floor(rand() * 20 * 24 * 3600_000)).toISOString(),
    tx_hash: hex(rand, 32), amount_in: '1000000', amount_out: '0', status: 'confirmed', order_id: `o-${i}`, execution_number: i,
    orders: {
      wallet: i % 3 === 0 ? WALLET : hex(rand, 20), order_type: 'dca', token_in: TOKENS[1].address, token_in_symbol: 'USDC', token_out: TOKENS[0].address,
      token_out_symbol: 'WETH', chain_id: 8453, router: '0x6a000f20005980200259b80c5102003040001068', dca_total: 4, amount_in: '400000000', status: i % 2 === 0 ? 'executed' : 'active',
      token_in_decimals: 6, token_out_decimals: 18, dca_executed: 2,
    },
  }))
  const security_events: Row[] = Array.from({ length: 8 }, (_, i) => ({
    id: `s-${i}`, type: i % 2 === 0 ? 'large_trade' : 'swap_failed', severity: 'info', timestamp: new Date(NOW - i * 3600_000).toISOString(),
    message: `event ${i}`, wallet: i % 4 === 0 ? WALLET : null, amount_usd: 60000 + i, deviation: null,
  }))
  const wallet_activity: Row[] = Array.from({ length: 6 }, (_, i) => ({
    id: `a-${i}`, created_at: new Date(NOW - i * 7200_000).toISOString(), wallet: WALLET, category: 'swap', action: 'swap_logged', source: '1inch',
    token_in: 'WETH', token_out: 'USDC', amount_usd: null, success: null, error_code: null, error_msg: null, tx_hash: null, order_id: null, duration_ms: null, metadata: {},
  }))
  return { quotes, order_executions, security_events, wallet_activity }
}

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
  ops: Array<Pick<RecordedOp, 'kind' | 'table' | 'detail' | 'filters'>>
}

const READERS: Record<string, { public: boolean; run: () => Promise<Response | unknown> }> = {
  'GET /api/stats': { public: true, run: () => statsGet() },
  'GET /api/analytics': { public: true, run: () => analyticsGet() },
  'GET /api/analytics/export?wallet': { public: true, run: () => exportGet(new NextRequest(`http://localhost/api/analytics/export?wallet=${WALLET}`)) },
  'GET /api/analytics/personal?wallet': { public: true, run: () => personalGet(new NextRequest(`http://localhost/api/analytics/personal?wallet=${WALLET}`)) },
  'GET /api/monitor': { public: true, run: () => monitorGet(new Request('http://localhost/api/monitor', { headers: { authorization: 'Bearer differential-monitor-secret' } })) },
  'GET /api/monitor?wallet': { public: true, run: () => monitorGet(new Request(`http://localhost/api/monitor?wallet=${WALLET}`, { headers: { authorization: 'Bearer differential-monitor-secret' } })) },
  'GET /api/health': { public: true, run: () => healthGet(new NextRequest('http://localhost/api/health', { headers: { authorization: 'Bearer differential-health-token' } })) },
  'surplus-report generateSurplusReport()': { public: true, run: () => generateSurplusReport() },
  // The wallet's own history: not on the flag.
  'GET /api/history?wallet': { public: false, run: () => historyGet(new NextRequest(`http://localhost/api/history?wallet=${WALLET}&limit=100`)) },
}

const HEADERS = ['content-type', 'cache-control', 'content-disposition', 'x-cache']

async function capture(swaps: Row[]): Promise<Record<string, Captured>> {
  const out: Record<string, Captured> = {}
  for (const [name, reader] of Object.entries(READERS)) {
    state.db = createFakeSwapsDb({ swaps, tables: seedOther(), now: () => new Date(NOW) })
    fakeUpstash.reset()
    const answer = await reader.run()
    const ops = state.db.ops.map(({ kind, table, detail, filters }) => ({ kind, table, detail, filters }))
    if (answer instanceof Response) {
      const headers: Record<string, string> = {}
      for (const h of HEADERS) if (answer.headers.get(h) !== null) headers[h] = answer.headers.get(h) as string
      out[name] = { status: answer.status, headers, body: await answer.text(), ops }
    } else {
      out[name] = { status: 0, headers: {}, body: JSON.stringify(answer), ops }
    }
  }
  return out
}

const ALL = seedSwaps()
const ONLY_VERIFIED = ALL.filter((r) => r.verified_at !== null)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
})
afterAll(() => {
  vi.useRealTimers()
})
beforeEach(() => {
  delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the seeded data is not trivial', () => {
  it('holds every shape: verified, unverified "confirmed", pending with and without a hash, other statuses', () => {
    expect(ALL).toHaveLength(160)
    const count = (p: (r: Row) => boolean) => ALL.filter(p).length
    expect(count((r) => r.verified_at !== null && r.status === 'confirmed')).toBeGreaterThan(40)
    expect(count((r) => r.verified_at !== null && r.status === 'failed')).toBeGreaterThan(3)
    expect(count((r) => r.verified_at === null && r.status === 'confirmed')).toBeGreaterThan(15)
    expect(count((r) => r.verified_at === null && r.status === 'pending' && r.tx_hash !== null)).toBeGreaterThanOrEqual(5)
    expect(count((r) => r.status === 'pending' && r.tx_hash === null)).toBeGreaterThanOrEqual(5)
    expect(count((r) => r.wallet === WALLET && r.verified_at === null)).toBeGreaterThan(10)
    expect(count((r) => r.wallet === WALLET && r.verified_at !== null)).toBeGreaterThan(10)
    expect(count((r) => r.is_gasless === true && r.verified_at === null && r.status === 'confirmed')).toBeGreaterThan(0)
  })
})

// Two modes, chosen when the file loads, so neither registers a test it will not run: the comparison (always), or the
// recording of the reference (only when SWAPS_DIFF_WRITE_GOLDEN names a file, on a checkout of main).
const compare = WRITE_GOLDEN ? () => {} : describe
const record = WRITE_GOLDEN ? describe : () => {}

compare('flag OFF: every reader is byte-identical to main', () => {
  it('the reference recorded on main exists and names every reader', () => {
    expect(existsSync(GOLDEN)).toBe(true)
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { main: string; seed: number; readers: Record<string, Captured> }
    expect(golden.main).toBe('5465ceb0')
    expect(golden.seed).toBe(SEED)
    expect(Object.keys(golden.readers).sort()).toEqual(Object.keys(READERS).sort())
  })

  it.each(Object.keys(READERS))('%s: same status, headers, body bytes and database queries as main', async (name) => {
    const golden = (JSON.parse(readFileSync(GOLDEN, 'utf8')) as { readers: Record<string, Captured> }).readers[name]
    const now = (await capture(ALL))[name]
    expect(now.body.length).toBeGreaterThan(20)
    expect(now.status).toBe(golden.status)
    expect(now.headers).toEqual(golden.headers)
    expect(now.body).toBe(golden.body)
    expect(now.ops).toEqual(golden.ops)
  })

  it.each(['false', '1', 'TRUE', 'yes', ''])('a flag value of %j is OFF: still main\'s answers', async (value) => {
    process.env.SWAPS_PUBLIC_VERIFIED_ONLY = value
    const golden = (JSON.parse(readFileSync(GOLDEN, 'utf8')) as { readers: Record<string, Captured> }).readers
    const now = await capture(ALL)
    for (const name of Object.keys(READERS)) expect(now[name].body, name).toBe(golden[name].body)
  })
})

compare('flag ON: every public reader counts and lists only verified rows', () => {
  it.each(Object.entries(READERS).filter(([, r]) => r.public).map(([name]) => name))(
    '%s answers exactly what it answers, flag off, on a database with ONLY the verified rows',
    async (name) => {
      const offAll = (await capture(ALL))[name]
      const offVerified = (await capture(ONLY_VERIFIED))[name]
      // The seeded data makes the difference visible in this reader: without that the test would prove nothing.
      expect(offAll.body).not.toBe(offVerified.body)

      process.env.SWAPS_PUBLIC_VERIFIED_ONLY = 'true'
      const onAll = (await capture(ALL))[name]
      expect(onAll.status).toBe(offVerified.status)
      expect(onAll.headers).toEqual(offVerified.headers)
      expect(onAll.body).toBe(offVerified.body)
      // Nothing of a row the server never verified is in the answer.
      expect(onAll.body).not.toContain('UNVERIFIEDXSS')
      expect(onAll.body).not.toContain(UNVERIFIED_SOURCE)
      expect(onAll.body).not.toContain(UNVERIFIED_TX_PREFIX)
      expect(onAll.body).not.toContain('1700000')
      // Every read of swaps this reader made asked for verified rows only (the liveness probe of /api/health aside).
      const swapReads = onAll.ops.filter((o) => o.table === 'swaps' && o.kind === 'select' && !(name === 'GET /api/health' && o.detail === 'id'))
      expect(swapReads.length).toBeGreaterThan(0)
      for (const op of swapReads) expect(op.filters, JSON.stringify(op)).toContain('verified_at=not.is.null')
      expect(onAll.ops.some((o) => o.kind === 'rpc')).toBe(false)
    },
  )

  it('the wallet\'s own history is the same with the flag on or off: its pending and failed rows stay', async () => {
    const off = (await capture(ALL))['GET /api/history?wallet']
    process.env.SWAPS_PUBLIC_VERIFIED_ONLY = 'true'
    const on = (await capture(ALL))['GET /api/history?wallet']
    expect(on).toEqual(off)
    const listed = (JSON.parse(on.body) as { swaps: Row[] }).swaps
    const mine = ALL.filter((r) => r.wallet === WALLET)
    expect(listed.filter((r) => r.kind === 'swap')).toHaveLength(Math.min(mine.length, 100))
    expect(listed.some((r) => r.status === 'pending' && r.tx_hash === null)).toBe(true)
    expect(listed.some((r) => r.verified_at === null)).toBe(true)
    expect(on.ops.filter((o) => o.table === 'swaps').every((o) => !o.filters.includes('verified_at=not.is.null'))).toBe(true)
  })

  it('the personal aggregate is cached under its own key while the flag is on', async () => {
    state.db = createFakeSwapsDb({ swaps: ALL, tables: seedOther(), now: () => new Date(NOW) })
    fakeUpstash.reset()
    const request = () => new NextRequest(`http://localhost/api/analytics/personal?wallet=${WALLET}`)
    const off = await (await personalGet(request())).json()
    await Promise.resolve()
    process.env.SWAPS_PUBLIC_VERIFIED_ONLY = 'true'
    const on = await personalGet(request())
    // Not the aggregate cached a moment ago with the flag off.
    expect(on.headers.get('x-cache')).toBe('MISS')
    const body = await on.json()
    expect(body.totalSwaps).toBeLessThan(off.totalSwaps)
    expect(body.totalSwaps).toBe(ONLY_VERIFIED.filter((r) => r.wallet === WALLET && r.status === 'confirmed').length)
  })
})

record('record the reference (run on a checkout of main)', () => {
  it('writes what every reader answers and asks, flag off', async () => {
    const readers = await capture(ALL)
    writeFileSync(String(WRITE_GOLDEN), `${JSON.stringify({ main: '5465ceb0', seed: SEED, now: new Date(NOW).toISOString(), readers }, null, 1)}\n`)
    expect(Object.keys(readers)).toHaveLength(Object.keys(READERS).length)
  })
})
