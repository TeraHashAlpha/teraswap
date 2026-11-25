// @vitest-environment node
/**
 * [ADR-029, details G] The incident of 2026-11-20 and 2026-11-22 replayed against the REAL route, shape by shape:
 * invented wallets and transaction hashes, repeated-byte and zero hashes, every status, an XSS string and a NUL byte as
 * symbols, 500 WETH declared, a token contract used as a wallet, and a PATCH aimed at another wallet's pending row.
 *
 * After each shape: nothing is confirmed, nothing is public, no alert fired, no symbol is the caller's text, no USD
 * value came from a declared amount, and no other wallet's row changed.
 *
 * This file imports nothing that main does not have (the fake database apart, one file under src/test-utils), so the
 * SAME file runs on a checkout of main, where every shape fails: docs/feedback/…tables.md has both columns.
 * `SWAP_REPLAY_DUMP=/abs/file.json` writes what was observed per shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { writeFileSync } from 'node:fs'

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_SALT = 'test-only-salt-0123456789-abcdefghijklmnop'
  for (const name of ['RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL', 'SWAPS_PUBLIC_VERIFIED_ONLY']) delete process.env[name]
  return {
    db: null as unknown as import('@/test-utils/fake-swaps-db').FakeSwapsDb,
    alerts: [] as Array<{ tracker: string; args: unknown }>,
  }
})

vi.mock('@/lib/supabase', () => ({ getSupabase: () => state.db.service, getSupabaseLogger: () => state.db.logger }))
// The oracle as production has it: WETH has a price, so a DECLARED 500 WETH is worth about 1.7 million USD.
vi.mock('@/lib/chainlink', () => ({
  computeTokenAmountUsd: vi.fn(async (token: string, amount: string) => {
    const prices: Record<string, [number, number]> = {
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': [3400, 18],
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': [1, 6],
    }
    const entry = prices[String(token).toLowerCase()]
    if (!entry || !/^\d+$/.test(String(amount))) return null
    return { usd: (Number(BigInt(amount)) / 10 ** entry[1]) * entry[0], price: entry[0], decimals: entry[1] }
  }),
}))
vi.mock('@/lib/wallet-activity-server', () => ({ trackWalletAction: vi.fn() }))
vi.mock('@/lib/security-tracker', () => {
  const record = (tracker: string) => vi.fn((args: unknown) => void state.alerts.push({ tracker, args }))
  return {
    trackLargeTrade: record('large_trade'),
    trackSwapFailed: record('swap_failed'),
    trackOracleDeviation: record('oracle_deviation'),
    trackOracleUnavailable: record('oracle_unavailable'),
    trackQuoteFailure: record('quote_failure'),
  }
})
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  const allow = vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 }))
  return { ...actual, checkRateLimit: allow, checkRateLimitWithin: allow }
})

import { createFakeSwapsDb, type Row } from '@/test-utils/fake-swaps-db'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const XSS = '<img src=x onerror=alert(document.domain)>'
const NUL = 'USD\u0000C'
const VICTIM = '0x7e57ed00000000000000000000000000000c0de1'
const STATUSES = ['pending', 'confirmed', 'failed', 'filled', 'reverted', 'success']
/** The 20 invented wallets of the incident: 0x1111… to 0xbbbb…, and token contracts used as wallets. */
const INVENTED_WALLETS = [...'123456789ab'].map((c) => `0x${c.repeat(40)}`).concat([WETH, USDC])
const repeated = (byte: string) => `0x${byte.repeat(32)}`
const INVENTED_HASHES = [repeated('11'), repeated('aa'), repeated('bb'), repeated('00'), repeated('ff'), `0x${'deadbeef'.repeat(8)}`]

/** A stub RPC, as a node that has none of these transactions: it proves its chain and answers null. */
function installStubRpc(): { reads: () => number } {
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(String(input)).host
    const chain = host === 'mainnet.base.org' ? 8453 : host === 'arb1.arbitrum.io' ? 42161 : 1
    const body = JSON.parse(String(init?.body)) as { method: string }
    if (body.method === 'eth_chainId') return Response.json({ jsonrpc: '2.0', id: 1, result: `0x${chain.toString(16)}` })
    reads++
    return Response.json({ jsonrpc: '2.0', id: 1, result: null })
  }))
  return { reads: () => reads }
}

type Handlers = typeof import('./route')
let route: Handlers

const send = (method: 'POST' | 'PATCH', body: unknown) =>
  (method === 'POST' ? route.POST : route.PATCH)(
    new NextRequest('http://localhost/api/log-swap', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  )

function swapBody(overrides: Row = {}): Row {
  return {
    wallet: INVENTED_WALLETS[0], chainId: 1, source: '1inch', tokenIn: WETH, tokenInSymbol: 'WETH', tokenOut: USDC, tokenOutSymbol: 'USDC',
    amountIn: '1000000000000000000', amountOut: '3400000000', slippage: 0.5, mevProtected: false, feeCollected: true, status: 'pending', ...overrides,
  }
}

/** The victim's own pending row, as the official client's POST left it a minute ago. */
function victimRow(): Row {
  return {
    id: 'victim-row', created_at: new Date(Date.now() - 60_000).toISOString(), wallet: VICTIM, tx_hash: null, chain_id: 1, status: 'pending', source: '1inch',
    token_in: WETH.toLowerCase(), token_in_symbol: 'WETH', token_out: USDC.toLowerCase(), token_out_symbol: 'USDC', amount_in: '1000000000000000000', amount_out: '3400000000',
    amount_in_usd: null, amount_out_usd: null, slippage: 0.5, mev_protected: false, fee_collected: true, fee_amount: null, gas_used: null, gas_price: null,
    mev_savings_estimate: null, mev_savings_actual: null, is_gasless: false, gas_savings_usd: 0, expected_output: null, verified_at: null, verified_kind: null,
  }
}

interface Observed {
  /** Rows whose status is not `pending`: a status only the caller chose. */
  rowsWithCallerStatus: number
  /** Rows main's public counters read as a swap: confirmed, or pending with a hash. */
  publicRows: number
  alerts: number
  /** Rows whose stored symbol is not a catalog symbol or the fixed address label. */
  rowsWithCallerSymbol: number
  /** The largest USD value stored on any row (null: none stored). */
  maxUsd: number | null
  /** Rows carrying a transaction hash the chain never confirmed. */
  rowsWithUnverifiedHash: number
  victimRowChanged: boolean
}

const SAFE: Observed = { rowsWithCallerStatus: 0, publicRows: 0, alerts: 0, rowsWithCallerSymbol: 0, maxUsd: null, rowsWithUnverifiedHash: 0, victimRowChanged: false }
const SYMBOL_OK = /^(?:[A-Za-z0-9.$+_\- ]{1,24}|0x[0-9a-f]{4}\.\.\.[0-9a-f]{4})$/

function observe(victimBefore: string): Observed {
  const rows = state.db.rows()
  const mine = rows.filter((r) => r.id !== 'victim-row')
  const usd = rows.flatMap((r) => [r.amount_in_usd, r.amount_out_usd]).filter((v): v is number => typeof v === 'number')
  return {
    rowsWithCallerStatus: mine.filter((r) => r.status !== 'pending').length,
    publicRows: rows.filter((r) => r.status === 'confirmed' || (r.status === 'pending' && r.tx_hash !== null && r.tx_hash !== undefined)).length,
    alerts: state.alerts.length,
    rowsWithCallerSymbol: mine.filter((r) => !SYMBOL_OK.test(String(r.token_in_symbol)) || !SYMBOL_OK.test(String(r.token_out_symbol))).length,
    maxUsd: usd.length === 0 ? null : Math.max(...usd),
    rowsWithUnverifiedHash: rows.filter((r) => r.tx_hash !== null && r.tx_hash !== undefined && (r.verified_at === null || r.verified_at === undefined)).length,
    victimRowChanged: JSON.stringify(rows.find((r) => r.id === 'victim-row')) !== victimBefore,
  }
}

const dump: Record<string, { requests: number; observed: Observed }> = {}
let victimBefore = ''
let requests = 0
const fire = async (method: 'POST' | 'PATCH', body: unknown) => {
  requests++
  return send(method, body)
}

beforeEach(async () => {
  state.db = createFakeSwapsDb({ swaps: [victimRow()] })
  state.alerts.length = 0
  victimBefore = JSON.stringify(state.db.rows()[0])
  requests = 0
  installStubRpc()
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  // A fresh copy of the route per shape: no state of one shape reaches the next.
  vi.resetModules()
  route = await import('./route')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
afterAll(() => {
  if (process.env.SWAP_REPLAY_DUMP) writeFileSync(process.env.SWAP_REPLAY_DUMP, `${JSON.stringify(dump, null, 1)}\n`)
})

function check(shape: string): void {
  const observed = observe(victimBefore)
  dump[shape] = { requests, observed }
  expect(requests, 'the shape sent requests').toBeGreaterThan(0)
  expect(observed).toEqual(SAFE)
}

describe('the incident, replayed', () => {
  it('shape 1: invented wallets and transaction hashes, POSTed as confirmed swaps', async () => {
    for (const [i, wallet] of INVENTED_WALLETS.entries()) {
      await fire('POST', swapBody({ wallet, status: 'confirmed', txHash: INVENTED_HASHES[i % INVENTED_HASHES.length] }))
    }
    check('1 invented wallet and hash, POST status confirmed')
  })

  it('shape 2: repeated-byte hashes and the zero hash, PATCHed onto the caller\'s own pending row', async () => {
    const wallet = INVENTED_WALLETS[1]
    for (const hash of INVENTED_HASHES) {
      await fire('POST', swapBody({ wallet }))
      await fire('PATCH', { txHash: hash, wallet, status: 'confirmed', gasUsed: '21000', gasPrice: '1000000000' })
    }
    check('2 repeated-byte and zero hashes, PATCH status confirmed')
  })

  it('shape 3: every status, by POST', async () => {
    for (const [i, status] of STATUSES.entries()) await fire('POST', swapBody({ wallet: INVENTED_WALLETS[i], status }))
    check('3 every status by POST')
  })

  it('shape 4: every status, by PATCH', async () => {
    for (const [i, status] of STATUSES.entries()) {
      const wallet = INVENTED_WALLETS[i]
      await fire('POST', swapBody({ wallet }))
      await fire('PATCH', { txHash: INVENTED_HASHES[i], wallet, status })
    }
    check('4 every status by PATCH')
  })

  it('shape 5: an XSS string and a NUL byte as token symbols', async () => {
    await fire('POST', swapBody({ wallet: INVENTED_WALLETS[2], tokenInSymbol: XSS, tokenOutSymbol: XSS, status: 'confirmed' }))
    await fire('POST', swapBody({ wallet: INVENTED_WALLETS[3], tokenInSymbol: NUL, tokenOutSymbol: `${XSS}${NUL}`, status: 'confirmed' }))
    check('5 XSS and NUL as symbols')
    const text = JSON.stringify(state.db.rows())
    expect(text).not.toContain('onerror')
    expect(text).not.toContain('\\u0000')
  })

  it('shape 6: 500 WETH declared (about 1.7 million USD at the oracle price), as the incident sent it', async () => {
    const amountIn = '500000000000000000000'
    // The two rows of the incident carried the statuses filled and reverted; a third says confirmed.
    for (const [i, status] of ['filled', 'reverted', 'confirmed'].entries()) {
      await fire('POST', swapBody({ wallet: INVENTED_WALLETS[4 + i], amountIn, amountOut: '1700000000000', amountInUsd: 1_700_000, status }))
    }
    check('6 500 WETH declared')
  })

  it('shape 7: a token contract used as the wallet, with a hash and a status in both calls', async () => {
    await fire('POST', swapBody({ wallet: USDC, status: 'confirmed', txHash: repeated('11') }))
    await fire('PATCH', { txHash: repeated('11'), wallet: USDC, status: 'confirmed' })
    await fire('PATCH', { txHash: repeated('11'), status: 'failed' })
    check('7 token contract as wallet')
  })

  it('shape 8: a PATCH aimed at ANOTHER wallet\'s pending row', async () => {
    // The caller knows only the victim's address (it is public): it names it, with an invented hash and a status.
    await fire('PATCH', { txHash: repeated('aa'), wallet: VICTIM, status: 'confirmed' })
    await fire('PATCH', { txHash: repeated('bb'), wallet: VICTIM, status: 'failed' })
    await fire('PATCH', { txHash: repeated('00'), wallet: VICTIM.toUpperCase().replace('0X', '0x'), status: 'confirmed', gasUsed: '1', mevSavingsActual: '999999999999' })
    check('8 PATCH on another wallet\'s pending row')
  })

  it('shape 9: all of it at once, as on the two days: about 110 rows from 20 wallets', async () => {
    let n = 0
    for (let round = 0; round < 9; round++) {
      for (const [i, wallet] of INVENTED_WALLETS.entries()) {
        const status = STATUSES[(round + i) % STATUSES.length]
        const hash = INVENTED_HASHES[(round * 3 + i) % INVENTED_HASHES.length]
        await fire('POST', swapBody({
          wallet, status, txHash: (round + i) % 2 === 0 ? hash : undefined,
          tokenInSymbol: i % 4 === 0 ? XSS : 'WETH', tokenOutSymbol: i % 5 === 0 ? NUL : 'USDC',
          amountIn: i % 6 === 0 ? '500000000000000000000' : '1000000000000000000',
        }))
        await fire('PATCH', { txHash: hash, wallet: i % 3 === 0 ? VICTIM : wallet, status })
        n++
      }
    }
    expect(n).toBe(117)
    check('9 the whole incident (117 POST and 117 PATCH)')
    // The cap: no invented wallet got more than five pending rows.
    const perWallet = new Map<string, number>()
    for (const r of state.db.rows()) perWallet.set(String(r.wallet), (perWallet.get(String(r.wallet)) ?? 0) + 1)
    expect(Math.max(...perWallet.values())).toBeLessThanOrEqual(5)
  })
})
