// @vitest-environment node
/**
 * [ADR-029, details G] Property, seeded: 1,000 requests per seed against the REAL route, verification and chain read,
 * the stub RPC (recorded real transactions) and the fake database. Honest wallets, invented wallets and callers that
 * name someone else's wallet are mixed; every free value a caller sends carries a marker.
 *
 * After EVERY request:
 *   P1  a verified row says exactly what the chain says: its status is the receipt's, its wallet is the sender (or the
 *       Trade owner), its tokens, amounts and source are the ones derived from the receipt, its symbols are catalog
 *       symbols, its USD is the oracle's price of the DERIVED amount, and no caller marker is anywhere in it
 *       (slippage and expected_output apart: the owner's decision of 2026-11-25 keeps those two validated numbers);
 *   P2  a row that is not verified is pending and has no transaction hash and no USD value;
 *   P3  one transaction, one row per wallet;
 *   P4  a request changes and creates rows of the wallet it names, and of no other wallet; a PATCH creates at most one
 *       (its verified row, or a claim row);
 *   P5  no response and no log line carries a caller marker; the status code is one of the documented ones;
 *   P6  alert trackers are called only for a row verified by that request, with derived values;
 *   P7  (133b J) no wallet holds more than 20 scratch rows (pending, hash-less, unverified, created in the last hour or
 *       carrying a claim), and a row disappears only as a scratch row of the wallet the request names.
 * A failure prints the seed and the request number: the run can be replayed exactly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_SALT = 'test-only-salt-0123456789-abcdefghijklmnop'
  delete process.env.NEXT_PUBLIC_FEE_COLLECTOR
  process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  return {
    db: null as unknown as import('@/test-utils/fake-swaps-db').FakeSwapsDb,
    alerts: [] as Array<{ tracker: string; args: Record<string, unknown> }>,
  }
})

/** The oracle: a fixed price per token, so the expected USD of a derived amount can be computed here too. */
const PRICES: Record<string, [number, number]> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': [1, 6],
  '0xdac17f958d2ee523a2206206994597c13d831ec7': [1, 6],
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': [3400, 18],
  '0x6b175474e89094c44da98b954eedeac495271d0f': [1, 18],
  '0x4200000000000000000000000000000000000006': [3400, 18],
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': [1, 6],
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': [3400, 18],
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': [1, 6],
}
const WRAPPED: Record<number, string> = {
  1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  8453: '0x4200000000000000000000000000000000000006',
  42161: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
}
function oracleUsd(token: string, amount: string): number | null {
  const entry = PRICES[token.toLowerCase()]
  return entry ? (Number(BigInt(amount)) / 10 ** entry[1]) * entry[0] : null
}

vi.mock('@/lib/supabase', () => ({ getSupabase: () => state.db.service, getSupabaseLogger: () => state.db.logger }))
vi.mock('@/lib/chainlink', () => ({
  computeTokenAmountUsd: vi.fn(async (token: string, amount: string) => {
    const usd = oracleUsd(token, amount)
    return usd === null ? null : { usd, price: 0, decimals: 0 }
  }),
}))
vi.mock('@/lib/wallet-activity-server', () => ({ trackWalletAction: vi.fn() }))
vi.mock('@/lib/security-tracker', () => {
  const record = (tracker: string) => vi.fn((args: Record<string, unknown>) => void state.alerts.push({ tracker, args }))
  return {
    trackLargeTrade: record('large_trade'),
    trackSwapFailed: record('swap_failed'),
    trackOracleDeviation: record('oracle_deviation'),
    trackOracleUnavailable: record('oracle_unavailable'),
  }
})
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  const allow = vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 }))
  return { ...actual, checkRateLimit: allow, checkRateLimitWithin: allow }
})

import { ALL_SWAP_RECEIPTS, recordedChainRead, type SwapReceiptFixture } from '@/lib/__fixtures__/swap-receipts'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'
import { catalogSymbol } from '@/lib/swap-log/symbols'
import { _resetVerifiedColumnsCache } from '@/lib/swap-log/store'
import { NATIVE_PLACEHOLDER, verifySwapOnChain, type VerifySwapResult } from '@/lib/swap-verify/verify-swap-on-chain'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import { createFakeSwapsDb, type Row } from '@/test-utils/fake-swaps-db'
import { installStubChainRpc } from '@/test-utils/stub-chain-rpc'
import { PATCH, POST } from './route'

const MARK = 'CALLERMARK'
/** A digit pattern no real amount, gas figure or price in the fixtures contains. */
const DIGIT_MARK = '313373133731337'
const SOURCES = ['1inch', '0x', 'velora', 'kyberswap', 'cowswap', 'uniswapv3', 'sushiswap', 'curve', 'openocean', 'odos', 'balancer', 'bebop', 'uniswap']
const TOKENS = Object.keys(PRICES).concat([NATIVE_PLACEHOLDER, '0x5086bf358635b81d8c47c66d1c8b9e567db70c72'])
const TRADE_TOPIC = '0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17'

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

/** A wallet that can truthfully claim a fixture: its sender, or for a CoW settlement the owner of a Trade in it. */
interface Claim {
  fixture: SwapReceiptFixture
  wallet: string
  /** A source under which this wallet's claim verifies. */
  source: string
}
function claims(): Claim[] {
  const out: Claim[] = []
  for (const f of ALL_SWAP_RECEIPTS) {
    if (f.name.includes('cow')) {
      for (const log of f.receipt.logs) {
        const topics = log.topics as string[]
        if (topics[0] === TRADE_TOPIC) out.push({ fixture: f, wallet: `0x${topics[1].slice(26)}`, source: 'cowswap' })
      }
    } else out.push({ fixture: f, wallet: String(f.tx.from).toLowerCase(), source: f.name.includes('router') ? '0x' : 'velora' })
  }
  return out
}

const request = (method: 'POST' | 'PATCH', body: unknown) =>
  (method === 'POST' ? POST : PATCH)(new NextRequest('http://localhost/api/log-swap', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))

let logged: string[] = []

beforeEach(() => {
  for (const name of ['RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL']) delete process.env[name]
  _resetVerifiedColumnsCache()
  __resetChainIdentityCache()
  state.alerts.length = 0
  vi.clearAllMocks()
  installStubChainRpc()
  logged = []
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    })
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function runSeed(seed: number, total: number) {
  const rand = prng(seed)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]
  const chance = (p: number) => rand() < p
  const all = claims()
  const invented = Array.from({ length: 6 }, (_, i) => `0x${(i + 1).toString(16).repeat(40)}`)
  const inventedHash = () => `0x${Array.from({ length: 64 }, () => Math.floor(rand() * 16).toString(16)).join('')}`
  const mark = (kind: string) => `${MARK}-${kind}-${Math.floor(rand() * 1e6)}`

  // What the chain says for every (chain, hash, wallet, source) a verified row can have: asked of the same function,
  // through a recorded read, outside the route.
  const truthCache = new Map<string, VerifySwapResult>()
  const truth = async (row: Row): Promise<VerifySwapResult> => {
    const key = `${row.chain_id}|${row.tx_hash}|${row.wallet}`
    const cached = truthCache.get(key)
    if (cached) return cached
    // The row's own source is the DERIVED one; passed as the hint, it is the one the chain gave.
    const result = await verifySwapOnChain({ chainId: Number(row.chain_id), txHash: String(row.tx_hash), wallet: String(row.wallet), pending: [{ source: String(row.source) }] }, { read: recordedChainRead().read })
    truthCache.set(key, result)
    return result
  }

  state.db = createFakeSwapsDb()
  const stats = { post: 0, patch: 0, verified: 0, retired: 0, claims: 0, statuses: new Map<number, number>() }
  /** Details J's scratch row, as of `now`. */
  const isScratch = (r: Row, now: number) =>
    r.status === 'pending' && r.tx_hash === null && r.verified_at === null && (Date.parse(String(r.created_at)) >= now - 3_600_000 || r.claimed_tx_hash !== null)
  const allowed = new Set([200, 202, 400, 409, 422, 429])

  for (let n = 1; n <= total; n++) {
    const where = `seed ${seed}, request ${n}`
    const before = new Map(state.db.rows().map((r) => [String(r.id), JSON.stringify(r)]))
    const alertsBefore = state.alerts.length
    const verifiedBefore = new Set(state.db.rows().filter((r) => r.verified_at !== null).map((r) => String(r.id)))

    // ── Who, and about which transaction ──
    const claim = pick(all)
    const actor = rand()
    // honest: the wallet that made the swap. impersonator: an invented wallet's request naming the honest wallet.
    const named = actor < 0.5 ? claim.wallet : actor < 0.75 ? pick(invented) : pick(all).wallet
    const namedWallet = chance(0.2) ? `0x${named.slice(2).toUpperCase()}` : named
    const hash = chance(0.6) ? claim.fixture.hash : chance(0.5) ? pick(all).fixture.hash : inventedHash()
    const chainId = chance(0.85) ? claim.fixture.chainId : pick([1, 8453, 42161])
    const source = chance(0.7) ? claim.source : pick(SOURCES)

    const isPost = chance(0.5)
    let body: Row
    if (isPost) {
      stats.post++
      body = {
        wallet: namedWallet, chainId, source, tokenIn: pick(TOKENS), tokenInSymbol: mark('symbol'), tokenOut: pick(TOKENS), tokenOutSymbol: `<b>${mark('symbol')}</b>`,
        amountIn: `${DIGIT_MARK}${Math.floor(rand() * 1e6)}`, amountOut: `${Math.floor(rand() * 9) + 1}${DIGIT_MARK}`,
        amountInUsd: Number(`${DIGIT_MARK.slice(0, 5)}.${Math.floor(rand() * 99)}`), amountOutUsd: 31337.31337,
        slippage: chance(0.8) ? 0.5 : 3, mevProtected: chance(0.5), feeCollected: chance(0.5), feeAmount: `${DIGIT_MARK}`,
        status: pick(['pending', 'confirmed', 'failed', 'filled', mark('status')]), oracleUnavailable: chance(0.5), priceDeviation: 0.5,
        mevSavingsEstimate: DIGIT_MARK, mevSavingsActual: DIGIT_MARK, bestNonCowGasUsd: 313.37, expectedOutput: chance(0.5) ? `${DIGIT_MARK}` : undefined,
        txHash: chance(0.3) ? hash : undefined,
      }
    } else {
      stats.patch++
      body = {
        txHash: hash, wallet: chance(0.92) ? namedWallet : undefined, status: pick(['confirmed', 'failed', mark('status')]),
        gasUsed: DIGIT_MARK, gasPrice: DIGIT_MARK, mevSavingsEstimate: DIGIT_MARK, mevSavingsActual: DIGIT_MARK, tokenInSymbol: mark('symbol'), amountInUsd: 31337.31337,
      }
    }

    const res = await request(isPost ? 'POST' : 'PATCH', body)
    const text = await res.text()
    stats.statuses.set(res.status, (stats.statuses.get(res.status) ?? 0) + 1)

    // P5: the response.
    expect(allowed.has(res.status), `${where}: status ${res.status}`).toBe(true)
    expect(text.includes(MARK) || text.includes(DIGIT_MARK) || text.includes('31337'), `${where}: marker in response ${text}`).toBe(false)

    const rows = state.db.rows()
    const lowerNamed = typeof body.wallet === 'string' ? body.wallet.toLowerCase() : null

    // P4: only rows of the named wallet are created or changed.
    // CHANGED (133b I.2, I.4): "a PATCH creates none" is now "a request creates at most two rows, a PATCH at most one":
    // the transaction makes its own verified row when no pending row agrees, and a hash the chain has not got is kept on
    // a claim row (pending, no hash, no tokens) when no pending row can hold it.
    const created = rows.filter((row) => !before.has(String(row.id)))
    expect(created.length, `${where}: created ${created.length} rows`).toBeLessThanOrEqual(isPost ? 2 : 1)
    for (const row of rows) {
      const was = before.get(String(row.id))
      if (was === undefined) {
        expect(row.wallet, `${where}: created a row of another wallet`).toBe(lowerNamed)
        if (!isPost) expect(row.verified_at !== null || (row.token_in === null && row.claimed_tx_hash !== null), `${where}: a PATCH created a row that is neither verified nor a claim row`).toBe(true)
      } else if (was !== JSON.stringify(row)) {
        expect(row.wallet, `${where}: changed a row of another wallet (${String(row.id)})`).toBe(lowerNamed)
      }
    }
    // CHANGED (133b J): "no row ever disappears" is now "a row disappears only as a scratch row of the named wallet".
    const now = Date.now()
    const remaining = new Set(rows.map((r) => String(r.id)))
    for (const [id, text] of before) {
      if (remaining.has(id)) continue
      const gone = JSON.parse(text) as Row
      expect(String(gone.wallet), `${where}: a row of another wallet disappeared`).toBe(lowerNamed)
      expect(isScratch(gone, now), `${where}: a row that is not scratch disappeared ${text}`).toBe(true)
      stats.retired++
    }

    const seenTx = new Set<string>()
    const pendingPerWallet = new Map<string, number>()
    for (const row of rows) {
      const rowText = JSON.stringify(row)
      if (row.verified_at === null) {
        // P2
        expect(row.status, `${where}: unverified row ${String(row.id)} is not pending`).toBe('pending')
        expect(row.tx_hash, `${where}: unverified row carries a hash`).toBeNull()
        expect([row.amount_in_usd, row.amount_out_usd], `${where}: unverified row carries USD`).toEqual([null, null])
        expect(rowText.includes(MARK), `${where}: caller text in a pending row ${rowText}`).toBe(false)
        // CHANGED (133b J): P7 counts a wallet's scratch rows (at most 20); it counted its pending rows of the last hour (5).
        if (isScratch(row, now)) pendingPerWallet.set(String(row.wallet), (pendingPerWallet.get(String(row.wallet)) ?? 0) + 1)
        if (row.claimed_tx_hash !== null) stats.claims++
        continue
      }

      // P3. CHANGED (133b I.3, K): one transaction, one row PER WALLET (the key was chain and hash only).
      const key = `${row.chain_id}|${String(row.tx_hash).toLowerCase()}|${String(row.wallet).toLowerCase()}`
      expect(seenTx.has(key), `${where}: two verified rows for ${key}`).toBe(false)
      seenTx.add(key)

      // P1. Two columns of a verified row are the caller's by the owner's decision of 2026-11-25: slippage and
      // expected_output (validated numbers that feed no total, no alert and no log). Every other column is checked.
      expect(String(row.expected_output ?? ''), `${where}: expected_output is not digits`).toMatch(/^\d{0,78}$/)
      expect([0.5, 3], `${where}: slippage`).toContain(row.slippage)
      const derivedText = JSON.stringify({ ...row, expected_output: null, slippage: null })
      expect(derivedText.includes(MARK) || derivedText.includes(DIGIT_MARK) || derivedText.includes('31337'), `${where}: caller marker in a verified row ${rowText}`).toBe(false)
      const chain = await truth(row)
      expect(['confirmed', 'failed'], `${where}: the chain does not confirm verified row ${rowText}`).toContain(chain.outcome)
      const derived = chain.derived
      if (!derived) throw new Error(`${where}: no derived values for a verified row`)
      expect(row.status, where).toBe(chain.outcome)
      expect(row.verified_kind, where).toBe(chain.kind)
      expect([row.token_in, row.amount_in, row.token_out, row.amount_out], where).toEqual([derived.tokenIn, derived.amountIn, derived.tokenOut, derived.amountOut])
      expect(row.source, where).toBe(derived.source)
      expect(row.token_in_symbol, where).toBe(derived.tokenIn === null ? null : catalogSymbol(derived.tokenIn, Number(row.chain_id)))
      expect(row.token_out_symbol, where).toBe(derived.tokenOut === null ? null : catalogSymbol(derived.tokenOut, Number(row.chain_id)))
      const usd = (token: string | null, amount: string | null) => {
        if (token === null || amount === null) return null
        const value = oracleUsd(token === NATIVE_PLACEHOLDER ? WRAPPED[Number(row.chain_id)] : token, amount)
        return value === null ? null : Math.round(value * 100) / 100
      }
      expect([row.amount_in_usd, row.amount_out_usd], where).toEqual([usd(derived.tokenIn, derived.amountIn), usd(derived.tokenOut, derived.amountOut)])
      expect([row.gas_used, row.gas_price], where).toEqual([derived.gasUsed, derived.gasPrice])
      expect([row.fee_collected, row.is_gasless, row.mev_protected], where).toEqual([chain.kind === 'fee_collector', chain.kind === 'cow', chain.kind === 'cow'])
      expect([row.gas_savings_usd, row.mev_savings_estimate, row.mev_savings_actual, row.fee_amount], where).toEqual([0, null, null, null])
    }

    // P7
    for (const [wallet, count] of pendingPerWallet) expect(count, `${where}: ${wallet} has ${count} scratch rows`).toBeLessThanOrEqual(20)

    // P6: an alert only for a row this request verified, and from that row's values.
    const newlyVerified = rows.filter((r) => r.verified_at !== null && !verifiedBefore.has(String(r.id)))
    expect(newlyVerified.length, `${where}: one request verified more than one row`).toBeLessThanOrEqual(1)
    stats.verified += newlyVerified.length
    for (const alert of state.alerts.slice(alertsBefore)) {
      expect(newlyVerified.length, `${where}: an alert (${alert.tracker}) with no verification`).toBe(1)
      const row = newlyVerified[0]
      expect(alert.args.wallet, where).toBe(row.wallet)
      expect(JSON.stringify(alert.args).includes(MARK) || JSON.stringify(alert.args).includes('31337'), `${where}: caller marker in an alert`).toBe(false)
    }
  }

  // P5 again: the logs, and the wallet-activity tracker.
  for (const line of logged) expect(line.includes(MARK) || line.includes(DIGIT_MARK), `seed ${seed}: marker in log line ${line}`).toBe(false)
  for (const call of vi.mocked(trackWalletAction).mock.calls) {
    const args = JSON.stringify(call)
    expect(args.includes(MARK) || args.includes(DIGIT_MARK) || args.includes('31337'), `seed ${seed}: marker in a tracker call ${args}`).toBe(false)
  }
  return { ...stats, rows: state.db.rows().length }
}

describe('property: 1,000 seeded requests per seed', () => {
  it.each([133, 20261125])('seed %i', async (seed) => {
    const stats = await runSeed(seed, 1000)
    // Not vacuous: both verbs were sent, real swaps were verified, and every answer the route has was seen.
    expect(stats.post + stats.patch).toBe(1000)
    expect(stats.post).toBeGreaterThan(400)
    expect(stats.patch).toBeGreaterThan(400)
    expect(stats.verified).toBeGreaterThanOrEqual(10)
    // CHANGED (133b I.3, K): 409 left this list. One transaction now counts once per wallet, and a wallet's own repeat
    // answers 200, so 409 is left only for a write the unique index refuses while no verified row of this wallet is found.
    // CHANGED (133b J): 429 left this list too. The cap no longer refuses; only the per-IP limit answers 429, and it is
    // allowed here. In its place, the cap is shown to have worked: rows were retired, and claims were kept.
    for (const status of [200, 202, 422]) expect(stats.statuses.get(status) ?? 0, `status ${status} was answered`).toBeGreaterThan(0)
    expect(stats.statuses.get(429) ?? 0).toBe(0)
    expect(stats.retired).toBeGreaterThan(0)
    expect(stats.claims).toBeGreaterThan(0)
    // SWAP_PROPERTY_DUMP=/abs/dir writes what the run did (for the feedback tables).
    if (process.env.SWAP_PROPERTY_DUMP) {
      writeFileSync(join(process.env.SWAP_PROPERTY_DUMP, `property-seed-${seed}.json`), `${JSON.stringify({ seed, ...stats, statuses: Object.fromEntries(stats.statuses) })}\n`)
    }
  }, 120_000)
})
