// @vitest-environment node
/**
 * [goal 133d] Audit A106 (PR #729 at e1789dae) R3-1 to R3-3, end to end through the REAL route, the REAL verification
 * and chain read, a stub RPC serving recorded transactions (a real Base 0x swap and the auditor's fork receipts), the
 * fake database, the public readers, /api/history and the stored-rows script. Only the oracle is a fixed table.
 *
 * Failing first: this file runs unchanged on fb93dba5 with the branch's fixtures copied in (swap-receipts.ts and its
 * four a106 files); the tests marked [fails on fb93dba5] fail there by assertion. The others are controls, each killed
 * by a named mutant (FEEDBACK, round 4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => {
  process.env.TZ = 'UTC'
  process.env.RATE_LIMIT_SALT = 'test-only-salt-0123456789-abcdefghijklmnop'
  process.env.MONITOR_SECRET = 'a106-monitor-test-secret-0123456789'
  process.env.HEALTH_TOKEN = 'a106-health-test-token-0123456789'
  delete process.env.NEXT_PUBLIC_FEE_COLLECTOR
  delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
  process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  return {
    db: null as unknown as import('@/test-utils/fake-swaps-db').FakeSwapsDb,
    prices: {} as Record<string, [number, number]>,
  }
})

vi.mock('@/lib/supabase', () => ({ getSupabase: () => state.db.service, getSupabaseLogger: () => state.db.logger, isSupabaseEnabled: () => true }))
vi.mock('@/lib/chainlink', () => ({
  computeTokenAmountUsd: vi.fn(async (token: string, amount: string) => {
    const entry = state.prices[token.toLowerCase()]
    return entry ? { usd: (Number(BigInt(amount)) / 10 ** entry[1]) * entry[0], price: entry[0], decimals: entry[1] } : null
  }),
}))
vi.mock('@/lib/wallet-activity-server', () => ({ trackWalletAction: vi.fn() }))
vi.mock('@/lib/security-tracker', () => ({ trackLargeTrade: vi.fn(), trackSwapFailed: vi.fn(), trackOracleDeviation: vi.fn(), trackOracleUnavailable: vi.fn() }))
vi.mock('@/lib/kv', async () => {
  const { fakeUpstash } = await import('@/test-utils/fake-upstash-kv')
  return { kv: fakeUpstash.kv, kvRaw: fakeUpstash.kvRaw }
})
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  const allow = async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })
  return { ...actual, checkRateLimit: vi.fn(allow), checkRateLimitWithin: vi.fn(allow) }
})
vi.mock('@/lib/source-health-monitor', () => ({ checkSourceHealthAlerts: async () => [] }))

import {
  EVERY_SWAP_RECEIPT,
  ROUND3_RECEIPTS as R3,
  ROUND4_RECEIPTS as R4,
  SWAP_RECEIPTS as R,
  type SwapReceiptFixture,
} from '@/lib/__fixtures__/swap-receipts'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'
import { trackLargeTrade, trackOracleDeviation, trackOracleUnavailable, trackSwapFailed } from '@/lib/security-tracker'
import { _resetVerifiedColumnsCache } from '@/lib/swap-log/store'
import { generateSurplusReport } from '@/lib/surplus-report'
import { verifySwapOnChain, type VerifySwapResult } from '@/lib/swap-verify/verify-swap-on-chain'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import { createFakeSwapsDb, type Row } from '@/test-utils/fake-swaps-db'
import { fakeUpstash } from '@/test-utils/fake-upstash-kv'
import { installStubChainRpc, type StubChainRpcOptions } from '@/test-utils/stub-chain-rpc'
import { main as scriptMain, type SwapsDb } from '../../../../scripts/swaps/verify-stored-swaps-lib'
import { GET as analyticsGet } from '../analytics/route'
import { GET as exportGet } from '../analytics/export/route'
import { GET as personalGet } from '../analytics/personal/route'
import { GET as healthGet } from '../health/route'
import { GET as historyGet } from '../history/route'
import { GET as monitorGet } from '../monitor/route'
import { GET as statsGet } from '../stats/route'
import { PATCH, POST } from './route'

const ALL = [...EVERY_SWAP_RECEIPT, ...Object.values(R3), ...Object.values(R4)]
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WETH: Record<number, string> = { 1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 8453: '0x4200000000000000000000000000000000000006', 42161: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' }
const USDC_OF: Record<number, string> = { 1: USDC, 8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' }
/** The oracle of most tests: ETH at 3,400 USD, the dollar coins at 1. */
const PRICES_3400: Record<string, [number, number]> = Object.fromEntries([
  ...Object.values(WETH).map((t) => [t, [3400, 18]]),
  ...Object.values(USDC_OF).map((t) => [t, [1, 6]]),
  ['0xdac17f958d2ee523a2206206994597c13d831ec7', [1, 6]],
])
const sender = (f: SwapReceiptFixture) => String(f.tx.from).toLowerCase()
const invented = (i: number) => `0x${'cd'.repeat(30)}${i.toString(16).padStart(4, '0')}`
const START = Date.parse('2026-11-27T12:00:00.000Z')
const FLAG = 'SWAPS_PUBLIC_VERIFIED_ONLY'
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

const send = (method: 'POST' | 'PATCH', body: unknown, ip = '203.0.113.7') =>
  (method === 'POST' ? POST : PATCH)(new NextRequest('http://localhost/api/log-swap', { method, headers: { 'Content-Type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify(body) }))
/** What the official client POSTs when the user submits (analytics.ts logSwapToSupabase). */
const submit = (wallet: string, chainId: number, source: string, tokenIn: string, tokenOut: string, amountIn = '1000000000000000000', amountOut = '1000000') =>
  send('POST', { wallet, chainId, source, tokenIn, tokenInSymbol: 'X', tokenOut, tokenOutSymbol: 'Y', amountIn, amountOut, slippage: 0.5, mevProtected: false, feeCollected: false, status: 'pending' })
/** What the official client PATCHes when the transaction confirmed; `chainId` undefined: a client that names none. */
const confirm = (wallet: string, txHash: string, chainId?: number, ip?: string) =>
  send('PATCH', { txHash, status: 'confirmed', wallet, ...(chainId === undefined ? {} : { chainId }) }, ip)

/** A copy: the fake database hands back its live rows. */
const rows = () => state.db.rows().map((r) => ({ ...r }))
const verified = () => rows().filter((r) => r.verified_at !== null && r.verified_at !== undefined)
const isClaim = (r: Row) => r.claimed_tx_hash !== null && r.claimed_tx_hash !== undefined

let rpc: ReturnType<typeof installStubChainRpc>
function stub(options: StubChainRpcOptions = {}) {
  vi.unstubAllGlobals()
  __resetChainIdentityCache()
  rpc = installStubChainRpc({ fixtures: ALL, ...options })
}

beforeEach(() => {
  for (const name of ['RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL']) delete process.env[name]
  delete process.env[FLAG]
  vi.useFakeTimers({ toFake: ['Date'], now: START })
  state.db = createFakeSwapsDb()
  state.prices = { ...PRICES_3400 }
  fakeUpstash.reset()
  _resetVerifiedColumnsCache()
  vi.clearAllMocks()
  stub()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const level of ['log', 'info', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => {
  delete process.env[FLAG]
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── Readers ──────────────────────────────────────────────────────────────────────────────────────────────────────
const PUBLIC_READERS: Record<string, (wallet: string) => Promise<unknown>> = {
  stats: () => statsGet(),
  analytics: () => analyticsGet(),
  export: (w) => exportGet(new NextRequest(`http://localhost/api/analytics/export?wallet=${w}`)),
  personal: (w) => personalGet(new NextRequest(`http://localhost/api/analytics/personal?wallet=${w}`)),
  monitor: () => monitorGet(new Request('http://localhost/api/monitor', { headers: { authorization: 'Bearer a106-monitor-test-secret-0123456789' } })),
  monitorWallet: (w) => monitorGet(new Request(`http://localhost/api/monitor?wallet=${w}`, { headers: { authorization: 'Bearer a106-monitor-test-secret-0123456789' } })),
  health: () => healthGet(new NextRequest('http://localhost/api/health', { headers: { authorization: 'Bearer a106-health-test-token-0123456789' } })),
  surplus: () => generateSurplusReport(),
}
/** Every public reader's body, with the flag on or off, on the database as it is now. */
async function publicBodies(wallet: string, flagOn: boolean): Promise<Record<string, string>> {
  if (flagOn) process.env[FLAG] = 'true'
  else delete process.env[FLAG]
  const out: Record<string, string> = {}
  for (const [name, run] of Object.entries(PUBLIC_READERS)) {
    fakeUpstash.reset()
    const answer = await run(wallet)
    out[name] = answer instanceof Response ? await answer.text() : JSON.stringify(answer)
  }
  delete process.env[FLAG]
  return out
}
/**
 * Flag on, every public reader answers exactly what it answers, flag off, with no swap stored at all. One field is
 * set aside: /api/health's `swapsRowCount`, its table liveness probe ("≥1" when the table holds any row, read without
 * the flag, no column of any row; the differential sets the same probe aside).
 */
async function expectNoneOfItPublic(wallet: string) {
  const probe = (bodies: Record<string, string>) => {
    const health = JSON.parse(bodies.health) as Record<string, unknown>
    return { ...bodies, health: JSON.stringify({ ...health, swapsRowCount: 'PROBE' }) }
  }
  const on = await publicBodies(wallet, true)
  const kept = state.db
  state.db = createFakeSwapsDb()
  const empty = await publicBodies(wallet, false)
  state.db = kept
  expect(JSON.parse(on.health)).toMatchObject({ totalSwaps: 0, sampleSwaps: [] })
  expect(probe(on)).toEqual(probe(empty))
}
async function totalSwapsFlagOff(): Promise<number> {
  fakeUpstash.reset()
  return ((await (await statsGet()).json()) as { totalSwaps?: number }).totalSwaps ?? 0
}
async function historyOf(wallet: string, query = ''): Promise<{ items: Row[]; total: number }> {
  const body = (await (await historyGet(new NextRequest(`http://localhost/api/history?wallet=${wallet}${query}`))).json()) as { swaps: Row[]; total: number }
  return { items: body.swaps.filter((s) => s.kind === 'swap'), total: body.total }
}

/** The stored-rows script, report mode, on the database: its row lines (decision, callerColumns, ...). */
async function report(): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = []
  await scriptMain({
    argv: ['--from-db'], readStdin: async () => '', out: async (l) => void lines.push(l), err: (l) => void lines.push(`ERR ${l}`),
    verify: (input) => verifySwapOnChain(input), db: () => state.db.service as unknown as SwapsDb, describe: () => [], sleep: async () => {},
  })
  expect(lines.filter((l) => l.startsWith('ERR'))).toEqual([])
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => 'decision' in o)
}

// ── R3-1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** What the chain says the transaction did (the stub RPC's calls are cleared afterwards). */
async function onChain(f: SwapReceiptFixture): Promise<VerifySwapResult> {
  const v = await verifySwapOnChain({ chainId: f.chainId, txHash: f.hash, wallet: sender(f) })
  rpc.reset()
  return v
}
/** A row as main stored it after its own PATCH: confirmed, with the hash, the real swap's tokens and amounts, the caller's USD and symbols. */
function mainRowOf(f: SwapReceiptFixture, v: VerifySwapResult, id: string, overrides: Row = {}): Row {
  return {
    id, created_at: new Date(START - 3 * 86_400_000).toISOString(), wallet: sender(f), chain_id: f.chainId, status: 'confirmed', source: v.derived!.source,
    tx_hash: f.hash, token_in: v.derived!.tokenIn, token_in_symbol: 'TKN', token_out: v.derived!.tokenOut, token_out_symbol: 'OUT',
    amount_in: v.derived!.amountIn, amount_out: v.derived!.amountOut, amount_in_usd: 51.2, amount_out_usd: 51, slippage: 0.5, mev_protected: false,
    fee_collected: false, fee_amount: null, gas_used: null, gas_price: null, mev_savings_estimate: null, mev_savings_actual: null, is_gasless: false,
    gas_savings_usd: 0, expected_output: null, ...overrides,
  }
}
/** The audit's caller values: what main stored when it could not price, and the caller's own text. */
const CALLER = { amount_in_usd: 5_000_000, amount_out_usd: 5_000_000, token_in_symbol: 'CALLER<b>TEXT', gas_savings_usd: 500, mev_savings_actual: '999999' }

describe('A106 R3-1: a request never writes on a row main stored', () => {
  const f = R4.baseRouterTokenToToken

  it('the audit\'s path (real Base 0x swap, 5,000,000 USD and a caller symbol, one PATCH from another IP): byte-identical, unverified, still `mark` with its caller columns, not public, flag-off stats 1 [fails on fb93dba5]', async () => {
    const v = await onChain(f)
    expect([v.outcome, v.kind, v.derived?.source]).toEqual(['confirmed', 'router', '0x'])
    state.db = createFakeSwapsDb({ swaps: [mainRowOf(f, v, 'main-row', CALLER)] })
    const before = JSON.stringify(rows())
    const reportBefore = (await report()).find((r) => r.id === 'main-row')
    expect(reportBefore).toMatchObject({ decision: 'mark', kind: 'router', callerColumns: expect.objectContaining({ amount_in_usd: 5_000_000, token_in_symbol: 'CALLER<b>TEXT', gas_savings_usd: 500 }) })
    expect(await totalSwapsFlagOff()).toBe(1)
    // Flag off, a reader shows the row: the comparison below is not empty.
    const off = await publicBodies(sender(f), false)
    expect(Object.values(off).some((body) => body.includes('CALLER') || body.includes('5000000'))).toBe(true)

    expect((await confirm(sender(f), f.hash, f.chainId, '192.0.2.77')).status).toBe(200)

    expect(JSON.stringify(rows())).toBe(before)
    expect(rows()[0].verified_at ?? null).toBeNull()
    expect((await report()).find((r) => r.id === 'main-row')).toEqual(reportBefore)
    await expectNoneOfItPublic(sender(f))
    expect(await totalSwapsFlagOff()).toBe(1)
    for (const tracker of [trackLargeTrade, trackOracleDeviation, trackOracleUnavailable, trackSwapFailed, trackWalletAction]) expect(tracker).not.toHaveBeenCalled()
  })

  it('a row that disagrees with the chain (amount in 1 wei): byte-identical, unverified, still `stored_differs`, not public, flag-off stats 1', async () => {
    const v = await onChain(f)
    state.db = createFakeSwapsDb({ swaps: [mainRowOf(f, v, 'main-row', { ...CALLER, amount_in: '1' })] })
    const before = JSON.stringify(rows())
    const reportBefore = (await report()).find((r) => r.id === 'main-row')
    expect(reportBefore).toMatchObject({ decision: 'stored_differs', differs: ['amount_in'] })
    expect((await confirm(sender(f), f.hash, f.chainId, '192.0.2.77')).status).toBe(200)
    expect(JSON.stringify(rows())).toBe(before)
    expect((await report()).find((r) => r.id === 'main-row')).toEqual(reportBefore)
    await expectNoneOfItPublic(sender(f))
    expect(await totalSwapsFlagOff()).toBe(1)
  })

  it('a POST naming that hash on that chain (the split-swap client): 200 { ok: true }, nothing inserted, no chain read [fails on fb93dba5]', async () => {
    const v = await onChain(f)
    state.db = createFakeSwapsDb({ swaps: [mainRowOf(f, v, 'main-row', CALLER)] })
    const before = JSON.stringify(rows())
    const body = {
      wallet: sender(f), chainId: f.chainId, source: '0x', tokenIn: v.derived!.tokenIn, tokenInSymbol: 'X', tokenOut: v.derived!.tokenOut, tokenOutSymbol: 'Y',
      amountIn: v.derived!.amountIn, amountOut: v.derived!.amountOut, slippage: 0.5, mevProtected: false, feeCollected: false, status: 'confirmed', txHash: f.hash,
    }
    const answer = await send('POST', body, '192.0.2.77')
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ ok: true })
    expect(JSON.stringify(rows())).toBe(before)
    expect(rpc.calls).toEqual([])
    // Control: on another chain the hash names no row main stored there; the POST's own pending row is inserted (and,
    // that chain not having the transaction, its hash is kept as a private claim: round 3's rule).
    expect((await send('POST', { ...body, chainId: 1, tokenIn: USDC, tokenOut: WETH[1] })).status).toBe(200)
    expect(rows().filter((r) => r.id !== 'main-row')).toEqual([
      expect.objectContaining({ wallet: sender(f), chain_id: 1, status: 'pending', tx_hash: null, token_in: USDC, claimed_tx_hash: null }),
      expect.objectContaining({ wallet: sender(f), status: 'pending', tx_hash: null, token_in: null, claimed_tx_hash: f.hash.toLowerCase(), claimed_chain_id: 1 }),
    ])
    expect(JSON.stringify(rows().filter((r) => r.id === 'main-row'))).toBe(before)
  })

  /** Mulberry32: every request below can be replayed from its seed. */
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

  it.each([133, 20261127])('seed %i: 200 requests naming hashes of main\'s rows (agreeing, disagreeing, failed; PATCH with, without and with the wrong chain, another wallet, a lagging node, split-swap POSTs) write nothing on them and leave no row beside them [fails on fb93dba5]', async (seed) => {
    const rand = prng(seed)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
    // Real swaps on the three chains whose sender is the wallet: FeeCollector and 0x.
    const sources: SwapReceiptFixture[] = [R.mainnetFcTokenToToken, R.mainnetRouterTokenToToken, R.baseFcTokenToToken, R.arbitrumRouterTokenToToken, R.arbitrumFcTokenToEth, R4.baseRouterTokenToToken, R3.mainnetRouterEthToToken]
    const main: Row[] = []
    for (const [i, s] of sources.entries()) {
      const v = await onChain(s)
      expect(v.outcome, s.name).toBe('confirmed')
      const shape = i % 3
      main.push(mainRowOf(s, v, `main-${i}`, shape === 0 ? CALLER : shape === 1 ? { ...CALLER, amount_in: '1', status: 'pending' } : { ...CALLER, status: 'failed' }))
    }
    state.db = createFakeSwapsDb({ swaps: main })
    const before = JSON.stringify(rows())
    const statsBefore = await totalSwapsFlagOff()
    const reportBefore = await report()
    expect(reportBefore.filter((r) => r.decision === 'mark')).toHaveLength(3)
    for (const r of reportBefore.filter((x) => x.decision === 'mark')) expect(r.callerColumns).toMatchObject({ amount_in_usd: 5_000_000, token_in_symbol: 'CALLER<b>TEXT' })

    let lagging = false
    stub({ override: (c) => (lagging && c.method === 'eth_getTransactionReceipt' ? null : undefined) })
    const answers = new Map<string, number>()
    for (let n = 0; n < 200; n++) {
      const s = pick(sources)
      const m = main[sources.indexOf(s)]
      const ip = `198.51.100.${1 + Math.floor(rand() * 200)}`
      const roll = rand()
      lagging = roll >= 0.9
      let kind: string
      let status: number
      if (roll < 0.35) [kind, status] = ['patch', (await confirm(sender(s), s.hash, s.chainId, ip)).status]
      else if (roll < 0.5) [kind, status] = ['patch-no-chain', (await confirm(sender(s), s.hash, undefined, ip)).status]
      else if (roll < 0.6) [kind, status] = ['patch-wrong-chain', (await confirm(sender(s), s.hash, pick([1, 8453, 42161].filter((c) => c !== s.chainId)), ip)).status]
      else if (roll < 0.7) [kind, status] = ['patch-other-wallet', (await confirm(sender(pick(sources.filter((o) => sender(o) !== sender(s)))), s.hash, s.chainId, ip)).status]
      else if (roll < 0.9) {
        const post = { wallet: sender(s), chainId: s.chainId, source: '0x', tokenIn: m.token_in, tokenInSymbol: 'X', tokenOut: m.token_out ?? USDC_OF[s.chainId], tokenOutSymbol: 'Y', amountIn: m.amount_in, amountOut: m.amount_out ?? '1', slippage: 0.5, mevProtected: false, feeCollected: false, status: 'confirmed', txHash: s.hash }
        ;[kind, status] = ['post', (await send('POST', post, ip)).status]
      } else [kind, status] = ['patch-lagging', (await confirm(sender(s), s.hash, s.chainId, ip)).status]
      answers.set(`${kind} ${status}`, (answers.get(`${kind} ${status}`) ?? 0) + 1)
      advance(17_000)
    }
    lagging = false

    // What came back: a verified transaction is 200, as today; a chain that does not have it (yet) 202; another
    // wallet's transaction 422.
    const allowed: Record<string, number[]> = { patch: [200], 'patch-no-chain': [200], 'patch-wrong-chain': [202], 'patch-other-wallet': [422], post: [200], 'patch-lagging': [202] }
    for (const key of answers.keys()) {
      const [kind, status] = key.split(' ')
      expect(allowed[kind], key).toContain(Number(status))
    }
    expect(new Set([...answers.keys()].map((k) => k.split(' ')[0])).size).toBe(6)

    // Main's rows: every byte as stored, none verified. Beside them only PRIVATE claim rows (round 3's claim rule,
    // owner's answer of 2026-11-27): no hash, no tokens, no USD, never verified.
    const now = rows()
    expect(JSON.stringify(now.filter((r) => String(r.id).startsWith('main-')))).toBe(before)
    for (const r of now.filter((x) => !String(x.id).startsWith('main-'))) {
      expect(isClaim(r), JSON.stringify(r)).toBe(true)
      expect([r.tx_hash, r.token_in, r.amount_in_usd, r.verified_at ?? null]).toEqual([null, null, null, null])
    }
    expect(verified()).toEqual([])
    await expectNoneOfItPublic(sender(R.mainnetFcTokenToToken))
    expect(await totalSwapsFlagOff()).toBe(statsBefore)
    expect(await report().then((r) => r.filter((x) => String(x.id).startsWith('main-')))).toEqual(reportBefore)
    for (const tracker of [trackLargeTrade, trackOracleDeviation, trackOracleUnavailable, trackSwapFailed, trackWalletAction]) expect(tracker).not.toHaveBeenCalled()

    // The nodes answer: one PATCH per transaction decides its claims, and only main's rows are left, byte for byte.
    for (const s of sources) expect((await confirm(sender(s), s.hash, s.chainId)).status).toBe(200)
    expect(JSON.stringify(rows())).toBe(before)
  }, 120_000)
})


// ── R3-2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const usd2 = (amount: string, decimals: number, price: number) => Math.round((Number(BigInt(amount)) / 10 ** decimals) * price * 100) / 100

describe('A106 R3-2: an ETH-in router row counts the smaller side', () => {
  const HALF: Array<[number, SwapReceiptFixture]> = [[1, R4.mainnetHalfWrap], [8453, R4.baseHalfWrap], [42161, R4.arbitrumHalfWrap]]

  it.each(HALF)('chain %i, the audit\'s AllowanceHolder.exec (20 ETH in, 10 wrapped, 10 sent back): counted at the 10 (34,000 USD); no large trade, no deviation; every total 34,000 [fails on fb93dba5]', async (chainId, f) => {
    const wallet = sender(f)
    await submit(wallet, chainId, '0x', NATIVE, WETH[chainId], '20000000000000000000')
    expect((await confirm(wallet, f.hash, chainId)).status).toBe(200)
    expect(verified()).toEqual([expect.objectContaining({
      verified_kind: 'router', source: '0x', token_in: NATIVE, amount_in: '20000000000000000000', token_out: WETH[chainId], amount_out: '10000000000000000000',
      amount_in_usd: 34_000, amount_out_usd: 34_000,
    })])
    expect(trackLargeTrade).not.toHaveBeenCalled()
    expect(trackOracleDeviation).not.toHaveBeenCalled()
    expect(vi.mocked(trackWalletAction).mock.calls.at(-1)?.[1]).toMatchObject({ action: 'swap_status_update', success: true, amountUsd: 34_000 })
    fakeUpstash.reset()
    const analytics = (await (await analyticsGet()).json()) as { dashboard: { allTime: { totalVolume: number } } }
    expect(analytics.dashboard.allTime.totalVolume).toBe(34_000)
  })

  it('ETH at 6,000 USD (20 ETH = 120,000, 10 WETH = 60,000): the large-trade alert carries 60,000, no oracle deviation [fails on fb93dba5]', async () => {
    const f = R4.baseHalfWrap
    state.prices = { ...PRICES_3400, [WETH[8453]]: [6000, 18] }
    await submit(sender(f), 8453, '0x', NATIVE, WETH[8453], '20000000000000000000')
    expect((await confirm(sender(f), f.hash, 8453)).status).toBe(200)
    expect(verified()[0]).toMatchObject({ amount_in_usd: 60_000, amount_out_usd: 60_000 })
    expect(vi.mocked(trackLargeTrade).mock.calls).toEqual([[expect.objectContaining({ wallet: sender(f), amountUsd: 60_000 })]])
    expect(trackOracleDeviation).not.toHaveBeenCalled()
  })

  // Real ETH -> USDC swaps through 0x (ROUND3_RECEIPTS). The receipts' own rate was 1,619 to 1,693 USDC per ETH, so at
  // 1,800 the ETH side is the larger (in = the USDC side), at 1,500 the smaller (in = the ETH side).
  const REAL: Array<[number, SwapReceiptFixture, number, string]> = [
    [1, R3.mainnetRouterEthToToken, 1800, 'the USDC side'], [8453, R3.baseRouterEthToToken, 1800, 'the USDC side'], [42161, R3.arbitrumRouterEthToToken, 1800, 'the USDC side'],
    [1, R3.mainnetRouterEthToToken, 1500, 'the ETH side'], [8453, R3.baseRouterEthToToken, 1500, 'the ETH side'], [42161, R3.arbitrumRouterEthToToken, 1500, 'the ETH side'],
  ]
  it.each(REAL)('chain %i, a real ETH -> USDC 0x swap at ETH %i USD: both USD values present, in = the smaller (%s) [fails on fb93dba5 at 1,800]', async (chainId, f, price, smaller) => {
    state.prices = { ...PRICES_3400, [WETH[chainId]]: [price, 18] }
    const wallet = sender(f)
    await submit(wallet, chainId, '0x', NATIVE, USDC_OF[chainId], String(BigInt(String(f.tx.value))))
    expect((await confirm(wallet, f.hash, chainId)).status).toBe(200)
    const row = verified()[0]
    expect(row).toMatchObject({ verified_kind: 'router', token_in: NATIVE, token_out: USDC_OF[chainId] })
    const usdIn = usd2(String(row.amount_in), 18, price)
    const usdOut = usd2(String(row.amount_out), 6, 1)
    expect(smaller === 'the USDC side' ? usdOut < usdIn : usdIn < usdOut).toBe(true)
    expect(row.amount_out_usd).toBe(usdOut)
    expect(row.amount_in_usd).toBe(Math.min(usdIn, usdOut))
  })
})

// ── R3-3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('A106 R3-3: claim rows are not History items', () => {
  /** The victim: a real FeeCollector swap on Ethereum, and the POST the official client made for it (audit B4). */
  const V = R.mainnetFcTokenToToken
  const VICTIM = sender(V)

  it('the audit\'s B4 (an invented PATCH, then the victim\'s own): 1 item and total 1 [fails on fb93dba5]', async () => {
    await submit(VICTIM, 1, 'velora', '0x5086bf358635b81d8c47c66d1c8b9e567db70c72', USDC, '46080134130180921522', '51000000')
    expect((await confirm(VICTIM, invented(1), 1, '198.51.100.9')).status).toBe(202)
    expect((await confirm(VICTIM, V.hash, 1)).status).toBe(200)
    expect(rows().filter(isClaim)).toHaveLength(1)
    const history = await historyOf(VICTIM)
    expect(history.items.map((s) => [s.status, s.tx_hash])).toEqual([['confirmed', V.hash.toLowerCase()]])
    expect(history.total).toBe(1)
  })

  it('60 swaps and 5 claim rows (the newest): a first page of 50 swaps, total 60; the second page the other 10 [fails on fb93dba5]', async () => {
    const W = VICTIM
    const swaps: Row[] = Array.from({ length: 60 }, (_, i) => ({
      id: `s-${String(i).padStart(2, '0')}`, created_at: new Date(START - (i + 1) * 60_000).toISOString(), wallet: W, chain_id: 1, status: 'confirmed', source: 'velora',
      tx_hash: `0x${(i + 1).toString(16).padStart(64, '0')}`, token_in: USDC, token_in_symbol: 'USDC', token_out: WETH[1], token_out_symbol: 'WETH',
      amount_in: '1000000', amount_out: '1000', amount_in_usd: 1, amount_out_usd: 1, slippage: 0.5, mev_protected: false, fee_collected: true, fee_amount: null,
      gas_used: null, gas_price: null, mev_savings_estimate: null, mev_savings_actual: null, is_gasless: false, gas_savings_usd: 0, expected_output: null,
    }))
    state.db = createFakeSwapsDb({ swaps })
    // Five claims, through the route (a third party's invented hashes): rows of their own, newer than every swap.
    for (let i = 0; i < 5; i++) expect((await confirm(W, invented(10 + i), 1, '198.51.100.9')).status).toBe(202)
    expect(rows().filter(isClaim)).toHaveLength(5)
    const first = await historyOf(W)
    expect(first.items).toHaveLength(50)
    expect(first.items.map((s) => s.id)).toEqual(swaps.slice(0, 50).map((s) => s.id))
    expect(first.total).toBe(60)
    const second = await historyOf(W, '&offset=50')
    expect(second.items.map((s) => s.id)).toEqual(swaps.slice(50).map((s) => s.id))
    expect(second.total).toBe(60)
  })

  it('before the migration (no claim column): main\'s query answers, every row listed, total as main', async () => {
    const W = VICTIM
    const swaps: Row[] = Array.from({ length: 3 }, (_, i) => ({
      id: `u-${i}`, created_at: new Date(START - (i + 1) * 60_000).toISOString(), wallet: W, chain_id: 1, status: 'confirmed', source: 'velora',
      tx_hash: `0x${(i + 1).toString(16).padStart(64, '0')}`, token_in: USDC, token_in_symbol: 'USDC', token_out: WETH[1], token_out_symbol: 'WETH',
      amount_in: '1000000', amount_out: '1000', amount_in_usd: 1, amount_out_usd: 1, slippage: 0.5, mev_protected: false, fee_collected: true, fee_amount: null,
      gas_used: null, gas_price: null, mev_savings_estimate: null, mev_savings_actual: null, is_gasless: false, gas_savings_usd: 0, expected_output: null,
    }))
    state.db = createFakeSwapsDb({ swaps, migrated: false })
    const history = await historyOf(W)
    expect(history.items.map((s) => s.id)).toEqual(['u-0', 'u-1', 'u-2'])
    expect(history.total).toBe(3)
    // The last read of swaps is main's own query.
    const reads = state.db.ops.filter((o) => o.table === 'swaps' && o.kind === 'select')
    expect(reads.at(-1)?.filters).toEqual([`wallet=eq.${W}`, 'order=created_at.desc', 'range=0-49'])
  })
})
