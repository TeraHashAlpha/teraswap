// @vitest-environment node
/**
 * [ADR-029, details C] PATCH /api/log-swap end to end: the REAL route, the REAL verification and chain read, a stub RPC
 * that serves recorded real transactions (src/test-utils/stub-chain-rpc.ts) and the fake database.
 * Only the oracle is replaced, by a fixed price table, so every USD below can be checked by hand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => {
  // A throwaway salt, so the rate limiter's one-time "salt not set" warning is not among the captured log lines.
  process.env.RATE_LIMIT_SALT = 'test-only-salt-0123456789-abcdefghijklmnop'
  delete process.env.NEXT_PUBLIC_FEE_COLLECTOR
  process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  return {
    db: null as unknown as import('@/test-utils/fake-swaps-db').FakeSwapsDb,
    /** token (lowercase) -> [USD price, decimals]. A token that is not here has no oracle price. */
    prices: {} as Record<string, [number, number]>,
    priced: [] as Array<{ token: string; amount: string; chainId: number }>,
  }
})

vi.mock('@/lib/supabase', () => ({ getSupabase: () => state.db.service, getSupabaseLogger: () => state.db.logger }))
vi.mock('@/lib/chainlink', () => ({
  computeTokenAmountUsd: vi.fn(async (token: string, amount: string, chainId: number) => {
    state.priced.push({ token: token.toLowerCase(), amount, chainId })
    const entry = state.prices[token.toLowerCase()]
    if (!entry) return null
    const [price, decimals] = entry
    return { usd: (Number(BigInt(amount)) / 10 ** decimals) * price, price, decimals }
  }),
}))
vi.mock('@/lib/wallet-activity-server', () => ({ trackWalletAction: vi.fn() }))
vi.mock('@/lib/security-tracker', () => ({
  trackLargeTrade: vi.fn(),
  trackSwapFailed: vi.fn(),
  trackOracleDeviation: vi.fn(),
  trackOracleUnavailable: vi.fn(),
}))
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  const allow = vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 }))
  return { ...actual, checkRateLimit: allow, checkRateLimitWithin: allow }
})

import { FORK_RECEIPTS, SWAP_RECEIPTS as R, type SwapReceiptFixture } from '@/lib/__fixtures__/swap-receipts'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'
import { trackLargeTrade, trackOracleDeviation, trackOracleUnavailable, trackSwapFailed } from '@/lib/security-tracker'
import { MIGRATION_COLUMNS, _resetVerifiedColumnsCache } from '@/lib/swap-log/store'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import { createFakeSwapsDb, type Row } from '@/test-utils/fake-swaps-db'
import { installStubChainRpc } from '@/test-utils/stub-chain-rpc'
import { PATCH, POST } from './route'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const BASE_WETH = '0x4200000000000000000000000000000000000006'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ATTACKER = '0x00000000000000000000000000000000000000aa'
const XSS = '<img src=x onerror=alert(1)>'

const sender = (f: SwapReceiptFixture) => String(f.tx.from).toLowerCase()
const json = (method: 'POST' | 'PATCH', body: unknown) =>
  new NextRequest('http://localhost/api/log-swap', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const patch = (body: unknown) => PATCH(json('PATCH', body))
const post = (body: unknown) => POST(json('POST', body))

/** A pending row as POST writes it: what the caller DECLARED, which a verification must replace. */
function pendingRow(wallet: string, overrides: Row = {}): Row {
  return {
    id: `row-${Math.random().toString(16).slice(2)}`,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    wallet: wallet.toLowerCase(),
    tx_hash: null,
    chain_id: 1,
    status: 'pending',
    source: 'velora',
    token_in: WETH,
    token_in_symbol: 'WETH',
    token_out: USDC,
    token_out_symbol: 'USDC',
    // Declared: 500 WETH for 1.7 million USDC. None of it may survive a verification.
    amount_in: '500000000000000000000',
    amount_out: '1700000000000',
    amount_in_usd: null,
    amount_out_usd: null,
    slippage: 0.5,
    mev_protected: true,
    fee_collected: false,
    fee_amount: null,
    gas_used: null,
    gas_price: null,
    mev_savings_estimate: null,
    mev_savings_actual: null,
    is_gasless: true,
    gas_savings_usd: 499,
    expected_output: '1700000000000',
    verified_at: null,
    verified_kind: null,
    ...overrides,
  }
}

let rpc: ReturnType<typeof installStubChainRpc>
let logged: string[] = []
const rows = () => state.db.rows()
const rowOf = (wallet: string) => rows().filter((r) => r.wallet === wallet.toLowerCase())

beforeEach(() => {
  for (const name of ['RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL']) delete process.env[name]
  state.db = createFakeSwapsDb()
  state.prices = { [USDC]: [1, 6], [USDT]: [1, 6], [WETH]: [3400, 18], [DAI]: [1, 18], [BASE_WETH]: [3400, 18], [BASE_USDC]: [1, 6] }
  state.priced = []
  _resetVerifiedColumnsCache()
  __resetChainIdentityCache()
  vi.clearAllMocks()
  rpc = installStubChainRpc()
  logged = []
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' '))
    })
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a real swap is confirmed by the server, from the chain', () => {
  it('FeeCollector swap on Ethereum: status, hash, kind, derived tokens, amounts, symbols, USD and gas in ONE update', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    const res = await patch({ txHash: f.hash, wallet: String(f.tx.from) })
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])

    const [row] = rows()
    expect(row).toMatchObject({
      status: 'confirmed',
      tx_hash: f.hash.toLowerCase(),
      verified_kind: 'fee_collector',
      source: 'velora',
      token_in: '0x5086bf358635b81d8c47c66d1c8b9e567db70c72',
      token_out: USDC,
      token_out_symbol: 'USDC',
      amount_in: '46080134130180921522',
      amount_out: '51012637',
      // The oracle table has no price for the sold token: its USD is null, never the declared amount priced.
      amount_in_usd: null,
      // 51012637 / 10^6 * 1 USD
      amount_out_usd: 51.01,
      gas_used: BigInt(String(f.receipt.gasUsed)).toString(),
      gas_price: BigInt(String(f.receipt.effectiveGasPrice)).toString(),
      fee_collected: true,
      fee_amount: null,
      is_gasless: false,
      mev_protected: false,
      gas_savings_usd: 0,
      mev_savings_estimate: null,
      mev_savings_actual: null,
      // Not derived, not public: kept from the pending row.
      slippage: 0.5,
      expected_output: '1700000000000',
    })
    expect(typeof row.verified_at).toBe('string')
    expect(Date.parse(String(row.verified_at))).toBeGreaterThan(Date.now() - 60_000)
    // Nothing the caller declared is left.
    expect(JSON.stringify(row)).not.toContain('500000000000000000000')
    expect(row.token_in).not.toBe(WETH)

    // ONE update, by id AND wallet, only while unverified.
    const updates = state.db.ops.filter((o) => o.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].role).toBe('service')
    expect(updates[0].filters).toEqual([`id=eq.${row.id}`, `wallet=eq.${sender(f)}`, 'verified_at=is.null'])
  })

  it('what the caller says in the PATCH body (status, gas, mev figures) is not read', async () => {
    const f = R.mainnetFcTokenToEth
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    const res = await patch({
      txHash: f.hash, wallet: sender(f), status: 'failed', gasUsed: '1', gasPrice: '2',
      mevSavingsEstimate: '31337', mevSavingsActual: '31337', amountInUsd: 9e9, tokenOutSymbol: XSS,
    })
    expect(res.status).toBe(200)
    const [row] = rows()
    expect(row).toMatchObject({
      status: 'confirmed',
      token_out: NATIVE,
      token_out_symbol: 'ETH',
      amount_out: '50428014210987008',
      // Native ETH is priced as the chain's wrapped native: 0.050428014210987008 * 3400
      amount_out_usd: 171.46,
      mev_savings_estimate: null,
      mev_savings_actual: null,
    })
    expect(row.gas_used).toBe(BigInt(String(f.receipt.gasUsed)).toString())
    expect(state.priced).toContainEqual({ token: WETH, amount: '50428014210987008', chainId: 1 })
    expect(JSON.stringify(row)).not.toContain('31337')
  })

  it('the caller says confirmed, the chain says reverted: the row is failed, with no token, amount or USD', async () => {
    const f = R.mainnetRouterReverted
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { source: '0x' })] })
    const res = await patch({ txHash: f.hash, wallet: sender(f), status: 'confirmed' })
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(rows()[0]).toMatchObject({
      status: 'failed', verified_kind: 'router', tx_hash: f.hash.toLowerCase(),
      token_in: null, token_in_symbol: null, token_out: null, token_out_symbol: null,
      amount_in: null, amount_out: null, amount_in_usd: null, amount_out_usd: null,
    })
    expect(trackSwapFailed).toHaveBeenCalledTimes(1)
    expect(trackSwapFailed).toHaveBeenCalledWith({ wallet: sender(f), tokenIn: '', tokenOut: '', amountUsd: 0, source: '0x', error: 'Transaction reverted' })
    expect(trackLargeTrade).not.toHaveBeenCalled()
  })

  it('CoW swap settled through a solver\'s contract: kind cow, gasless and mev flags derived from the kind', async () => {
    const f = R.mainnetCowViaSolver
    const owner = '0x2a426b6b4589a3a44a053da440c45ff41e16f52c'
    state.db = createFakeSwapsDb({ swaps: [pendingRow(owner, { source: 'cowswap', fee_collected: true, mev_protected: false, is_gasless: false })] })
    expect((await patch({ txHash: f.hash, wallet: owner })).status).toBe(200)
    expect(rows()[0]).toMatchObject({
      status: 'confirmed', verified_kind: 'cow', source: 'cowswap',
      token_in: DAI, token_in_symbol: 'DAI', amount_in: '25061937000000000098304', amount_in_usd: 25061.94,
      token_out: USDC, token_out_symbol: 'USDC', amount_out: '25062027165', amount_out_usd: 25062.03,
      fee_collected: false, is_gasless: true, mev_protected: true, gas_savings_usd: 0,
    })
  })

  it('a side the receipt can not give is stored NULL (Base, 0x, token to ETH), and its USD is null', async () => {
    const f = R.baseRouterTokenToEth
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { chain_id: 8453, source: '0x', token_out: NATIVE, token_out_symbol: 'ETH' })] })
    expect((await patch({ txHash: f.hash, wallet: sender(f) })).status).toBe(200)
    expect(rows()[0]).toMatchObject({
      status: 'confirmed', verified_kind: 'router', chain_id: 8453,
      token_in: '0xe43df70a3a8067680aae799fa5171c3f473b46ed', token_in_symbol: '0xe43d...46ed', amount_in: '5680910050800089169920',
      token_out: null, token_out_symbol: null, amount_out: null, amount_out_usd: null,
    })
  })

  it('the source of a FeeCollector row is the one the FeeCollector call names (Base: declared kyberswap, called Uniswap)', async () => {
    const f = R.baseFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { chain_id: 8453, source: 'kyberswap' })] })
    expect((await patch({ txHash: f.hash, wallet: sender(f) })).status).toBe(200)
    expect(rows()[0]).toMatchObject({ source: 'uniswapv3', verified_kind: 'fee_collector', token_in: BASE_WETH, token_in_symbol: 'WETH', amount_in_usd: 850 })
  })
})

describe('row choice: that wallet\'s row with that hash, else that wallet\'s latest pending row of the last two hours', () => {
  it('never a row of another wallet: a caller with no row of its own changes nothing and reads nothing', async () => {
    const f = R.mainnetFcTokenToToken
    const victim = pendingRow(sender(f))
    state.db = createFakeSwapsDb({ swaps: [victim] })
    const before = JSON.stringify(rows())
    // The attacker names its own wallet and a real transaction of the victim.
    const res = await patch({ txHash: f.hash, wallet: ATTACKER, status: 'confirmed' })
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(JSON.stringify(rows())).toBe(before)
    expect(state.db.ops.filter((o) => o.kind === 'update')).toEqual([])
    expect(rpc.reads()).toEqual([])
  })

  it('a caller that names the victim\'s wallet with an invented hash: 202, the victim\'s row is unchanged', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    const before = JSON.stringify(rows())
    for (const hash of [`0x${'11'.repeat(32)}`, `0x${'aa'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'bb'.repeat(32)}`]) {
      const res = await patch({ txHash: hash, wallet: sender(f), status: 'confirmed' })
      expect([res.status, await res.json()]).toEqual([202, { ok: false, outcome: 'not_found' }])
    }
    expect(JSON.stringify(rows())).toBe(before)
    expect(state.db.ops.filter((o) => o.kind === 'update')).toEqual([])
  })

  it('a caller that names the victim\'s wallet with ANOTHER wallet\'s real swap: 422, the victim\'s row is unchanged', async () => {
    const victimTx = R.mainnetFcTokenToToken
    const strangersTx = R.mainnetFcEthToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(victimTx))] })
    const before = JSON.stringify(rows())
    const res = await patch({ txHash: strangersTx.hash, wallet: sender(victimTx) })
    expect([res.status, await res.json()]).toEqual([422, { error: 'Transaction not accepted for this swap' }])
    expect(JSON.stringify(rows())).toBe(before)
    // CHANGED (133b H.1): the reason was `wrong_sender`. A call to the FeeCollector with no SwapWithFee of this wallet is
    // `no_swap_event`.
    expect(logged).toEqual(['[log-swap] verification rejected reason=no_swap_event chain=1'])
  })

  it('the latest pending row of the wallet is the one confirmed; older ones stay pending', async () => {
    const f = R.mainnetFcTokenToToken
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
    state.db = createFakeSwapsDb({
      swaps: [
        pendingRow(sender(f), { id: 'oldest', created_at: at(90) }),
        pendingRow(sender(f), { id: 'latest', created_at: at(1) }),
        pendingRow(sender(f), { id: 'middle', created_at: at(30) }),
        pendingRow(ATTACKER, { id: 'someone-else', created_at: at(0) }),
      ],
    })
    expect((await patch({ txHash: f.hash, wallet: sender(f) })).status).toBe(200)
    const status = Object.fromEntries(rows().map((r) => [r.id, r.status]))
    expect(status).toEqual({ oldest: 'pending', latest: 'confirmed', middle: 'pending', 'someone-else': 'pending' })
  })

  it('a pending row older than two hours is not matched: 200, nothing read, nothing written', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { created_at: new Date(Date.now() - 121 * 60_000).toISOString() })] })
    const res = await patch({ txHash: f.hash, wallet: sender(f) })
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(rows()[0].status).toBe('pending')
    expect(rpc.reads()).toEqual([])
  })

  it('a row that is not pending (a failed one, a row with another hash) is not matched by the fallback', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({
      swaps: [
        pendingRow(sender(f), { id: 'failed', status: 'failed' }),
        pendingRow(sender(f), { id: 'other-hash', tx_hash: `0x${'cd'.repeat(32)}` }),
      ],
    })
    expect((await patch({ txHash: f.hash, wallet: sender(f) })).status).toBe(200)
    expect(rows().map((r) => r.verified_at)).toEqual([null, null])
    expect(rpc.reads()).toEqual([])
  })

  it('an old row that already carries the hash (written by the code before this change) is verified in place, and corrected', async () => {
    const f = R.mainnetFcTokenToToken
    // As main stored it: the caller's status, hash, symbols and a USD priced from the DECLARED 500 WETH.
    state.db = createFakeSwapsDb({
      swaps: [pendingRow(sender(f), { status: 'confirmed', tx_hash: `0x${f.hash.slice(2).toUpperCase()}`, amount_in_usd: 1_700_000, token_in_symbol: XSS, created_at: '2026-11-20T09:25:00.000Z' })],
    })
    expect((await patch({ txHash: f.hash, wallet: sender(f) })).status).toBe(200)
    expect(rows()[0]).toMatchObject({ status: 'confirmed', verified_kind: 'fee_collector', tx_hash: f.hash.toLowerCase(), amount_in: '46080134130180921522', amount_in_usd: null })
    expect(JSON.stringify(rows()[0])).not.toContain('onerror')
  })
})

describe('the row is unchanged when the chain does not confirm it', () => {
  it('not found (the node does not have the transaction yet): 202', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    vi.unstubAllGlobals()
    rpc = installStubChainRpc({ fixtures: [] })
    const before = JSON.stringify(rows())
    const res = await patch({ txHash: f.hash, wallet: sender(f) })
    expect([res.status, await res.json()]).toEqual([202, { ok: false, outcome: 'not_found' }])
    expect(JSON.stringify(rows())).toBe(before)
    expect(vi.mocked(trackWalletAction)).not.toHaveBeenCalled()
    // Asked twice, never a third time.
    expect(rpc.reads().map((r) => r.method)).toEqual(['eth_getTransactionByHash', 'eth_getTransactionByHash'])
  })

  // The browser sends its confirmation once, right after it saw the receipt. A provider's node that is one block
  // behind answers null: the one retry finds it, and the swap is not left pending for ever.
  it.each([
    ['the transaction', 'eth_getTransactionByHash', ['eth_getTransactionByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']],
    ['the receipt', 'eth_getTransactionReceipt', ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getTransactionReceipt']],
  ])('a node that had not caught up: %s is null on the first asking, there on the second -> 200, verified', async (_name, method, reads) => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    vi.unstubAllGlobals()
    let asked = 0
    rpc = installStubChainRpc({ override: (c) => (c.method === method && ++asked === 1 ? null : undefined) })
    const res = await patch({ txHash: f.hash, wallet: sender(f) })
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(rows()[0]).toMatchObject({ status: 'confirmed', tx_hash: f.hash.toLowerCase(), verified_kind: 'fee_collector' })
    expect(rows()[0].verified_at).not.toBeNull()
    expect(rpc.reads().map((r) => r.method)).toEqual(reads)
  })

  it.each([
    ['the RPC answers 503 on every attempt', { fail: () => true }],
    ['the endpoint says it is another chain', { reportedChainId: () => 8453 }],
    ['the receipt has an unknown status', { override: (c: { method: string }) => (c.method === 'eth_getTransactionReceipt' ? { ...R.mainnetFcTokenToToken.receipt, status: '0x7' } : undefined) }],
    ['the receipt is not there yet', { override: (c: { method: string }) => (c.method === 'eth_getTransactionReceipt' ? null : undefined) }],
  ])('fail closed: %s -> 202, nothing written', async (_name, options) => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    vi.unstubAllGlobals()
    rpc = installStubChainRpc(options as never)
    const before = JSON.stringify(rows())
    const res = await patch({ txHash: f.hash, wallet: sender(f) })
    expect(res.status).toBe(202)
    expect(JSON.stringify(rows())).toBe(before)
    expect(state.db.ops.filter((o) => o.kind === 'update')).toEqual([])
    expect(trackLargeTrade).not.toHaveBeenCalled()
  })

  it('rejected: 422 and ONE log line with the reason, in fixed words', async () => {
    // CHANGED (133b H): this test used a real 0x swap under a row that said 1inch ("not 1inch's router", wrong_target).
    // The source is no longer the caller's to name: that swap now verifies as 0x. A rejection the chain still gives: a
    // successful call to Base's FeeCollector that is not a swap (a getter), by this wallet.
    const f = FORK_RECEIPTS.baseFcGetter
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { chain_id: 8453, source: '1inch', token_in_symbol: XSS })] })
    const res = await patch({ txHash: f.hash, wallet: sender(f), status: `confirmed\n${XSS}` })
    expect([res.status, await res.json()]).toEqual([422, { error: 'Transaction not accepted for this swap' }])
    expect(rows()[0].status).toBe('pending')
    expect(logged).toEqual(['[log-swap] verification rejected reason=no_swap_event chain=8453'])
  })
})

describe('one transaction, one row', () => {
  it('a second PATCH of the same wallet and transaction answers 200, reads nothing and changes nothing', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f)), pendingRow(sender(f), { id: 'older', created_at: new Date(Date.now() - 600_000).toISOString() })] })
    expect((await patch({ txHash: f.hash, wallet: sender(f) })).status).toBe(200)
    const after = JSON.stringify(rows())
    rpc.reset()
    // The browser sends a second PATCH for the same swap (SwapBox.tsx:413, with the mev figures).
    const again = await patch({ txHash: f.hash, wallet: sender(f), status: 'confirmed', mevSavingsEstimate: '5', mevSavingsActual: '6' })
    expect([again.status, await again.json()]).toEqual([200, { ok: true }])
    expect(JSON.stringify(rows())).toBe(after)
    expect(rpc.reads()).toEqual([])
    expect(rows().filter((r) => r.verified_at !== null)).toHaveLength(1)
  })

  it('two PATCHes of one swap arriving together: both 200, one row verified, the older pending row untouched', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { id: 'this-swap' }), pendingRow(sender(f), { id: 'older', created_at: new Date(Date.now() - 600_000).toISOString() })] })
    const [a, b] = await Promise.all([patch({ txHash: f.hash, wallet: sender(f) }), patch({ txHash: f.hash, wallet: sender(f) })])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(Object.fromEntries(rows().map((r) => [r.id, r.status]))).toEqual({ 'this-swap': 'confirmed', older: 'pending' })
  })

  it('a transaction that already verified ANOTHER wallet\'s row: the second wallet\'s trade in it is verified too', async () => {
    // One CoW settlement with two wallets' trades: one transaction counts once PER WALLET (ADR-029 7.4, A103 S-6).
    const f = R.mainnetCowTwoOwners
    const first = '0x0e269d0c3941077dee8e7be50899e3b10eae35b6'
    const second = '0xb5378cf59f35e6e8bf5679ec6c22d1c5ff912433'
    state.db = createFakeSwapsDb({ swaps: [pendingRow(first, { source: 'cowswap' }), pendingRow(second, { source: 'cowswap' })] })
    expect((await patch({ txHash: f.hash, wallet: first })).status).toBe(200)
    rpc.reset()
    const res = await patch({ txHash: f.hash, wallet: second })
    // CHANGED (133b I.3, K): was 409 "Transaction already recorded", no chain read, the second wallet's row still pending.
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(rpc.reads().map((c) => c.method)).toEqual(['eth_getTransactionByHash', 'eth_getTransactionReceipt'])
    expect(rowOf(first)[0]).toMatchObject({ status: 'confirmed', verified_kind: 'cow', token_in: WETH })
    expect(rowOf(second)[0]).toMatchObject({ status: 'confirmed', verified_kind: 'cow', token_in: USDT })
  })

  it('the same two wallets at once: both verified, one row each (the unique key includes the wallet)', async () => {
    const f = R.mainnetCowTwoOwners
    const first = '0x0e269d0c3941077dee8e7be50899e3b10eae35b6'
    const second = '0xb5378cf59f35e6e8bf5679ec6c22d1c5ff912433'
    state.db = createFakeSwapsDb({ swaps: [pendingRow(first, { source: 'cowswap' }), pendingRow(second, { source: 'cowswap' })] })
    const [a, b] = await Promise.all([patch({ txHash: f.hash, wallet: first }), patch({ txHash: f.hash, wallet: second })])
    // CHANGED (133b I.3, K): was [200, 409] with one verified row: the database index refused the second wallet.
    expect([a.status, b.status]).toEqual([200, 200])
    expect(rows().filter((r) => r.verified_at !== null)).toHaveLength(2)
    expect(rows().filter((r) => r.status === 'pending')).toHaveLength(0)
  })

  it('the hash is matched without regard to letter case, on the row\'s chain only', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    expect((await patch({ txHash: `0x${f.hash.slice(2).toUpperCase()}`, wallet: `0x${sender(f).slice(2).toUpperCase()}` })).status).toBe(200)
    expect(rows()[0]).toMatchObject({ status: 'confirmed', tx_hash: f.hash.toLowerCase(), wallet: sender(f) })
    // The same hash named for a row on Base: Base has no such transaction.
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { chain_id: 8453 })] })
    rpc.reset()
    expect((await patch({ txHash: f.hash, wallet: sender(f) })).status).toBe(202)
    // Asked on Base and nowhere else; "no such transaction" is asked once more before it is the answer (chain-read.ts).
    const baseRead = { chainId: 8453, method: 'eth_getTransactionByHash', hash: f.hash.toLowerCase() }
    expect(rpc.reads()).toEqual([baseRead, baseRead])
  })
})

describe('trackers run after a confirmation, from derived values', () => {
  it('a small confirmed swap: one wallet-activity line with the verified hash and the derived USD; no alert', async () => {
    const f = R.mainnetRouterTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { source: '0x' })] })
    await patch({ txHash: f.hash, wallet: sender(f) })
    expect(trackWalletAction).toHaveBeenCalledTimes(1)
    expect(trackWalletAction).toHaveBeenCalledWith(sender(f), {
      category: 'swap', action: 'swap_status_update', source: '0x', tokenIn: 'USDC', tokenOut: 'USDT',
      amountUsd: 101.94, success: true, txHash: f.hash.toLowerCase(), metadata: { status: 'confirmed', kind: 'router' },
    })
    expect(trackLargeTrade).not.toHaveBeenCalled()
    expect(trackOracleDeviation).not.toHaveBeenCalled()
    expect(trackOracleUnavailable).not.toHaveBeenCalled()
  })

  it('large trade: fired from the DERIVED amount at the server\'s price, with catalog symbols', async () => {
    const f = R.mainnetCowViaSolver
    const owner = '0x2a426b6b4589a3a44a053da440c45ff41e16f52c'
    // 25,061.937 DAI. At 1 USD it is below 50,000; at 2 USD it is above.
    state.db = createFakeSwapsDb({ swaps: [pendingRow(owner, { source: 'cowswap' })] })
    await patch({ txHash: f.hash, wallet: owner })
    expect(trackLargeTrade).not.toHaveBeenCalled()

    state.db = createFakeSwapsDb({ swaps: [pendingRow(owner, { source: 'cowswap', token_in_symbol: XSS })] })
    state.prices[DAI] = [2, 18]
    state.prices[USDC] = [2, 6]
    vi.clearAllMocks()
    await patch({ txHash: f.hash, wallet: owner })
    expect(trackLargeTrade).toHaveBeenCalledTimes(1)
    expect(trackLargeTrade).toHaveBeenCalledWith({ wallet: owner, tokenIn: 'DAI', tokenOut: 'USDC', amountUsd: 50123.87, source: 'cowswap' })
  })

  it('a DECLARED 500 WETH never fires the large-trade alert: only what the receipt shows is priced', async () => {
    const f = R.mainnetFcEthToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { source: 'kyberswap' })] })
    await patch({ txHash: f.hash, wallet: sender(f) })
    // The receipt shows 0.05 ETH: 170 USD.
    expect(rows()[0]).toMatchObject({ amount_in: '50000000000000000', amount_in_usd: 170, amount_out_usd: 169.83 })
    expect(trackLargeTrade).not.toHaveBeenCalled()
    expect(state.priced.map((p) => p.amount)).toEqual(['50000000000000000', '49950000000000000'])
  })

  it('oracle unavailable: a derived side the oracle can not price', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    await patch({ txHash: f.hash, wallet: sender(f) })
    expect(trackOracleUnavailable).toHaveBeenCalledTimes(1)
    expect(trackOracleUnavailable).toHaveBeenCalledWith({ wallet: sender(f), tokenIn: '0x5086...0c72', tokenOut: 'USDC', amountUsd: 51.01, blocked: false })
  })

  it('oracle deviation: both sides priced and at least 2% apart', async () => {
    const f = R.mainnetRouterTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { source: '0x' })] })
    state.prices[USDT] = [0.9, 6]
    await patch({ txHash: f.hash, wallet: sender(f) })
    expect(trackOracleDeviation).toHaveBeenCalledTimes(1)
    const call = vi.mocked(trackOracleDeviation).mock.calls[0][0]
    expect(call).toMatchObject({ wallet: sender(f), tokenIn: 'USDC', tokenOut: 'USDT', amountUsd: 101.94, blocked: false })
    // in 101.94 USD, out 102.059274 * 0.9 = 91.85 USD
    expect(call.deviation).toBeCloseTo((101.94 - 91.85) / 101.94, 6)
  })

  it('no tracker runs for a PATCH that confirmed nothing', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    await patch({ txHash: `0x${'11'.repeat(32)}`, wallet: sender(f) })
    await patch({ txHash: R.mainnetFcEthToToken.hash, wallet: sender(f) })
    await patch({ txHash: f.hash, wallet: ATTACKER })
    for (const tracker of [trackWalletAction, trackLargeTrade, trackOracleDeviation, trackOracleUnavailable, trackSwapFailed]) expect(tracker).not.toHaveBeenCalled()
  })
})

describe('what one confirmation costs in chain reads', () => {
  it('two reads on the row\'s chain (the transaction, its receipt), plus one chain-id proof per endpoint per process', async () => {
    const a = R.mainnetFcTokenToToken
    const b = R.mainnetFcEthToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(a)), pendingRow(sender(b), { source: 'kyberswap' })] })
    await patch({ txHash: a.hash, wallet: sender(a) })
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'])
    rpc.reset()
    await patch({ txHash: b.hash, wallet: sender(b) })
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_getTransactionByHash', 'eth_getTransactionReceipt'])
    expect(rpc.calls.every((c) => c.chainId === 1)).toBe(true)
  })

  it('a Base row is read on Base and an Arbitrum row on Arbitrum', async () => {
    const base = R.baseFcEthToToken
    const arb = R.arbitrumFcTokenToEth
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(base), { chain_id: 8453 }), pendingRow(sender(arb), { chain_id: 42161, source: 'kyberswap' })] })
    expect((await patch({ txHash: base.hash, wallet: sender(base) })).status).toBe(200)
    expect(new Set(rpc.calls.map((c) => c.chainId))).toEqual(new Set([8453]))
    rpc.reset()
    expect((await patch({ txHash: arb.hash, wallet: sender(arb) })).status).toBe(200)
    expect(new Set(rpc.calls.map((c) => c.chainId))).toEqual(new Set([42161]))
    expect(rows().map((r) => [r.chain_id, r.status, r.verified_kind])).toEqual([[8453, 'confirmed', 'fee_collector'], [42161, 'confirmed', 'fee_collector']])
  })
})

describe('the request itself', () => {
  it('no hash: 400 "txHash is required", as before; a malformed hash or wallet: 400', async () => {
    expect([(await patch({ wallet: ATTACKER })).status, await (await patch({ wallet: ATTACKER })).json()]).toEqual([400, { error: 'txHash is required' }])
    expect(await (await patch({ txHash: '0x1234', wallet: ATTACKER })).json()).toEqual({ error: 'Invalid txHash' })
    expect(await (await patch({ txHash: `0x${'ab'.repeat(32)}`, wallet: 'me' })).json()).toEqual({ error: 'Invalid wallet' })
    expect((await patch([1])).status).toBe(400)
    expect(state.db.ops).toEqual([])
    expect(rpc.calls).toEqual([])
  })

  it('no wallet (the browser\'s call after the wallet disconnected): 200 { ok: true }, nothing read, nothing written', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    const res = await patch({ txHash: f.hash, status: 'confirmed' })
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(state.db.ops).toEqual([])
    expect(rpc.calls).toEqual([])
    expect(rows()[0].status).toBe('pending')
  })

  it('every row lookup of a PATCH is scoped to the wallet it names, the one-transaction check included', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f)), pendingRow(ATTACKER)] })
    await patch({ txHash: f.hash, wallet: sender(f) })
    const lookups = state.db.ops.filter((o) => o.kind === 'select' && o.table === 'swaps' && o.detail !== MIGRATION_COLUMNS)
    expect(lookups.length).toBeGreaterThanOrEqual(3)
    const acrossWallets = lookups.filter((o) => !o.filters.includes(`wallet=eq.${sender(f)}`))
    // CHANGED (133b I.3, K): the duplicate check was the one lookup across wallets (by chain and hash); one transaction
    // now counts once PER WALLET, so it is scoped to the wallet like every other lookup.
    expect(acrossWallets).toEqual([])
    const duplicate = lookups.find((o) => o.detail === 'id, wallet')
    expect(duplicate?.filters).toEqual([`wallet=eq.${sender(f)}`, 'chain_id=eq.1', `tx_hash=ilike.${f.hash.toLowerCase()}`, 'verified_at=not.is.null', expect.stringMatching(/^id=neq\./), 'limit=1'])
    // The fallback lookup: that wallet, pending, no hash, unverified, inside the two-hour window, newest first, one row.
    const fallback = lookups.find((o) => o.filters.includes('status=eq.pending'))
    expect(fallback?.filters).toEqual([
      `wallet=eq.${sender(f)}`, 'status=eq.pending', 'tx_hash=is.null', 'verified_at=is.null', expect.stringMatching(/^created_at=gte\.\d{4}-/), 'order=created_at.desc', 'limit=1',
    ])
  })

  it('PATCH never uses the insert-only logger client', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f))] })
    await patch({ txHash: f.hash, wallet: sender(f) })
    expect(state.db.ops.every((o) => o.role === 'service')).toBe(true)
  })
})

describe('a hash sent with POST (the split-swap client) is handled as a PATCH after the insert', () => {
  const body = (f: SwapReceiptFixture, overrides: Row = {}) => ({
    wallet: String(f.tx.from), chainId: f.chainId, source: 'velora', tokenIn: WETH, tokenInSymbol: 'WETH', tokenOut: USDC, tokenOutSymbol: 'USDC',
    amountIn: '500000000000000000000', amountOut: '1700000000000', slippage: 0.5, mevProtected: false, feeCollected: true,
    status: 'confirmed', txHash: f.hash, ...overrides,
  })

  it('a real leg: the row it inserted is confirmed from the chain; the answer is 200 { ok: true }', async () => {
    const f = R.mainnetFcTokenToToken
    const res = await post(body(f))
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ status: 'confirmed', verified_kind: 'fee_collector', tx_hash: f.hash.toLowerCase(), amount_in: '46080134130180921522', amount_out: '51012637' })
    expect(state.db.ops.filter((o) => o.kind === 'insert').map((o) => o.role)).toEqual(['logger'])
    expect((state.db.ops.find((o) => o.kind === 'insert')?.detail as Row).tx_hash).toBeNull()
  })

  it('an invented hash with status confirmed: a pending row with NO hash; the answer is still 200 { ok: true }', async () => {
    const f = R.mainnetFcTokenToToken
    const res = await post(body(f, { txHash: `0x${'11'.repeat(32)}` }))
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(rows()[0]).toMatchObject({ status: 'pending', tx_hash: null, verified_at: null, amount_in_usd: null })
  })

  it('the leg confirms the row IT inserted, not an older pending row of the wallet', async () => {
    const f = R.mainnetFcTokenToToken
    state.db = createFakeSwapsDb({ swaps: [pendingRow(sender(f), { id: 'older', created_at: new Date(Date.now() - 30_000).toISOString() })] })
    await post(body(f))
    expect(rows().find((r) => r.id === 'older')?.status).toBe('pending')
    expect(rows().filter((r) => r.status === 'confirmed')).toHaveLength(1)
  })

  it('a repeat of a leg already verified adds no row', async () => {
    const f = R.mainnetFcTokenToToken
    await post(body(f))
    await post(body(f))
    await post(body(f))
    expect(rows()).toHaveLength(1)
  })
})
