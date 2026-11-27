// @vitest-environment node
/**
 * [goal 133c details S] Audit A104 (PR #729 at 2b8a9cd6) R2-1 to R2-5, end to end through the REAL route as the official
 * client drives it (POST, then PATCH with the chain), the REAL verification and chain read, a stub RPC serving recorded
 * transactions (real ones, the auditor's fork ones), the fake database, the real per-IP limiter on a fake KV where a
 * budget is under test, and the public readers. Only the oracle is a fixed table.
 *
 * Failing first: this file runs unchanged on cbd51bcf with the branch's fixtures copied in; the tests marked
 * [fails on cbd51bcf] fail there by assertion. The others are controls, each proven by a named mutant (tables, Q5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => {
  process.env.TZ = 'UTC'
  process.env.RATE_LIMIT_SALT = 'test-only-salt-0123456789-abcdefghijklmnop'
  delete process.env.NEXT_PUBLIC_FEE_COLLECTOR
  delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
  process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  return {
    db: null as unknown as import('@/test-utils/fake-swaps-db').FakeSwapsDb,
    prices: {} as Record<string, [number, number]>,
    /** false: every limiter call is allowed (as in the other route files); true: the real limiter on the fake KV. */
    realLimiter: false,
    /** Upstash's sorted sets, as the limiter uses them (the shared fake KV has no pipeline). */
    zsets: new Map<string, Array<{ score: number; member: string }>>(),
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
  // The limiter's sliding window (kv-rate-limiter.ts checkRateLimit): pipeline(zremrangebyscore, zcard, zadd, expire),
  // then zrem / zrange when it refuses. Modelled here so the REAL limiter decides, at its real limits.
  const set = (key: string) => state.zsets.get(key) ?? (state.zsets.set(key, []), state.zsets.get(key)!)
  const extras: Record<string, unknown> = {
    pipeline: () => {
      const ops: Array<() => unknown> = []
      const p = {
        zremrangebyscore: (key: string, min: number, max: number) => {
          ops.push(() => {
            const before = set(key).length
            state.zsets.set(key, set(key).filter((e) => e.score < min || e.score > max))
            return before - set(key).length
          })
          return p
        },
        zcard: (key: string) => (ops.push(() => set(key).length), p),
        zadd: (key: string, ...entries: Array<{ score: number; member: string }>) => (ops.push(() => (set(key).push(...entries), entries.length)), p),
        expire: () => (ops.push(() => 1), p),
        exec: async () => ops.map((op) => op()),
      }
      return p
    },
    zrem: async (key: string, ...members: string[]) => (state.zsets.set(key, set(key).filter((e) => !members.includes(e.member))), members.length),
    zrange: async (key: string) => {
      const oldest = [...set(key)].sort((a, b) => a.score - b.score)[0]
      return oldest ? [oldest.member, oldest.score] : []
    },
  }
  const kv = new Proxy(fakeUpstash.kv as object, { get: (target, prop) => (typeof prop === 'string' && prop in extras ? extras[prop] : Reflect.get(target, prop)) })
  return { kv, kvRaw: fakeUpstash.kvRaw }
})
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  const allow = async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })
  return {
    ...actual,
    checkRateLimit: vi.fn((...a: Parameters<typeof actual.checkRateLimit>) => (state.realLimiter ? actual.checkRateLimit(...a) : allow())),
    checkRateLimitWithin: vi.fn((...a: Parameters<typeof actual.checkRateLimitWithin>) => (state.realLimiter ? actual.checkRateLimitWithin(...a) : allow())),
  }
})

import { EVERY_SWAP_RECEIPT, ROUND3_RECEIPTS as R3, SWAP_RECEIPTS as R, type SwapReceiptFixture } from '@/lib/__fixtures__/swap-receipts'
import { ROUTER_WHITELIST_BY_CHAIN } from '@/lib/chains/routers'
import { _internal as limiterInternal, checkRateLimitWithin } from '@/lib/kv-rate-limiter'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'
import { trackLargeTrade, trackOracleDeviation, trackOracleUnavailable } from '@/lib/security-tracker'
import { confirmSwap } from '@/lib/swap-log/confirm'
import { _resetVerifiedColumnsCache } from '@/lib/swap-log/store'
import { verifySwapOnChain } from '@/lib/swap-verify/verify-swap-on-chain'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import { createFakeSwapsDb, type Row } from '@/test-utils/fake-swaps-db'
import { fakeUpstash } from '@/test-utils/fake-upstash-kv'
import { installStubChainRpc, type StubChainRpcOptions } from '@/test-utils/stub-chain-rpc'
import { main as scriptMain, type SwapsDb } from '../../../../scripts/swaps/verify-stored-swaps-lib'
import { GET as analyticsGet } from '../analytics/route'
import { GET as historyGet } from '../history/route'
import { GET as statsGet } from '../stats/route'
import { PATCH, POST } from './route'

/** The constants of goal 133c, written out so this file runs unchanged on cbd51bcf (which has none of them). */
const CLAIM_CAP = 20
const CHAINLESS_PER_MINUTE = 6
const READ_BUDGET_PER_MINUTE = 60

const ALL = [...EVERY_SWAP_RECEIPT, ...Object.values(R3)]
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
const zeroX = (chainId: number) => ROUTER_WHITELIST_BY_CHAIN[chainId]['0x'].toLowerCase()
const invented = (i: number) => `0x${'ab'.repeat(30)}${i.toString(16).padStart(4, '0')}`

const send = (method: 'POST' | 'PATCH', body: unknown) =>
  (method === 'POST' ? POST : PATCH)(new NextRequest('http://localhost/api/log-swap', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))

/** What the official client POSTs when the user submits (analytics.ts logSwapToSupabase). */
function submit(wallet: string, chainId: number, source: string, tokenIn: string, tokenOut: string, amountIn = '1000000000000000000', amountOut = '1000000') {
  return send('POST', {
    wallet, chainId, source, tokenIn, tokenInSymbol: 'X', tokenOut, tokenOutSymbol: 'Y', amountIn, amountOut,
    slippage: 0.5, mevProtected: false, feeCollected: source !== '0x', status: 'pending',
  })
}
/** What the official client PATCHes when the transaction confirmed; `chainId` undefined: a client that names none. */
const confirm = (wallet: string, txHash: string, chainId?: number) => send('PATCH', { txHash, status: 'confirmed', wallet, ...(chainId === undefined ? {} : { chainId }) })

const rows = () => state.db.rows()
const verified = () => rows().filter((r) => r.verified_at !== null && r.verified_at !== undefined)
const claimRowsOf = (wallet: string) => rows().filter((r) => r.wallet === wallet && r.claimed_tx_hash !== null && r.claimed_tx_hash !== undefined)
const hasClaim = (wallet: string, hash: string) => claimRowsOf(wallet).some((r) => String(r.claimed_tx_hash).toLowerCase() === hash.toLowerCase())
const recorded = (wallet: string, hash: string) => verified().some((r) => r.wallet === wallet && String(r.tx_hash).toLowerCase() === hash.toLowerCase())

async function publicCounts() {
  fakeUpstash.reset()
  const wasReal = state.realLimiter
  state.realLimiter = false
  const stats = (await (await statsGet()).json()) as { totalSwaps?: number }
  const analytics = (await (await analyticsGet()).json()) as { dashboard: { allTime: { totalVolume: number; tradeCount: number } } }
  state.realLimiter = wasReal
  return { totalSwaps: stats.totalSwaps ?? 0, volume: analytics.dashboard.allTime.totalVolume, trades: analytics.dashboard.allTime.tradeCount }
}
async function historyOf(wallet: string): Promise<Row[]> {
  const body = (await (await historyGet(new NextRequest(`http://localhost/api/history?wallet=${wallet}`))).json()) as { swaps: Row[] }
  return body.swaps.filter((s) => s.kind === 'swap')
}

let rpc: ReturnType<typeof installStubChainRpc>
function stub(options: StubChainRpcOptions = {}) {
  vi.unstubAllGlobals()
  __resetChainIdentityCache()
  rpc = installStubChainRpc({ fixtures: ALL, ...options })
}
/** Serves `moved` with their target moved to that chain's 0x AllowanceHolder (tx.to and receipt.to; logs unchanged). */
function stubSentToZeroX(moved: readonly SwapReceiptFixture[]) {
  stub({
    override: (c) => {
      const f = moved.find((m) => m.chainId === c.chainId && m.hash.toLowerCase() === c.hash)
      if (!f) return undefined
      if (c.method === 'eth_getTransactionByHash') return { ...f.tx, to: zeroX(f.chainId) }
      if (c.method === 'eth_getTransactionReceipt') return { ...f.receipt, to: zeroX(f.chainId) }
      return undefined
    },
  })
}

let warned: string[] = []
const START = Date.parse('2026-11-26T12:00:00.000Z')
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

beforeEach(() => {
  for (const name of ['RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL']) delete process.env[name]
  vi.useFakeTimers({ toFake: ['Date'], now: START })
  state.db = createFakeSwapsDb()
  state.prices = { ...PRICES_3400 }
  state.realLimiter = false
  state.zsets.clear()
  limiterInternal.reset()
  fakeUpstash.reset()
  _resetVerifiedColumnsCache()
  vi.clearAllMocks()
  stub()
  warned = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warned.push(args.map(String).join(' ')))
  for (const level of ['log', 'info', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── R2-1: N and O ──────────────────────────────────────────────────────────────────────────────────────────────────
const DUST: Array<[string, SwapReceiptFixture]> = [
  ['Ethereum dust wrap', R3.a104MainnetDustWrap],
  ['Base dust wrap', R3.a104BaseDustWrap],
  ['Arbitrum dust wrap', R3.a104ArbitrumDustWrap],
  ['Base dust real swap', R3.a104BaseDustSwap],
]
const outTokenOf = (f: SwapReceiptFixture) => (f === R3.a104BaseDustSwap ? USDC_OF[8453] : WETH[f.chainId])

describe('A104 R2-1: 20 ETH paid and refunded for a dust return is never 20 ETH of volume', () => {
  it.each(DUST)('%s, as the audit sent it (to SwapRouter02): 422, nothing verified, priced, alerted or public [fails on cbd51bcf]', async (_name, f) => {
    const wallet = sender(f)
    await submit(wallet, f.chainId, 'uniswapv3', NATIVE, outTokenOf(f), '20000000000000000000')
    expect((await confirm(wallet, f.hash, f.chainId)).status).toBe(422)
    expect(verified()).toEqual([])
    expect(trackLargeTrade).not.toHaveBeenCalled()
    expect(trackOracleDeviation).not.toHaveBeenCalled()
    expect(await publicCounts()).toEqual({ totalSwaps: 0, volume: 0, trades: 0 })
  })

  it.each(DUST)('%s, its logs sent to the 0x AllowanceHolder: confirmed with NO USD on either side, no security event, no volume [fails on cbd51bcf]', async (_name, f) => {
    stubSentToZeroX([f])
    const wallet = sender(f)
    await submit(wallet, f.chainId, '0x', NATIVE, outTokenOf(f), '20000000000000000000')
    expect((await confirm(wallet, f.hash, f.chainId)).status).toBe(200)
    expect(verified()).toEqual([expect.objectContaining({ verified_kind: 'router', source: '0x', token_in: NATIVE, amount_in: '20000000000000000000', amount_in_usd: null, amount_out_usd: null })])
    for (const tracker of [trackLargeTrade, trackOracleDeviation, trackOracleUnavailable]) expect(tracker).not.toHaveBeenCalled()
    // The wallet-activity line is still written (owner, 2026-11-26), with no USD in it.
    expect(vi.mocked(trackWalletAction).mock.calls.at(-1)?.[1]).toMatchObject({ action: 'swap_status_update', success: true, amountUsd: undefined })
    expect((await publicCounts()).volume).toBe(0)
  })

  // ETH's price in the days these were read, measured on the receipts themselves (1,619 to 1,693 USDC per ETH).
  const REAL: Array<[number, SwapReceiptFixture]> = [
    [1, R3.mainnetRouterEthToToken],
    [8453, R3.baseRouterEthToToken],
    [42161, R3.arbitrumRouterEthToToken],
  ]
  it.each(REAL)('chain %i control: a REAL swap of ETH for USDC through 0x is confirmed with both USD values', async (chainId, f) => {
    state.prices = { ...PRICES_3400, [WETH[chainId]]: [1630, 18] }
    const wallet = sender(f)
    await submit(wallet, chainId, '0x', NATIVE, USDC_OF[chainId], String(BigInt(String(f.tx.value))))
    expect((await confirm(wallet, f.hash, chainId)).status).toBe(200)
    const row = verified()[0]
    expect(row).toMatchObject({ verified_kind: 'router', source: '0x', token_in: NATIVE, token_out: USDC_OF[chainId] })
    expect(typeof row.amount_in_usd).toBe('number')
    expect(typeof row.amount_out_usd).toBe('number')
    expect(Number(row.amount_out_usd) / Number(row.amount_in_usd)).toBeGreaterThan(0.9)
    expect((await publicCounts()).volume).toBeGreaterThan(0)
  })
})

// ── R2-2 / R2-3: P ─────────────────────────────────────────────────────────────────────────────────────────────────
/** The victim: a real FeeCollector swap on Ethereum, and the POST the official client made for it. */
const V = R.mainnetFcTokenToToken
const VICTIM = sender(V)
const SOLD = '0x5086bf358635b81d8c47c66d1c8b9e567db70c72'
const postVictim = () => submit(VICTIM, 1, 'velora', SOLD, USDC, '46080134130180921522', '51000000')
/** The victim's node lags: its transaction is there, the receipt is not, while `lagging.on`. */
const lagging = { on: true }
function stubVictimLag() {
  lagging.on = true
  stub({ override: (c) => (lagging.on && c.hash === V.hash.toLowerCase() && c.method === 'eth_getTransactionReceipt' ? null : undefined) })
}
/** The victim's four client tries while the node lags (analytics.ts: at once, then after 2, 8 and 30 s). */
async function victimClaims() {
  await postVictim()
  for (let i = 0; i < 4; i++) expect((await confirm(VICTIM, V.hash, 1)).status).toBe(202)
  expect(hasClaim(VICTIM, V.hash)).toBe(true)
}

describe('A104 R2-2: a third party cannot delete a victim\'s claim', () => {
  it('B3: 20 invented hashes for the victim while its claim is live: the claim stays; a later PATCH records the swap [fails on cbd51bcf]', async () => {
    stubVictimLag()
    await victimClaims()
    for (let i = 0; i < 20; i++) expect((await confirm(VICTIM, invented(i), 1)).status).toBe(202)
    expect(hasClaim(VICTIM, V.hash)).toBe(true)
    expect(claimRowsOf(VICTIM).length).toBeLessThanOrEqual(CLAIM_CAP)
    lagging.on = false
    expect((await confirm(VICTIM, V.hash, 1)).status).toBe(200)
    expect(recorded(VICTIM, V.hash)).toBe(true)
    expect(hasClaim(VICTIM, V.hash)).toBe(false)
  })

  it('B3, the cap check: past 10 minutes, the next claim at the cap asks the chain and records the victim\'s swap [fails on cbd51bcf]', async () => {
    stubVictimLag()
    await victimClaims()
    for (let i = 0; i < 20; i++) await confirm(VICTIM, invented(i), 1)
    lagging.on = false
    advance(11 * 60_000)
    expect((await confirm(VICTIM, invented(99), 1)).status).toBe(202)
    // The oldest claim was the victim's: asked first, found, verified and recorded on the victim's POST row.
    expect(recorded(VICTIM, V.hash)).toBe(true)
    expect(verified()[0]).toMatchObject({ status: 'confirmed', token_in: SOLD, slippage: 0.5 })
    expect(hasClaim(VICTIM, V.hash)).toBe(false)
  })

  it('B3, the script: the node recovers, the owner runs --apply: the victim\'s swap is recorded [fails on cbd51bcf]', async () => {
    stubVictimLag()
    await victimClaims()
    for (let i = 0; i < 20; i++) await confirm(VICTIM, invented(i), 1)
    lagging.on = false
    const lines: string[] = []
    const code = await scriptMain({
      argv: ['--from-db', '--apply'], readStdin: async () => '', out: async (l) => void lines.push(l), err: (l) => void lines.push(`ERR ${l}`),
      verify: (input) => verifySwapOnChain(input), db: () => state.db.service as unknown as SwapsDb, describe: () => [], sleep: async () => {},
      confirmClaim: (db) => async (claim) => (await confirmSwap({ db: db as never, wallet: claim.wallet, txHash: claim.txHash, chainId: claim.chainId }, { trackers: false })).result,
    })
    expect(code).toBe(0)
    expect(recorded(VICTIM, V.hash)).toBe(true)
  })

  it('B3b: a claim older than 24 h survives 5 POSTs, 5 invented hashes and 1 POST [fails on cbd51bcf]', async () => {
    stubVictimLag()
    await victimClaims()
    advance(25 * 3_600_000)
    for (let i = 0; i < 5; i++) await submit(VICTIM, 42161, '0x', WETH[42161], USDC_OF[42161])
    for (let i = 0; i < 5; i++) await confirm(VICTIM, invented(200 + i), 42161)
    await submit(VICTIM, 42161, '0x', WETH[42161], USDC_OF[42161])
    expect(hasClaim(VICTIM, V.hash)).toBe(true)
  })

  it('at the cap with every claim younger than 10 minutes: the new claim is NOT stored, 202, one swap_claim_cap line [fails on cbd51bcf]', async () => {
    const W = '0x00000000000000000000000000000000000c1a10'
    for (let i = 0; i < CLAIM_CAP; i++) expect((await confirm(W, invented(i), 1)).status).toBe(202)
    expect(claimRowsOf(W)).toHaveLength(CLAIM_CAP)
    warned = []
    const res = await confirm(W, invented(500), 1)
    expect([res.status, await res.json()]).toEqual([202, { ok: false, outcome: 'not_found' }])
    expect(claimRowsOf(W)).toHaveLength(CLAIM_CAP)
    expect(hasClaim(W, invented(500))).toBe(false)
    expect(warned.filter((l) => l.includes('swap_claim_cap'))).toEqual(['[log-swap] swap_claim_cap'])
  })

  it('the cap check: of claims older than 10 minutes, at most 3 are asked, oldest first; no chain has them: deleted; a claim whose receipt is missing stays [fails on cbd51bcf]', async () => {
    stubVictimLag()
    await victimClaims()
    for (let i = 0; i < CLAIM_CAP - 1; i++) await confirm(VICTIM, invented(i), 1)
    expect(claimRowsOf(VICTIM)).toHaveLength(CLAIM_CAP)
    advance(11 * 60_000)
    rpc.reset()
    expect((await confirm(VICTIM, invented(700), 1)).status).toBe(202)
    // The victim's claim (oldest) was asked and kept (its receipt is still missing); the next two (invented) were asked
    // and deleted; so the new claim was stored: 20 - 2 + 1.
    expect(hasClaim(VICTIM, V.hash)).toBe(true)
    expect(hasClaim(VICTIM, invented(0))).toBe(false)
    expect(hasClaim(VICTIM, invented(1))).toBe(false)
    expect(hasClaim(VICTIM, invented(2))).toBe(true)
    expect(hasClaim(VICTIM, invented(700))).toBe(true)
    expect(claimRowsOf(VICTIM)).toHaveLength(CLAIM_CAP - 1)
    // Asked about: the request's own hash, then the three checked claims, each on its own chain (1).
    expect(new Set(rpc.reads().map((c) => c.hash))).toEqual(new Set([invented(700), V.hash.toLowerCase(), invented(0), invented(1)]))
  })

  it('a claim older than 7 days is deleted by the wallet\'s next claim; one of 6 days is not [fails on cbd51bcf]', async () => {
    const W = '0x00000000000000000000000000000000000c1a11'
    await confirm(W, invented(1), 1)
    advance(24 * 3_600_000)
    await confirm(W, invented(2), 1)
    advance(6.5 * 24 * 3_600_000)
    await confirm(W, invented(3), 1)
    expect(hasClaim(W, invented(1))).toBe(false)
    expect(hasClaim(W, invented(2))).toBe(true)
    expect(hasClaim(W, invented(3))).toBe(true)
  })
})

describe('P.1 and P.2: one claim row per (wallet, chain named or none, hash); the result reuses one and deletes the rest', () => {
  it('a repeat is the same row and does not move claimed_at; a third party naming another chain gets a row of its own [fails on cbd51bcf]', async () => {
    stubVictimLag()
    await confirm(VICTIM, V.hash, 1)
    // Copies: the fake database hands back its live rows, which an update changes in place.
    const first = claimRowsOf(VICTIM).map((r) => ({ ...r }))
    expect(first).toHaveLength(1)
    advance(5 * 60_000)
    await confirm(VICTIM, V.hash, 1)
    expect(claimRowsOf(VICTIM)).toEqual(first)
    // Someone names the victim's hash on Base: a row of its own; the victim's (chain 1) is unchanged.
    await confirm(VICTIM, V.hash, 8453)
    expect(claimRowsOf(VICTIM).map((r) => r.claimed_chain_id).sort()).toEqual([1, 8453])
    // Naming no chain: the search finds the transaction on chain 1 (Q.3), so its key is the victim's own row.
    await confirm(VICTIM, V.hash)
    expect(claimRowsOf(VICTIM)).toHaveLength(2)
    expect(claimRowsOf(VICTIM).find((r) => r.id === first[0].id)).toEqual(first[0])
  })

  it('no POST row agrees: the claim row of this chain becomes the verified row; the hash\'s other claim rows are deleted [fails on cbd51bcf]', async () => {
    stubVictimLag()
    await confirm(VICTIM, V.hash, 8453)
    await confirm(VICTIM, V.hash, 1)
    const onChain1 = claimRowsOf(VICTIM).find((r) => r.claimed_chain_id === 1)
    expect(onChain1, 'a claim row for chain 1').toBeDefined()
    lagging.on = false
    expect((await confirm(VICTIM, V.hash, 1)).status).toBe(200)
    expect(claimRowsOf(VICTIM)).toEqual([])
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ id: onChain1?.id, status: 'confirmed', chain_id: 1, tx_hash: V.hash.toLowerCase(), claimed_tx_hash: null })
  })
})

describe('A104 R2-3: a third party\'s claim never lands on the victim\'s POST row', () => {
  it('B4: an invented PATCH lands on a row of its own; the victim\'s POST row gets its verified swap; History shows one item [fails on cbd51bcf]', async () => {
    await postVictim()
    // A copy: the fake database hands back its live rows, which an update changes in place.
    const postRow = { ...rows()[0] }
    expect((await confirm(VICTIM, invented(300), 1)).status).toBe(202)
    // The POST row is untouched; the invented hash is on a claim row.
    expect(rows().find((r) => r.id === postRow.id)).toEqual(postRow)
    expect(hasClaim(VICTIM, invented(300))).toBe(true)
    expect((await confirm(VICTIM, V.hash, 1)).status).toBe(200)
    expect(rows().find((r) => r.id === postRow.id)).toMatchObject({ status: 'confirmed', tx_hash: V.hash.toLowerCase(), slippage: 0.5, verified_kind: 'fee_collector' })
    const history = await historyOf(VICTIM)
    expect(history.map((s) => [s.status, s.tx_hash])).toEqual([['confirmed', V.hash.toLowerCase()]])
  })
})

// ── P.5 property ───────────────────────────────────────────────────────────────────────────────────────────────────
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

describe('P.5 property, seeded: requests naming only invented hashes never delete a claim whose transaction exists', () => {
  it.each([133, 20261126])('seed %i: 400 requests over up to 5 days [fails on cbd51bcf]', async (seed) => {
    const rand = prng(seed)
    stubVictimLag()
    await victimClaims()
    let n = 0
    const stats = { invented: 0, posts: 0, recovered: false, recordedBy: '', capChecksSurvived: 0 }
    // The node recovers late: until then every cap check that asks about the victim's claim finds the transaction with no
    // receipt and must keep it; after it, only a cap check can record the swap (the victim sends nothing in the run).
    const recoverAt = 250 + Math.floor(rand() * 100)
    for (let i = 0; i < 400; i++) {
      const r = rand()
      if (r < 0.6) {
        const chain = [1, 8453, 42161, undefined][Math.floor(rand() * 4)]
        await confirm(VICTIM, invented(1000 + Math.floor(rand() * 5000)), chain)
        stats.invented++
      } else if (r < 0.8) {
        await submit(VICTIM, [1, 8453, 42161][Math.floor(rand() * 3)], '0x', SOLD, USDC)
        stats.posts++
      } else {
        advance(Math.floor(rand() * 18 * 60_000))
      }
      n++
      if (n === recoverAt) {
        lagging.on = false
        stats.recovered = true
      }
      const kept = hasClaim(VICTIM, V.hash)
      const done = recorded(VICTIM, V.hash)
      if (!stats.recovered && kept && rpc.reads().some((c) => c.hash === V.hash.toLowerCase())) stats.capChecksSurvived++
      rpc.reset()
      expect(kept || done, `seed ${seed}, request ${n}: the victim's claim is gone and its swap is not recorded`).toBe(true)
      if (done && !stats.recordedBy) stats.recordedBy = `request ${n}`
      expect(claimRowsOf(VICTIM).length, `seed ${seed}, request ${n}: claims`).toBeLessThanOrEqual(CLAIM_CAP)
    }
    expect(Date.now() - START).toBeLessThan(6 * 24 * 3_600_000)
    // Not vacuous: the cap was reached, the cap check asked about the victim's claim while the node lagged and kept it,
    // and after the node recovered a cap check recorded the swap.
    expect(stats.invented).toBeGreaterThan(150)
    expect(Date.now() - START).toBeGreaterThan(60 * 60_000)
    expect(stats.capChecksSurvived).toBeGreaterThan(0)
    expect(recorded(VICTIM, V.hash)).toBe(true)
    if (process.env.SWAP_A104_DUMP) writeFileSync(join(process.env.SWAP_A104_DUMP, `p5-seed-${seed}.json`), `${JSON.stringify({ seed, ...stats, elapsedMin: Math.round((Date.now() - START) / 60_000) })}\n`)
  }, 120_000)
})

// ── R2-4: Q ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('A104 R2-4: a budget for confirmations that name no chain, and for every chain read', () => {
  it('Q.1: the 7th confirmation naming no chain in a minute from one IP is 429; one naming its chain is not [fails on cbd51bcf]', async () => {
    state.realLimiter = true
    const W = '0x00000000000000000000000000000000000b0d01'
    const statuses: number[] = []
    for (let i = 0; i <= CHAINLESS_PER_MINUTE; i++) statuses.push((await confirm(W, invented(i))).status)
    expect(statuses.slice(0, CHAINLESS_PER_MINUTE).every((s) => s === 202)).toBe(true)
    expect(statuses[CHAINLESS_PER_MINUTE]).toBe(429)
    expect((await confirm(W, invented(50), 1)).status).toBe(202)
    advance(61_000)
    expect((await confirm(W, invented(51))).status).toBe(202)
    // The real limiter decided, on its KV path (not the 50% in-memory fallback).
    expect(limiterInternal.isKvFailureAlerted()).toBe(false)
  })

  it('Q.1 before the migration is applied: chainless confirmations past the limit still get main\'s answer, nothing read or written', async () => {
    state.realLimiter = true
    state.db = createFakeSwapsDb({ migrated: false })
    const W = '0x00000000000000000000000000000000000b0d02'
    for (let i = 0; i < CHAINLESS_PER_MINUTE + 4; i++) {
      const res = await confirm(W, invented(i))
      expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    }
    expect(rpc.calls).toEqual([])
    expect(state.db.writes()).toEqual([])
  })

  it('Q.2: 60 upstream calls per IP per minute; then 202 without a call, the claim still stored; a minute later it reads again [fails on cbd51bcf]', async () => {
    state.realLimiter = true
    stub({ fixtures: [] })
    const answers: number[] = []
    const callsAfter: number[] = []
    // Each confirmation of an unknown hash on its named chain: the transaction read asked twice (and the chain-id proof once).
    for (let i = 0; i < 32; i++) {
      answers.push((await confirm(`0x${(0xd00 + i).toString(16).padStart(40, '0')}`, invented(i), 1)).status)
      callsAfter.push(rpc.calls.length)
    }
    expect(answers.every((s) => s === 202)).toBe(true)
    expect(rpc.calls.length).toBe(READ_BUDGET_PER_MINUTE)
    // The last request sent nothing upstream, and its hash is kept all the same.
    expect(callsAfter[31]).toBe(callsAfter[30])
    expect(hasClaim(`0x${(0xd00 + 31).toString(16).padStart(40, '0')}`, invented(31))).toBe(true)
    advance(61_000)
    await confirm('0x0000000000000000000000000000000000000e00', invented(99), 1)
    expect(rpc.calls.length).toBeGreaterThan(READ_BUDGET_PER_MINUTE)
    expect(limiterInternal.isKvFailureAlerted()).toBe(false)
  })

  it('Q.2: a spent budget ends the search: a request naming no chain asks the budget once and tries no other chain [fails on cbd51bcf]', async () => {
    state.realLimiter = true
    stub({ fixtures: [] })
    // Spend the minute's budget (each confirmation of an unknown hash on its chain: 2 calls, the first also the proof).
    for (let i = 0; i < 40; i++) await confirm(`0x${(0xa00 + i).toString(16).padStart(40, '0')}`, invented(600 + i), 1)
    rpc.reset()
    const budgetAsks = () => vi.mocked(checkRateLimitWithin).mock.calls.filter((c) => String(c[0]).startsWith('log-reads:')).length
    const before = budgetAsks()
    const W = '0x00000000000000000000000000000000000b0d03'
    expect((await confirm(W, invented(700))).status).toBe(202)
    expect(rpc.calls).toEqual([])
    expect(budgetAsks() - before).toBe(1)
    // The claim is still kept, with no chain (none was asked).
    expect(claimRowsOf(W).map((r) => r.claimed_chain_id)).toEqual([null])
  })

  it('Q.2 with P.3: the cap check\'s reads are paid too; spent, it asks nothing and deletes nothing, and the claim is not stored [fails on cbd51bcf]', async () => {
    state.realLimiter = true
    stub({ fixtures: [] })
    const W = '0x00000000000000000000000000000000000c1a12'
    for (let i = 0; i < CLAIM_CAP; i++) await confirm(W, invented(i), 1)
    expect(claimRowsOf(W)).toHaveLength(CLAIM_CAP)
    advance(11 * 60_000)
    // Another wallet of the same IP spends the minute's budget.
    for (let i = 0; i < 40 && rpc.calls.length < 10_000; i++) await confirm(`0x${(0xf00 + i).toString(16).padStart(40, '0')}`, invented(900 + i), 1)
    rpc.reset()
    warned = []
    expect((await confirm(W, invented(800), 1)).status).toBe(202)
    expect(rpc.calls).toEqual([])
    expect(claimRowsOf(W)).toHaveLength(CLAIM_CAP)
    for (let i = 0; i < CLAIM_CAP; i++) expect(hasClaim(W, invented(i))).toBe(true)
    expect(warned.filter((l) => l.includes('swap_claim_cap'))).toHaveLength(1)
  })

  /** The audit's four cases of a PATCH that names no chain (and the worst one naming its chain), measured. */
  const real = R.mainnetFcTokenToToken
  type Case = { name: string; wallet: string; hash: string; chainId?: number; options: () => StubChainRpcOptions }
  const CASES: Case[] = [
    { name: 'E1 unknown hash, every node answers null', wallet: '0x00000000000000000000000000000000000e0001', hash: invented(400), options: () => ({ fixtures: [] }) },
    { name: 'E2 every node 503', wallet: '0x00000000000000000000000000000000000e0002', hash: invented(401), options: () => ({ fail: () => true }) },
    {
      name: 'E3 a transaction every chain "has", receipts erroring', wallet: sender(real), hash: real.hash,
      options: () => ({ override: (c) => (c.method === 'eth_getTransactionByHash' ? real.tx : undefined), fail: (c) => c.method === 'eth_getTransactionReceipt' }),
    },
    {
      name: 'E4 first transaction read errors then answers, receipts erroring', wallet: sender(real), hash: real.hash,
      options: () => {
        const seen: Record<string, number> = {}
        return {
          fail: (c) => c.method === 'eth_getTransactionReceipt' || (c.method === 'eth_getTransactionByHash' && (seen[c.chainId] = (seen[c.chainId] ?? 0) + 1) % 2 === 1),
          override: (c) => (c.method === 'eth_getTransactionByHash' ? real.tx : undefined),
        }
      },
    },
  ]
  const named: Case = { ...CASES[3], name: 'E5 = E4 naming its chain', chainId: 1 }
  /**
   * Measured: first request (chain-id proofs not cached) and steady state (cached). On cbd51bcf (round 2) E3 was 12 and
   * E4 15 on the first request (the audit: 15 first, 12 steady), because a receipt error moved on to the next chain.
   */
  const BOUNDS: Record<string, [number, number]> = { E1: [9, 6], E2: [3, 0], E3: [4, 3], E4: [5, 4], E5: [5, 4] }

  it.each([...CASES, named])('Q.3, Q.4: $name: upstream calls of one request, first and steady [E3, E4 fail on cbd51bcf]', async (c) => {
    stub(c.options())
    await confirm(c.wallet, c.hash, c.chainId)
    const first = rpc.calls.length
    const firstChains = [...new Set(rpc.calls.map((x) => x.chainId))]
    rpc.reset()
    await confirm(c.wallet, c.hash, c.chainId)
    const steady = rpc.calls.length
    const [wantFirst, wantSteady] = BOUNDS[c.name.slice(0, 2)]
    expect(first, `${c.name}: first`).toBe(wantFirst)
    expect(steady, `${c.name}: steady`).toBe(wantSteady)
    // Q.3: once a chain returned the transaction, no other chain is asked.
    if (c.name.startsWith('E3') || c.name.startsWith('E4')) expect(firstChains).toEqual([1])
    if (process.env.SWAP_A104_DUMP) writeFileSync(join(process.env.SWAP_A104_DUMP, `q4-${c.name.slice(0, 2)}.json`), `${JSON.stringify({ case: c.name, first, steady, firstChains })}\n`)
  })
})

// ── R2-5: R ────────────────────────────────────────────────────────────────────────────────────────────────────────
// CHANGED EXPECTATION (GOAL 133D, A106 R3-1, ADR-029 9.1 REPLACES 8.5): A ROW MAIN STORED IS READ-ONLY FOR A REQUEST.
// THE FIRST TEST SAID "VERIFIED IN PLACE"; IT NOW SAYS THE ROW IS BYTE-IDENTICAL AND STAYS UNVERIFIED. Never doubled: kept.
describe('A104 R2-5: a row main stored for the transaction is never doubled (and, since A106 R3-1, never written)', () => {
  const f = R.mainnetFcTokenToToken
  /** A row as main stored it after its own PATCH: confirmed, with the hash, the caller's symbols and USD. */
  const mainRow = (overrides: Row = {}): Row => ({
    id: 'main-row', created_at: new Date(START - 3 * 86_400_000).toISOString(), wallet: sender(f), chain_id: 1, status: 'confirmed', source: 'velora',
    tx_hash: f.hash, token_in: SOLD, token_in_symbol: 'SOLD', token_out: USDC, token_out_symbol: 'USDC', amount_in: '46080134130180921522', amount_out: '51000000',
    amount_in_usd: 51.2, amount_out_usd: 51, slippage: 0.5, mev_protected: false, fee_collected: true, fee_amount: null, gas_used: null, gas_price: null,
    mev_savings_estimate: null, mev_savings_actual: null, is_gasless: false, gas_savings_usd: 0, expected_output: null, ...overrides,
  })

  it('it agrees with the receipt: LEFT BYTE-IDENTICAL AND UNVERIFIED, nothing inserted, flag-off totalSwaps stays 1 [fails on cbd51bcf]', async () => {
    state.db = createFakeSwapsDb({ swaps: [mainRow()] })
    expect((await publicCounts()).totalSwaps).toBe(1)
    const before = JSON.stringify(rows())
    expect((await confirm(sender(f), f.hash, 1)).status).toBe(200)
    expect(rows()).toHaveLength(1)
    // CHANGED EXPECTATION (A106 R3-1): WAS verified_kind 'fee_collector' AND verified_at SET; NOW EVERY COLUMN AS MAIN STORED IT.
    expect(JSON.stringify(rows())).toBe(before)
    expect(rows()[0].verified_at ?? null).toBeNull()
    expect((await publicCounts()).totalSwaps).toBe(1)
    expect(trackLargeTrade).not.toHaveBeenCalled()
    expect(trackWalletAction).not.toHaveBeenCalled()
  })

  it('it disagrees (500 WETH declared): left exactly as main stored it, nothing inserted, totalSwaps stays 1 [fails on cbd51bcf]', async () => {
    state.db = createFakeSwapsDb({ swaps: [mainRow({ token_in: WETH[1], amount_in: '500000000000000000000', amount_in_usd: 1_700_000 })] })
    const before = JSON.stringify(rows())
    expect((await confirm(sender(f), f.hash, 1)).status).toBe(200)
    expect(JSON.stringify(rows())).toBe(before)
    expect((await publicCounts()).totalSwaps).toBe(1)
  })
})
