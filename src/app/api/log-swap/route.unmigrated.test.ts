// @vitest-environment node
/**
 * [ADR-029, details E; owner's answer 2026-11-25] The code works BEFORE the migration is applied: while the columns
 * `verified_at` / `verified_kind` are missing, POST and PATCH /api/log-swap write NOTHING AT ALL, answer today's
 * success shape, and log one line `swaps_verified_columns_missing`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => {
  // A throwaway salt, so the rate limiter's one-time "salt not set" warning is not among the captured log lines.
  process.env.RATE_LIMIT_SALT = 'test-only-salt-0123456789-abcdefghijklmnop'
  return { db: null as unknown as import('@/test-utils/fake-swaps-db').FakeSwapsDb }
})

vi.mock('@/lib/supabase', () => ({ getSupabase: () => state.db.service, getSupabaseLogger: () => state.db.logger }))
vi.mock('@/lib/chainlink', () => ({ computeTokenAmountUsd: vi.fn(async () => null) }))
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

import { SWAP_RECEIPTS as R } from '@/lib/__fixtures__/swap-receipts'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'
import { trackLargeTrade, trackSwapFailed } from '@/lib/security-tracker'
import { VERIFIED_COLUMNS_SEEN_TTL_MS, _resetVerifiedColumnsCache, verifiedColumnsState } from '@/lib/swap-log/store'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import { createFakeSwapsDb, type Row } from '@/test-utils/fake-swaps-db'
import { installStubChainRpc } from '@/test-utils/stub-chain-rpc'
import { PATCH, POST } from './route'

const MISSING_LINE = '[log-swap] swaps_verified_columns_missing'
const f = R.mainnetFcTokenToToken
const wallet = String(f.tx.from).toLowerCase()

const request = (method: 'POST' | 'PATCH', body: unknown) =>
  new NextRequest('http://localhost/api/log-swap', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = (body: unknown) => POST(request('POST', body))
const patch = (body: unknown) => PATCH(request('PATCH', body))

const clientPost = (overrides: Row = {}) => ({
  wallet, chainId: 1, source: 'velora', tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', tokenInSymbol: 'WETH',
  tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', tokenOutSymbol: 'USDC', amountIn: '1000000000000000000', amountOut: '2950000000',
  slippage: 0.5, mevProtected: false, feeCollected: true, status: 'pending', ...overrides,
})

/** A row as the code before this change left it: pending, written before the columns existed. */
const oldPendingRow = (): Row => ({
  id: 'old-pending', created_at: new Date(Date.now() - 60_000).toISOString(), wallet, tx_hash: null, chain_id: 1, status: 'pending', source: 'velora',
  token_in: 'a', token_in_symbol: 'A', token_out: 'b', token_out_symbol: 'B', amount_in: '1', amount_out: '1', slippage: 0.5, mev_protected: false, fee_collected: false,
})

let rpc: ReturnType<typeof installStubChainRpc>
let logged: string[] = []

beforeEach(() => {
  for (const name of ['RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL']) delete process.env[name]
  state.db = createFakeSwapsDb({ migrated: false, swaps: [oldPendingRow()] })
  _resetVerifiedColumnsCache()
  __resetChainIdentityCache()
  vi.clearAllMocks()
  rpc = installStubChainRpc()
  logged = []
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('columns missing: nothing is written, the answer is today\'s success shape, one line is logged', () => {
  it('POST (a standard swap at submit)', async () => {
    const before = JSON.stringify(state.db.rows())
    const res = await post(clientPost())
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(JSON.stringify(state.db.rows())).toBe(before)
    expect(state.db.writes()).toEqual([])
    expect(logged).toEqual([MISSING_LINE])
    expect(trackWalletAction).not.toHaveBeenCalled()
  })

  it('POST with a hash and status confirmed (a split-swap leg): nothing inserted, nothing read on-chain', async () => {
    const res = await post(clientPost({ status: 'confirmed', txHash: f.hash }))
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(state.db.writes()).toEqual([])
    expect(rpc.calls).toEqual([])
    expect(logged).toEqual([MISSING_LINE])
  })

  it('PATCH of a real transaction: no update, no chain read', async () => {
    const before = JSON.stringify(state.db.rows())
    const res = await patch({ txHash: f.hash, wallet, status: 'confirmed' })
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(JSON.stringify(state.db.rows())).toBe(before)
    expect(state.db.writes()).toEqual([])
    expect(rpc.calls).toEqual([])
    expect(logged).toEqual([MISSING_LINE])
    expect(trackSwapFailed).not.toHaveBeenCalled()
    expect(trackLargeTrade).not.toHaveBeenCalled()
  })

  it('the incident\'s requests, sent before the migration: still nothing written', async () => {
    const hostile = clientPost({ wallet: '0x1111111111111111111111111111111111111111', status: 'confirmed', tokenInSymbol: '<script>alert(1)</script>', amountIn: '500000000000000000000', txHash: `0x${'11'.repeat(32)}` })
    await post(hostile)
    await patch({ txHash: `0x${'11'.repeat(32)}`, wallet: hostile.wallet, status: 'confirmed' })
    await patch({ txHash: `0x${'11'.repeat(32)}`, wallet, status: 'confirmed' })
    expect(state.db.writes()).toEqual([])
    expect(state.db.rows()).toHaveLength(1)
    expect(state.db.rows()[0].status).toBe('pending')
    expect(logged).toEqual([MISSING_LINE, MISSING_LINE, MISSING_LINE])
  })

  it('one line per request, never more', async () => {
    await post(clientPost())
    await post(clientPost())
    await patch({ txHash: f.hash, wallet })
    expect(logged).toEqual([MISSING_LINE, MISSING_LINE, MISSING_LINE])
  })

  it('validation still answers first: a bad request is a 400 and logs nothing', async () => {
    expect((await post(clientPost({ source: 'paraswap' }))).status).toBe(400)
    expect((await patch({ wallet })).status).toBe(400)
    expect(logged).toEqual([])
  })
})

describe('the moment the migration is applied, the same process starts writing', () => {
  it('"missing" is asked again on every request; "present" is remembered', async () => {
    expect((await post(clientPost())).status).toBe(200)
    expect(state.db.writes()).toEqual([])

    // The owner applies the migration: same process, no restart.
    state.db = createFakeSwapsDb({ migrated: true })
    logged = []
    expect(await (await post(clientPost())).json()).toEqual({ ok: true })
    expect(state.db.rows()).toHaveLength(1)
    expect(state.db.rows()[0]).toMatchObject({ status: 'pending', verified_at: null })
    expect(logged).toEqual([])

    const probes = () => state.db.ops.filter((o) => o.kind === 'select' && o.detail === 'verified_at, verified_kind').length
    expect(probes()).toBe(1)
    await post(clientPost({ wallet: '0x00000000000000000000000000000000000000c2' }))
    await patch({ txHash: f.hash, wallet })
    expect(probes()).toBe(1)
  })

  it('"present" is trusted for five minutes, then asked again', async () => {
    const db = createFakeSwapsDb({ migrated: true })
    const t0 = 1_800_000_000_000
    expect(await verifiedColumnsState(db.service as never, t0)).toBe('present')
    expect(await verifiedColumnsState(db.service as never, t0 + VERIFIED_COLUMNS_SEEN_TTL_MS - 1)).toBe('present')
    expect(db.ops).toHaveLength(1)
    expect(await verifiedColumnsState(db.service as never, t0 + VERIFIED_COLUMNS_SEEN_TTL_MS)).toBe('present')
    expect(db.ops).toHaveLength(2)
    // The columns were dropped again (a rollback): within one period the answer follows.
    const rolledBack = createFakeSwapsDb({ migrated: false })
    expect(await verifiedColumnsState(rolledBack.service as never, t0 + 3 * VERIFIED_COLUMNS_SEEN_TTL_MS)).toBe('missing')
    expect(await verifiedColumnsState(rolledBack.service as never, t0 + 3 * VERIFIED_COLUMNS_SEEN_TTL_MS + 1)).toBe('missing')
  })
})

describe('the probe failing for another reason is not "columns missing"', () => {
  it('a database outage: 200 { ok: false }, nothing written, and the columns-missing line is NOT logged', async () => {
    const down = createFakeSwapsDb({ migrated: true })
    const outage = { then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null }) }
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'limit', 'is', 'ilike', 'order', 'not', 'neq']) chain[m] = () => chain
    chain.then = outage.then
    down.service.from = (() => chain) as never
    state.db = down

    const posted = await post(clientPost())
    expect([posted.status, await posted.json()]).toEqual([200, { ok: false, error: 'storage_unavailable' }])
    const patched = await patch({ txHash: f.hash, wallet })
    expect([patched.status, await patched.json()]).toEqual([200, { ok: false, error: 'storage_unavailable' }])
    expect(down.rows()).toEqual([])
    expect(logged).toEqual([])
    expect(rpc.calls).toEqual([])
  })
})
