// @vitest-environment node
/**
 * [ADR-029, details B] POST /api/log-swap on the fake database (src/test-utils/fake-swaps-db.ts): it inserts ONLY a
 * private pending row from validated input, with catalog symbols, and answers the official client as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createFakeSwapsDb, type FakeSwapsDb } from '@/test-utils/fake-swaps-db'

const state = vi.hoisted(() => {
  // A throwaway salt, so the rate limiter's one-time "salt not set" warning is not among the captured log lines.
  process.env.RATE_LIMIT_SALT = 'test-only-salt-0123456789-abcdefghijklmnop'
  return { db: null as unknown as FakeSwapsDb }
})

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => state.db.service,
  getSupabaseLogger: () => state.db.logger,
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

import { trackLargeTrade, trackOracleDeviation, trackOracleUnavailable, trackSwapFailed } from '@/lib/security-tracker'
import { _resetVerifiedColumnsCache, PENDING_CAP } from '@/lib/swap-log/store'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import { POST } from './route'

const WALLET = '0x1234567890AbcdEF1234567890aBcdef12345678'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const XSS = '<img src=x onerror=alert(document.cookie)>'

function post(body: unknown): Promise<Response> {
  return POST(new NextRequest('http://localhost/api/log-swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
}

/** What src/lib/analytics.ts logSwapToSupabase sends (analytics.ts:56-79), for a standard swap (useSwap.ts:1188). */
function clientBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    wallet: WALLET,
    chainId: 1,
    source: '1inch',
    tokenIn: WETH,
    tokenInSymbol: 'WETH',
    tokenOut: USDC,
    tokenOutSymbol: 'USDC',
    amountIn: '1000000000000000000',
    amountOut: '2950000000',
    slippage: 0.5,
    mevProtected: false,
    feeCollected: true,
    status: 'pending',
    oracleUnavailable: false,
    priceDeviation: 0,
    expectedOutput: '2950000000',
    ...overrides,
  }
}

const rows = () => state.db.rows()
const lastRow = () => rows()[rows().length - 1]

let logged: string[] = []

beforeEach(() => {
  state.db = createFakeSwapsDb()
  _resetVerifiedColumnsCache()
  vi.clearAllMocks()
  logged = []
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    })
  }
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the official client\'s three calls keep their answer: 200 { ok: true }', () => {
  it('a standard swap at submit (useSwap.ts:1188): one pending row, no hash, no USD', async () => {
    const res = await post(clientBody())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(rows()).toHaveLength(1)
    expect(lastRow()).toMatchObject({
      wallet: WALLET.toLowerCase(),
      chain_id: 1,
      source: '1inch',
      status: 'pending',
      tx_hash: null,
      token_in: WETH.toLowerCase(),
      token_in_symbol: 'WETH',
      token_out: USDC.toLowerCase(),
      token_out_symbol: 'USDC',
      amount_in: '1000000000000000000',
      amount_out: '2950000000',
      amount_in_usd: null,
      amount_out_usd: null,
      fee_amount: null,
      slippage: 0.5,
      mev_protected: false,
      fee_collected: true,
      expected_output: '2950000000',
      is_gasless: false,
      gas_savings_usd: 0,
      mev_savings_estimate: null,
      mev_savings_actual: null,
      verified_at: null,
      verified_kind: null,
    })
  })

  it('a CoW order after it was submitted (useSwap.ts:1086)', async () => {
    const res = await post(clientBody({ source: 'cowswap', mevProtected: true, feeCollected: false, bestNonCowGasUsd: 4.2 }))
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(lastRow()).toMatchObject({ source: 'cowswap', status: 'pending', is_gasless: true, mev_protected: true, gas_savings_usd: 4.2, tx_hash: null })
  })

  it('a split-swap leg after its receipt (useSplitSwap.ts:611: status confirmed and a hash in the POST): still a pending row with no hash', async () => {
    const res = await post(clientBody({ source: 'velora', status: 'confirmed', txHash: `0x${'ab'.repeat(32)}` }))
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    // CHANGED EXPECTATION (goal 133c P.1; round 2 kept the claim on this row): the leg's row, pending with no hash and
    // no claim, and the hash the chain does not have kept on a claim row of its own.
    expect(rows()).toHaveLength(2)
    expect(rows()[0]).toMatchObject({ source: 'velora', status: 'pending', tx_hash: null, verified_at: null, claimed_tx_hash: null })
    expect(lastRow()).toMatchObject({ status: 'pending', tx_hash: null, verified_at: null, token_in: null, claimed_tx_hash: `0x${'ab'.repeat(32)}` })
  })

  it('native ETH as a token (the app\'s placeholder) is an address like any other; chain 8453 and 42161 are accepted', async () => {
    expect((await post(clientBody({ tokenIn: NATIVE, tokenInSymbol: 'ETH', chainId: 8453, tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }))).status).toBe(200)
    expect(lastRow()).toMatchObject({ chain_id: 8453, token_in: NATIVE.toLowerCase(), token_in_symbol: 'ETH', token_out_symbol: 'USDC' })
    expect((await post(clientBody({ wallet: '0x00000000000000000000000000000000000000a1', tokenOut: NATIVE, chainId: 42161, tokenIn: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' }))).status).toBe(200)
    expect(lastRow()).toMatchObject({ chain_id: 42161, token_out: NATIVE.toLowerCase(), token_out_symbol: 'ETH', token_in_symbol: 'USDC' })
  })

  it('no chain id means Ethereum, as before', async () => {
    const body = clientBody()
    delete body.chainId
    expect((await post(body)).status).toBe(200)
    expect(lastRow().chain_id).toBe(1)
  })
})

describe('what the caller says about status, value, fee and oracle is ignored', () => {
  it.each(['confirmed', 'failed', 'filled', 'reverted', 'success', 'CONFIRMED', '', 7, null, { $ne: 'pending' }])('status %j: the row is pending', async (status) => {
    expect((await post(clientBody({ status }))).status).toBe(200)
    expect(lastRow().status).toBe('pending')
  })

  it('declared USD, fee, oracle and mev fields never reach the row, an alert or a tracker', async () => {
    const res = await post(clientBody({
      amountIn: '500000000000000000000',
      amountInUsd: 1_700_000,
      amountOutUsd: 1_700_000,
      feeAmount: '999999999',
      oracleUnavailable: true,
      priceDeviation: 0.9,
      mevSavingsEstimate: '123456789',
      mevSavingsActual: '987654321',
      gasUsed: '21000',
      gasPrice: '1',
    }))
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(lastRow()).toMatchObject({
      status: 'pending', amount_in_usd: null, amount_out_usd: null, fee_amount: null,
      mev_savings_estimate: null, mev_savings_actual: null, gas_used: null, gas_price: null,
    })
    expect(trackLargeTrade).not.toHaveBeenCalled()
    expect(trackOracleUnavailable).not.toHaveBeenCalled()
    expect(trackOracleDeviation).not.toHaveBeenCalled()
    expect(trackSwapFailed).not.toHaveBeenCalled()
    // The one tracker call carries no USD value and no transaction hash.
    expect(trackWalletAction).toHaveBeenCalledTimes(1)
    const [wallet, action] = vi.mocked(trackWalletAction).mock.calls[0]
    expect(wallet).toBe(WALLET.toLowerCase())
    expect(action).toEqual({
      category: 'swap', action: 'swap_logged', source: '1inch', tokenIn: 'WETH', tokenOut: 'USDC',
      metadata: { status: 'pending', slippage: 0.5, mevProtected: false, feeCollected: true },
    })
    expect(JSON.stringify(action)).not.toMatch(/amountUsd|txHash|1700000/)
  })

  it('slippage outside 0..100, or not a number, falls back to 0.5; the two flags are true only when they are true', async () => {
    for (const slippage of [-1, 101, Number.NaN, '5', null, undefined, {}]) {
      await post(clientBody({ slippage, wallet: `0x${String(rows().length).padStart(40, '0')}` }))
      expect(lastRow().slippage).toBe(0.5)
    }
    await post(clientBody({ slippage: 3, mevProtected: 'yes', feeCollected: 1, wallet: '0x00000000000000000000000000000000000000b1' }))
    expect(lastRow()).toMatchObject({ slippage: 3, mev_protected: false, fee_collected: false })
  })
})

describe('symbols come from the catalog by address and chain, never from the caller', () => {
  it('an XSS string and a NUL byte sent as symbols are not stored anywhere in the row', async () => {
    await post(clientBody({ tokenInSymbol: XSS, tokenOutSymbol: 'US\u0000DC' }))
    expect(lastRow()).toMatchObject({ token_in_symbol: 'WETH', token_out_symbol: 'USDC' })
    const text = JSON.stringify(lastRow())
    expect(text).not.toContain('onerror')
    expect(text).not.toContain('\\u0000')
  })

  it('a token the catalog does not have gets a fixed label: the first 6 and the last 4 characters of its address', async () => {
    await post(clientBody({ tokenIn: '0xDEADBEEF00000000000000000000000000001234', tokenInSymbol: XSS }))
    expect(lastRow().token_in_symbol).toBe('0xdead...1234')
    expect(String(lastRow().token_in_symbol)).toMatch(/^0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/)
  })

  it('the same address is looked up on the row\'s chain: mainnet USDC is not a catalog token on Base', async () => {
    await post(clientBody({ chainId: 8453 }))
    expect(lastRow()).toMatchObject({ chain_id: 8453, token_out: USDC.toLowerCase(), token_out_symbol: '0xa0b8...eb48' })
  })
})

describe('validation: anything else is a 400 and nothing is written', () => {
  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ['a source that is not in the app\'s list', { source: 'paraswap' }, 'Invalid source'],
    ['an XSS string as source', { source: XSS }, 'Invalid source'],
    ['__proto__ as source', { source: '__proto__' }, 'Invalid source'],
    ['a source that is an object', { source: { name: '1inch' } }, 'Invalid source'],
    ['a wallet that is not an address', { wallet: '0x1234' }, 'Invalid wallet'],
    ['a wallet with a trailing newline', { wallet: `${WALLET}\n` }, 'Invalid wallet'],
    ['tokenIn that is a symbol', { tokenIn: 'WETH' }, 'Invalid tokenIn'],
    ['tokenOut with 41 hex characters', { tokenOut: `${USDC}0` }, 'Invalid tokenOut'],
    ['a decimal amountIn', { amountIn: '1.5' }, 'Invalid amountIn'],
    ['a negative amountIn', { amountIn: '-1' }, 'Invalid amountIn'],
    ['a hex amountIn', { amountIn: '0x10' }, 'Invalid amountIn'],
    ['an amountIn in exponent form', { amountIn: '1e30' }, 'Invalid amountIn'],
    ['an amountIn that is a number', { amountIn: 1000 }, 'Invalid amountIn'],
    ['an amountIn of 79 digits', { amountIn: '1'.repeat(79) }, 'Invalid amountIn'],
    ['an amountOut with a space', { amountOut: '10 ' }, 'Invalid amountOut'],
    ['an amountOut with a NUL byte', { amountOut: '10\u0000' }, 'Invalid amountOut'],
    ['a chain the app does not have', { chainId: 10 }, 'Invalid chainId'],
    ['a chain id sent as text', { chainId: '1' }, 'Invalid chainId'],
    ['a malformed transaction hash', { txHash: '0x1234' }, 'Invalid txHash'],
    ['a transaction hash that is a number', { txHash: 5 }, 'Invalid txHash'],
  ]
  it.each(invalid)('%s', async (_name, change, error) => {
    const res = await post(clientBody(change))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
    expect(rows()).toEqual([])
    expect(state.db.writes()).toEqual([])
    expect(trackWalletAction).not.toHaveBeenCalled()
  })

  it.each(['wallet', 'source', 'tokenIn', 'tokenOut', 'amountIn', 'amountOut'])('missing %s: 400 "Missing required fields", as before', async (field) => {
    const body = clientBody()
    delete body[field]
    const res = await post(body)
    expect([res.status, await res.json()]).toEqual([400, { error: 'Missing required fields' }])
    expect(rows()).toEqual([])
  })

  it('a body that is not a JSON object: 400 or the old 200 { ok: false }, never a row', async () => {
    expect((await post('[1,2]')).status).toBe(400)
    expect((await post('null')).status).toBe(400)
    const notJson = await post('{not json')
    expect([notJson.status, await notJson.json()]).toEqual([200, { ok: false, error: 'invalid_body' }])
    expect(rows()).toEqual([])
  })

  it('78 digits is the longest amount accepted (2^256 - 1 has 78)', async () => {
    const max = (2n ** 256n - 1n).toString()
    expect(max).toHaveLength(78)
    expect((await post(clientBody({ amountIn: max, amountOut: '0' }))).status).toBe(200)
    expect(lastRow()).toMatchObject({ amount_in: max, amount_out: '0' })
  })
})

describe('pending rows are scratch: at 5 in the last hour the oldest is retired, never a 429 (133b J, owner 2026-11-26)', () => {
  const lower = WALLET.toLowerCase()
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  /** A row of the wallet; `claim` (minutes ago) gives it a claim of a hash. */
  const seed = (id: string, createdMinutesAgo: number, extra: Record<string, unknown> = {}, claimMinutesAgo?: number) => ({
    id, wallet: lower, created_at: minutesAgo(createdMinutesAgo), status: 'pending', tx_hash: null, chain_id: 1, source: '1inch',
    token_in: WETH.toLowerCase(), token_in_symbol: 'WETH', token_out: USDC.toLowerCase(), token_out_symbol: 'USDC', amount_in: '1', amount_out: '1',
    slippage: 0.5, mev_protected: false, fee_collected: false, verified_at: null,
    ...(claimMinutesAgo === undefined ? {} : { claimed_tx_hash: `0x${id.padStart(64, 'c').slice(-64).replace(/[^0-9a-f]/g, 'c')}`, claimed_chain_id: 1, claimed_at: minutesAgo(claimMinutesAgo) }),
    ...extra,
  })
  const ids = () => rows().map((r) => String(r.id))
  const deletes = () => state.db.ops.filter((o) => o.kind === 'delete')

  it('the 6th POST is written and the oldest unclaimed scratch row retired; it never answers 429', async () => {
    expect(PENDING_CAP).toBe(5)
    for (let i = 1; i <= 5; i++) expect((await post(clientBody())).status, `POST ${i}`).toBe(200)
    const first = ids()[0]
    const sixth = await post(clientBody())
    // CHANGED (133b J): was 429 'Too many pending swaps for this wallet. Try again later.' and 5 rows.
    expect([sixth.status, await sixth.json()]).toEqual([200, { ok: true }])
    expect(rows()).toHaveLength(5)
    expect(ids()).not.toContain(first)
    // Same wallet in another letter case is the same wallet; another wallet is not affected.
    expect((await post(clientBody({ wallet: lower }))).status).toBe(200)
    expect(rows()).toHaveLength(5)
    expect((await post(clientBody({ wallet: '0x00000000000000000000000000000000000000c1' }))).status).toBe(200)
    expect(rows()).toHaveLength(6)
    // A delete names the row, the wallet and what makes it scratch.
    // CHANGED EXPECTATION (goal 133c P.4): what makes it scratch now also says it holds no claim and is of the last
    // hour, so a claim row (or an older row) can never be the one deleted.
    expect(deletes()[0].filters).toEqual([
      `id=eq.${first}`, `wallet=eq.${lower}`, 'status=eq.pending', 'tx_hash=is.null', 'verified_at=is.null', 'claimed_tx_hash=is.null', expect.stringMatching(/^created_at=gte\.\d{4}-/),
    ])
  })

  it('a planted wallet does not block its owner: 50 POSTs by "someone" for it, then the owner\'s own POST is written', async () => {
    for (let i = 0; i < 50; i++) expect((await post(clientBody({ amountIn: String(i + 1) }))).status).toBe(200)
    const own = await post(clientBody({ amountIn: '777' }))
    expect(own.status).toBe(200)
    expect(rows().some((r) => r.amount_in === '777')).toBe(true)
    expect(rows().length).toBeLessThanOrEqual(5)
  })

  it('rows older than an hour without a claim are never retired (rows written before this change among them); nor rows that are not scratch', async () => {
    state.db = createFakeSwapsDb({
      swaps: [
        ...Array.from({ length: 9 }, (_, i) => seed(`old-${i}`, 61 + i)),
        seed('confirmed', 30, { status: 'confirmed', tx_hash: `0x${'aa'.repeat(32)}` }),
        seed('verified', 30, { status: 'confirmed', tx_hash: `0x${'bb'.repeat(32)}`, verified_at: minutesAgo(29), verified_kind: 'router' }),
        seed('with-hash', 30, { tx_hash: `0x${'cc'.repeat(32)}` }),
        ...Array.from({ length: 4 }, (_, i) => seed(`recent-${i}`, 50 - i)),
      ],
    })
    // 4 recent pending: the 5th is simply written.
    expect((await post(clientBody())).status).toBe(200)
    expect(deletes()).toEqual([])
    // At 5, the oldest RECENT scratch row goes; the old and the non-scratch rows stay.
    expect((await post(clientBody())).status).toBe(200)
    expect(deletes().map((o) => o.detail)).toEqual([['recent-0']])
    for (const id of ['old-0', 'old-8', 'confirmed', 'verified', 'with-hash']) expect(ids()).toContain(id)
  })

  it('all five carry a claim younger than 24 h: a sixth row is written, none retired', async () => {
    state.db = createFakeSwapsDb({ swaps: Array.from({ length: 5 }, (_, i) => seed(`claimed-${i}`, 50 - i, {}, 40 - i)) })
    expect((await post(clientBody())).status).toBe(200)
    expect(deletes()).toEqual([])
    expect(rows()).toHaveLength(6)
  })

  it('all five carry a claim and one claim is older than 24 h: that row is retired', async () => {
    state.db = createFakeSwapsDb({
      swaps: [
        // An old claim row (created two days ago, claimed then).
        seed('stale-claim', 48 * 60, { token_in: null, token_in_symbol: null, token_out: null, token_out_symbol: null, amount_in: null, amount_out: null }, 48 * 60),
        ...Array.from({ length: 5 }, (_, i) => seed(`claimed-${i}`, 50 - i, {}, 40 - i)),
      ],
    })
    expect((await post(clientBody())).status).toBe(200)
    // CHANGED EXPECTATION (goal 133c P.3 / P.4; round 2 retired the claim older than 24 h, A104 R2-2 B3b): a POST never
    // touches a claim row; a claim leaves only by the chain's answer or after 7 days.
    expect(deletes()).toEqual([])
    expect(ids()).toContain('stale-claim')
    expect(rows()).toHaveLength(7)
  })

  it('at 20 scratch rows the oldest goes, whatever it carries', async () => {
    // 19 claimed rows of the last hour (young claims) and one older claimed row.
    state.db = createFakeSwapsDb({
      swaps: [seed('oldest-claim', 120, {}, 110), ...Array.from({ length: 19 }, (_, i) => seed(`claimed-${i}`, 59 - i, {}, 58 - i))],
    })
    expect((await post(clientBody())).status).toBe(200)
    // CHANGED EXPECTATION (goal 133c P.4; round 2 deleted the oldest at 20 "whatever it carries", the vector of A104
    // R2-2): no claim row is ever retired by a POST; the POST rows of the hour follow the cap of 5 on their own.
    expect(deletes()).toEqual([])
    expect(rows()).toHaveLength(21)
    for (let i = 0; i < 6; i++) expect((await post(clientBody())).status).toBe(200)
    expect(rows().filter((r) => r.claimed_tx_hash !== null && r.claimed_tx_hash !== undefined)).toHaveLength(20)
    expect(rows().filter((r) => r.claimed_tx_hash === null || r.claimed_tx_hash === undefined)).toHaveLength(5)
    expect(deletes()).toHaveLength(2)
  })

  it('another wallet\'s rows are never retired', async () => {
    const other = '0x00000000000000000000000000000000000000c1'
    state.db = createFakeSwapsDb({ swaps: Array.from({ length: 6 }, (_, i) => ({ ...seed(`other-${i}`, 50 - i), wallet: other })) })
    for (let i = 0; i < 7; i++) expect((await post(clientBody())).status).toBe(200)
    expect(rows().filter((r) => r.wallet === other)).toHaveLength(6)
    for (const op of deletes()) expect(op.filters).toContain(`wallet=eq.${lower}`)
  })
})

describe('which database client does what, and what a failure says', () => {
  it('the insert goes through the insert-only logger client; the reads through the service client', async () => {
    await post(clientBody())
    const swapsOps = state.db.ops.filter((o) => o.table === 'swaps')
    // CHANGED (133b J): the cap read its one count; it now reads the wallet's scratch rows, and deletes, with the
    // service client, only when it retires one.
    // CHANGED EXPECTATION (goal 133c P.4; round 2 read twice, the second read for rows carrying a claim): one read, the
    // wallet's POST rows of the last hour that hold no claim.
    expect(swapsOps.map((o) => `${o.role}:${o.kind}`)).toEqual(['service:select', 'service:select', 'logger:insert'])
    const scratch = [`wallet=eq.${WALLET.toLowerCase()}`, 'status=eq.pending', 'tx_hash=is.null', 'verified_at=is.null', 'claimed_tx_hash=is.null']
    expect(swapsOps[1].filters).toEqual([...scratch, expect.stringMatching(/^created_at=gte\.\d{4}-/), 'order=created_at.asc', 'limit=100'])
  })

  it('an insert the database refuses: 200 { ok: false, error: "insert_failed" }, and the log has the code only', async () => {
    const refusing = createFakeSwapsDb()
    const realFrom = refusing.logger.from
    refusing.logger.from = ((table: string) => {
      const b = realFrom(table)
      b.insert = (() => ({ then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { code: '22P02', message: `invalid input syntax: "${XSS}"`, details: WALLET } }) })) as never
      return b
    }) as typeof realFrom
    state.db = refusing
    const res = await post(clientBody({ tokenInSymbol: XSS }))
    expect([res.status, await res.json()]).toEqual([200, { ok: false, error: 'insert_failed' }])
    expect(logged).toEqual(['[log-swap] insert failed code=22P02'])
  })

  it('no log line ever carries what the caller sent', async () => {
    const hostile = clientBody({ tokenInSymbol: XSS, tokenOutSymbol: 'evil\nforged log line', status: 'confirmed\r\n[log-swap] ok', amountInUsd: 31337.31337 })
    await post(hostile)
    await post({ ...hostile, source: `x${XSS}` })
    await post({ ...hostile, wallet: `0xnot-a-wallet-${XSS}` })
    await post(`{"wallet": "${XSS}`)
    for (const line of logged) {
      expect(line).not.toContain('onerror')
      expect(line).not.toContain('forged log line')
      expect(line).not.toContain('31337')
      expect(line).not.toContain('not-a-wallet')
    }
  })
})
