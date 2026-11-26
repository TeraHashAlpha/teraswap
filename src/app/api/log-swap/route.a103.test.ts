// @vitest-environment node
/**
 * [goal 133b details M] The audit A103 findings S-1 to S-6 and S-8, end to end through the REAL route as the official
 * client drives it (POST when the user submits, PATCH with the chain when the transaction confirmed), the REAL
 * verification and chain read, a stub RPC serving recorded transactions (real ones, and local-fork ones for S-1, S-2 and
 * S-5), the fake database, and two public readers (/api/stats, /api/analytics). Only the oracle is a fixed table.
 *
 * Failing first: this file runs unchanged on 09ddf974 (the audited head) with the branch's test utilities and fixtures
 * copied in; every S-1 to S-6 case below fails there (docs/feedback/…tables.md, section R1). S-8 passed there too: it
 * is a test of the chain-awareness that had no test (A103), proved by the mutant that looks a router up on chain 1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => {
  process.env.TZ = 'UTC'
  process.env.RATE_LIMIT_SALT = 'test-only-salt-0123456789-abcdefghijklmnop'
  delete process.env.NEXT_PUBLIC_FEE_COLLECTOR
  delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
  process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  return {
    db: null as unknown as import('@/test-utils/fake-swaps-db').FakeSwapsDb,
    priced: [] as Array<{ token: string; amount: string }>,
  }
})

/** The oracle: a fixed price per token (lowercase) as [USD, decimals]. */
const PRICES: Record<string, [number, number]> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': [1, 6],
  '0xdac17f958d2ee523a2206206994597c13d831ec7': [1, 6],
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': [3400, 18],
  '0x6b175474e89094c44da98b954eedeac495271d0f': [1, 18],
  '0x4200000000000000000000000000000000000006': [3400, 18],
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': [1, 6],
}

vi.mock('@/lib/supabase', () => ({ getSupabase: () => state.db.service, getSupabaseLogger: () => state.db.logger, isSupabaseEnabled: () => true }))
vi.mock('@/lib/chainlink', () => ({
  computeTokenAmountUsd: vi.fn(async (token: string, amount: string) => {
    state.priced.push({ token: token.toLowerCase(), amount })
    const entry = PRICES[token.toLowerCase()]
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
  const allow = vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 }))
  return { ...actual, checkRateLimit: allow, checkRateLimitWithin: allow }
})

import { FORK_RECEIPTS as F, SWAP_RECEIPTS as R, type SwapReceiptFixture } from '@/lib/__fixtures__/swap-receipts'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'
import { trackLargeTrade, trackOracleDeviation } from '@/lib/security-tracker'
import { _resetVerifiedColumnsCache } from '@/lib/swap-log/store'
import { createFakeSwapsDb, type Row } from '@/test-utils/fake-swaps-db'
import { fakeUpstash } from '@/test-utils/fake-upstash-kv'
import { installStubChainRpc, type StubChainRpcOptions } from '@/test-utils/stub-chain-rpc'
import { GET as analyticsGet } from '../analytics/route'
import { GET as statsGet } from '../stats/route'
import { PATCH, POST } from './route'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const BASE_WETH = '0x4200000000000000000000000000000000000006'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ATTACKER = '0x00000000000000000000000000000000000000aa'
const sender = (f: SwapReceiptFixture) => String(f.tx.from).toLowerCase()

const send = (method: 'POST' | 'PATCH', body: unknown) =>
  (method === 'POST' ? POST : PATCH)(new NextRequest('http://localhost/api/log-swap', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))

/** What the official client POSTs when the user submits (analytics.ts logSwapToSupabase). */
function submit(wallet: string, chainId: number, source: string, tokenIn: string, tokenOut: string, amountIn = '1000000000000000000') {
  return send('POST', {
    wallet, chainId, source, tokenIn, tokenInSymbol: 'X', tokenOut, tokenOutSymbol: 'Y', amountIn, amountOut: '1000000',
    slippage: 0.5, mevProtected: source === 'cowswap', feeCollected: source !== 'cowswap' && source !== '0x', status: 'pending',
  })
}
/** What the official client PATCHes when the transaction confirmed (analytics.ts updateSwapStatus, with the chain). */
const confirm = (wallet: string, txHash: string, chainId: number) => send('PATCH', { txHash, status: 'confirmed', wallet, chainId })

const rows = () => state.db.rows()
const verified = () => rows().filter((r) => r.verified_at !== null && r.verified_at !== undefined)
const claimsOf = (wallet: string) => rows().filter((r) => r.wallet === wallet && r.claimed_tx_hash !== null && r.claimed_tx_hash !== undefined)

/** What the public reads: /api/stats totalSwaps and /api/analytics all-time volume and trade count (flag off). */
async function publicCounts() {
  fakeUpstash.reset()
  const stats = (await (await statsGet()).json()) as { totalSwaps?: number }
  const analytics = (await (await analyticsGet()).json()) as { dashboard: { allTime: { totalVolume: number; tradeCount: number } } }
  return { totalSwaps: stats.totalSwaps ?? 0, volume: analytics.dashboard.allTime.totalVolume, trades: analytics.dashboard.allTime.tradeCount }
}

let rpc: ReturnType<typeof installStubChainRpc>
function stub(options: StubChainRpcOptions = {}) {
  vi.unstubAllGlobals()
  __resetChainIdentityCache()
  rpc = installStubChainRpc(options)
}

beforeEach(() => {
  for (const name of ['RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL']) delete process.env[name]
  state.db = createFakeSwapsDb()
  state.priced = []
  _resetVerifiedColumnsCache()
  vi.clearAllMocks()
  stub()
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('S-1: tokens that only go out and come back are not a swap', () => {
  it.each([
    ['1 loop', F.pullSweep1],
    ['2 loops', F.pullSweep2],
    ['50 loops', F.pullSweep50],
  ])('SwapRouter02 multicall of pull + sweepToken, %s: rejected, nothing priced, no alert, nothing public', async (_n, f) => {
    const wallet = sender(f)
    expect((await submit(wallet, 8453, 'uniswapv3', BASE_WETH, BASE_WETH)).status).toBe(200)
    const res = await confirm(wallet, f.hash, 8453)
    expect([res.status, await res.json()]).toEqual([422, { error: 'Transaction not accepted for this swap' }])
    expect(verified()).toEqual([])
    expect(state.priced).toEqual([])
    expect(trackLargeTrade).not.toHaveBeenCalled()
    expect(await publicCounts()).toEqual({ totalSwaps: 0, volume: 0, trades: 0 })
  })

  it('a real swap through the same router is confirmed, with its netted sides, and counted once', async () => {
    const f = F.wethToUsdc
    const wallet = sender(f)
    await submit(wallet, 8453, 'uniswapv3', BASE_WETH, BASE_USDC, '100000000000000000')
    expect((await confirm(wallet, f.hash, 8453)).status).toBe(200)
    expect(verified()).toEqual([expect.objectContaining({ verified_kind: 'router', source: 'uniswapv3', token_in: BASE_WETH, amount_in: '100000000000000000', token_out: BASE_USDC, amount_out: '169061391', amount_in_usd: 340, amount_out_usd: 169.06 })])
    expect(await publicCounts()).toMatchObject({ totalSwaps: 1, trades: 1 })
  })

  it('a wrap alone and an unwrap alone are counted at their real outflow (ADR-029 7.6 residue); ETH sent and refunded is not', async () => {
    const wallet = sender(F.wrapAlone)
    await submit(wallet, 8453, 'uniswapv3', NATIVE, BASE_WETH)
    expect((await confirm(wallet, F.wrapAlone.hash, 8453)).status).toBe(200)
    await submit(wallet, 8453, 'uniswapv3', BASE_WETH, NATIVE)
    expect((await confirm(wallet, F.unwrapAlone.hash, 8453)).status).toBe(200)
    await submit(wallet, 8453, 'uniswapv3', NATIVE, BASE_USDC)
    expect((await confirm(wallet, F.ethRefund.hash, 8453)).status).toBe(422)
    expect(verified().map((r) => [r.tx_hash, r.token_in, r.amount_in, r.token_out, r.amount_out])).toEqual([
      [F.wrapAlone.hash, NATIVE, '500000000000000000', BASE_WETH, '500000000000000000'],
      [F.unwrapAlone.hash, BASE_WETH, '500000000000000000', null, null],
    ])
  })
})

describe('S-2: a call to the FeeCollector that is not a swap is never confirmed', () => {
  it.each([
    ['Ethereum', F.mainnetFcGetter, 1],
    ['Base', F.baseFcGetter, 8453],
    ['Arbitrum', F.arbitrumFcGetter, 42161],
  ])('the getter TIMELOCK_DELAY() sent as a transaction on %s: rejected, nothing public', async (_chain, f, chainId) => {
    const wallet = sender(f)
    await submit(wallet, chainId, 'kyberswap', chainId === 1 ? WETH : BASE_WETH, chainId === 1 ? USDC : BASE_USDC)
    expect((await confirm(wallet, f.hash, chainId)).status).toBe(422)
    expect(verified()).toEqual([])
    expect(await publicCounts()).toEqual({ totalSwaps: 0, volume: 0, trades: 0 })
  })

  it('an approve of the FeeCollector, and a call whose FeeCollector swap reverts inside a successful transaction: rejected', async () => {
    const wallet = sender(F.approve)
    await submit(wallet, 8453, 'kyberswap', BASE_WETH, BASE_USDC)
    expect((await confirm(wallet, F.approve.hash, 8453)).status).toBe(422)
    expect((await confirm(wallet, F.fcRevertsInside.hash, 8453)).status).toBe(422)
    expect(verified()).toEqual([])
  })

  it('a FeeCollector swap that reverted: failed, never confirmed', async () => {
    const wallet = sender(F.fcReverted)
    await submit(wallet, 8453, 'uniswapv3', NATIVE, BASE_USDC)
    expect((await send('PATCH', { txHash: F.fcReverted.hash, status: 'confirmed', wallet, chainId: 8453 })).status).toBe(200)
    expect(verified()).toEqual([expect.objectContaining({ status: 'failed', verified_kind: 'fee_collector', token_in: null, amount_in_usd: null })])
    expect(await publicCounts()).toEqual({ totalSwaps: 0, volume: 0, trades: 0 })
  })
})

describe('S-3: nobody can make a wallet\'s real swap unrecordable', () => {
  const victimTx = R.mainnetFcTokenToToken
  const victim = sender(victimTx)
  const SOLD = '0x5086bf358635b81d8c47c66d1c8b9e567db70c72'

  it('the audit\'s path: 5 rows planted for the victim on Arbitrum / 0x; the victim\'s own POST and PATCH record its swap, one row', async () => {
    for (let i = 0; i < 5; i++) expect((await submit(victim, 42161, '0x', WETH, USDC)).status).toBe(200)
    const post = await submit(victim, 1, 'velora', SOLD, USDC)
    expect([post.status, await post.json()]).toEqual([200, { ok: true }])
    const res = await confirm(victim, victimTx.hash, 1)
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(verified()).toEqual([expect.objectContaining({ wallet: victim, chain_id: 1, tx_hash: victimTx.hash.toLowerCase(), verified_kind: 'fee_collector', amount_in: '46080134130180921522' })])
  })

  it('5 abandoned attempts of the wallet itself (another route), then the swap it made: recorded, one row', async () => {
    for (let i = 0; i < 5; i++) expect((await submit(victim, 1, '0x', USDT, USDC)).status).toBe(200)
    expect((await submit(victim, 1, 'velora', SOLD, USDC)).status).toBe(200)
    expect((await confirm(victim, victimTx.hash, 1)).status).toBe(200)
    expect(verified()).toHaveLength(1)
    expect(verified()[0]).toMatchObject({ source: 'velora', token_in: SOLD })
  })

  it('a CoW order that settles while a newer swap\'s row is pending: the CoW swap is recorded on its own row', async () => {
    const cow = R.mainnetCowDirect
    const owner = '0x7249c6f7434dd3d884a2e1eb19b57076d5af6f67'
    // The order is submitted; a second later the user submits another swap (its row is the NEWER pending row).
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    try {
      await submit(owner, 1, 'cowswap', USDC, USDT, '649256721')
      vi.setSystemTime(Date.now() + 1_000)
      await submit(owner, 1, 'velora', WETH, USDC)
      vi.setSystemTime(Date.now() + 1_000)
    } finally {
      vi.useRealTimers()
    }
    expect(rows().map((r) => r.source)).toEqual(['cowswap', 'velora'])
    expect(Date.parse(String(rows()[1].created_at))).toBeGreaterThan(Date.parse(String(rows()[0].created_at)))
    expect((await confirm(owner, cow.hash, 1)).status).toBe(200)
    expect(verified()).toEqual([expect.objectContaining({ verified_kind: 'cow', token_in: USDC, token_out: USDT })])
    // The newer swap's row is still pending, for its own transaction.
    expect(rows().filter((r) => r.status === 'pending')).toEqual([expect.objectContaining({ source: 'velora', token_in: WETH })])
  })
})

describe('S-4: a hash the chain could not answer yet is never thrown away', () => {
  const f = R.mainnetFcTokenToToken
  const wallet = sender(f)
  const SOLD = '0x5086bf358635b81d8c47c66d1c8b9e567db70c72'

  it.each<[string, StubChainRpcOptions]>([
    ['the receipt is null (asked twice)', { override: (c) => (c.method === 'eth_getTransactionReceipt' ? null : undefined) }],
    ['the node answers 503', { fail: (c) => c.method !== 'eth_chainId' }],
    ['the chain-identity probe fails', { fail: (c) => c.method === 'eth_chainId' }],
  ])('%s: 202, the claim kept; a later PATCH verifies it once the node answers', async (_name, failing) => {
    await submit(wallet, 1, 'velora', SOLD, USDC)
    stub(failing)
    const first = await confirm(wallet, f.hash, 1)
    expect([first.status, await first.json()]).toEqual([202, { ok: false, outcome: 'not_found' }])
    expect(verified()).toEqual([])
    expect(claimsOf(wallet)).toEqual([expect.objectContaining({ claimed_tx_hash: f.hash.toLowerCase(), claimed_chain_id: 1, status: 'pending', tx_hash: null })])

    stub()
    const later = await confirm(wallet, f.hash, 1)
    expect([later.status, await later.json()]).toEqual([200, { ok: true }])
    expect(verified()).toEqual([expect.objectContaining({ tx_hash: f.hash.toLowerCase(), verified_kind: 'fee_collector', amount_out_usd: 51.01, claimed_tx_hash: null })])
    expect(claimsOf(wallet)).toEqual([])
    expect(rows()).toHaveLength(1)
  })

  it('a client that named no chain: the claim is kept without one, and a later confirmation finds it on its chain', async () => {
    await submit(wallet, 1, 'velora', SOLD, USDC)
    stub({ fail: (c) => c.method !== 'eth_chainId' })
    expect((await send('PATCH', { txHash: f.hash, wallet, status: 'confirmed' })).status).toBe(202)
    expect(claimsOf(wallet)).toEqual([expect.objectContaining({ claimed_tx_hash: f.hash.toLowerCase(), claimed_chain_id: null })])
    stub()
    expect((await send('PATCH', { txHash: f.hash, wallet, status: 'confirmed' })).status).toBe(200)
    expect(verified()).toHaveLength(1)
    expect(claimsOf(wallet)).toEqual([])
  })
})

describe('S-5: a smart-contract wallet verifies by the FeeCollector\'s own event', () => {
  it('a Coinbase Smart Wallet swap sent by a bundler to the EntryPoint (event user = the smart wallet): confirmed', async () => {
    const f = F.smartWallet
    const smart = '0x80c4a2bee98d15109e051af1124f2e92d06b7e7b'
    expect(sender(f)).not.toBe(smart)
    expect(String(f.tx.to).toLowerCase()).toBe('0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789')
    await submit(smart, 8453, 'uniswapv3', NATIVE, BASE_USDC, '50000000000000000')
    const res = await confirm(smart, f.hash, 8453)
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(verified()).toEqual([expect.objectContaining({ wallet: smart, verified_kind: 'fee_collector', source: 'uniswapv3', token_in: NATIVE, amount_in: '50000000000000000', token_out: BASE_USDC, amount_out: '84445542', fee_collected: true })])
    // The bundler that sent it can not claim it.
    expect((await confirm(sender(f), f.hash, 8453)).status).toBe(422)
  })
})

describe('S-6: one settlement, several wallets: one row per wallet', () => {
  const f = R.mainnetCowTwoOwners
  const first = '0x0e269d0c3941077dee8e7be50899e3b10eae35b6'
  const second = '0xb5378cf59f35e6e8bf5679ec6c22d1c5ff912433'

  it('in sequence: two verified rows', async () => {
    await submit(first, 1, 'cowswap', WETH, USDT)
    await submit(second, 1, 'cowswap', USDT, WETH)
    expect((await confirm(first, f.hash, 1)).status).toBe(200)
    expect((await confirm(second, f.hash, 1)).status).toBe(200)
    expect(verified().map((r) => [r.wallet, r.token_in])).toEqual([[first, WETH], [second, USDT]])
  })

  it('at once: two verified rows', async () => {
    await submit(first, 1, 'cowswap', WETH, USDT)
    await submit(second, 1, 'cowswap', USDT, WETH)
    const [a, b] = await Promise.all([confirm(first, f.hash, 1), confirm(second, f.hash, 1)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(verified()).toHaveLength(2)
  })

  it('a third party can not take a wallet\'s slot: its own claim is rejected, and naming the wallet records the wallet\'s trade', async () => {
    await submit(first, 1, 'cowswap', WETH, USDT)
    expect((await confirm(ATTACKER, f.hash, 1)).status).toBe(422)
    // The third party names the first wallet: that wallet's own trade is recorded, for that wallet.
    expect((await confirm(first, f.hash, 1)).status).toBe(200)
    // The second wallet's trade still gets its own row.
    expect((await confirm(second, f.hash, 1)).status).toBe(200)
    expect(verified().map((r) => [r.wallet, r.token_in, r.amount_in])).toEqual([[first, WETH, '2500000000000000000'], [second, USDT, '4136496015']])
    expect(rows().some((r) => r.wallet === ATTACKER)).toBe(false)
  })
})

describe('S-8: a router swap on Base is looked up among Base\'s routers', () => {
  it('a real swap sent straight to Uniswap SwapRouter02 on Base: confirmed as uniswapv3', async () => {
    const f = R.baseRouterUniswapTokenToToken
    const wallet = sender(f)
    await submit(wallet, 8453, 'uniswapv3', BASE_USDC, '0x8185eaf46136a3f095c60facd97eca1bfc2f38f6', '50000000')
    expect((await confirm(wallet, f.hash, 8453)).status).toBe(200)
    expect(verified()).toEqual([expect.objectContaining({ verified_kind: 'router', source: 'uniswapv3', chain_id: 8453, token_in: BASE_USDC, amount_in: '50000000', token_out: '0x8185eaf46136a3f095c60facd97eca1bfc2f38f6', amount_out: '15886448751948291128299' })])
    expect(rpc.reads().every((c) => c.chainId === 8453)).toBe(true)
  })
})

describe('the large-trade alert needs a real priced outflow', () => {
  it('50 loops of 1 WETH would have been 170,000 USD per side: no alert, no deviation alert', async () => {
    await submit(sender(F.pullSweep50), 8453, 'uniswapv3', BASE_WETH, BASE_WETH)
    await confirm(sender(F.pullSweep50), F.pullSweep50.hash, 8453)
    expect(trackLargeTrade).not.toHaveBeenCalled()
    expect(trackOracleDeviation).not.toHaveBeenCalled()
  })
})

void (null as unknown as Row)
