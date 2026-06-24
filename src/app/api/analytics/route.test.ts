import { describe, it, expect, vi, afterEach } from 'vitest'

// The analytics route imports `@/lib/supabase` at module scope. We never
// exercise the live query in these tests (they target the pure merge/compute
// layer), so stub it to null — same pattern as log-swap/route.test.ts.
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => null,
  getSupabaseLogger: () => null,
  isSupabaseEnabled: () => false,
}))

import { computeDashboard, executionToEvent } from './route'

const WETH = 18
const tenWeth = (10n * 10n ** BigInt(WETH)).toString()

// A confirmed instant swap on mainnet, valued via its stored amount_in_usd.
function swapRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'swap-1',
    created_at: '2026-06-24T10:00:00.000Z',
    wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    tx_hash: '0xswap1',
    chain_id: 1,
    status: 'confirmed',
    source: '1inch',
    token_in: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // gitleaks:allow — public WETH ERC-20 address, not a secret
    token_in_symbol: 'WETH',
    token_out: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // gitleaks:allow — public USDC ERC-20 address, not a secret
    token_out_symbol: 'USDC',
    amount_in: (1n * 10n ** 18n).toString(),
    amount_out: '3500000000',
    amount_in_usd: 3500,
    amount_out_usd: 3500,
    fee_collected: true,
    ...overrides,
  }
}

// A DCA chunk recorded in order_executions, with the parent order embedded.
// The keeper records the FULL order amount on every execution row
// (executor.js recordExecution → dbOrder.amount_in), so the per-chunk volume
// MUST be derived from orders.amount_in / dca_total, never the raw row amount.
function execRow(overrides: Record<string, unknown> = {}, orderOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'exec-1',
    created_at: '2026-06-24T11:00:00.000Z',
    tx_hash: '0x4691b42a570290c84c63c23f702d258e2bc766f5078dc312eb32400d169d7fac',
    amount_in: tenWeth, // full order amount (keeper limitation) — must NOT be used directly
    amount_out: '0',
    status: 'confirmed',
    order_id: 'order-4ed3d6de',
    orders: {
      wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      order_type: 'dca',
      token_in: '0x4200000000000000000000000000000000000006',
      token_in_symbol: 'WETH',
      token_out: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', // gitleaks:allow — public UNI ERC-20 address, not a secret
      token_out_symbol: 'UNI',
      chain_id: 8453,
      router: '0x6A000F20005980200259B80c5102003040001068', // Augustus V6 → velora
      dca_total: 10,
      amount_in: tenWeth,
      ...orderOverrides,
    },
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('computeDashboard — DCA/order executions in analytics', () => {
  it('counts each DCA execution exactly once, alongside instant swaps', () => {
    const d = computeDashboard([swapRow()], [execRow()])
    expect(d.allTime.tradeCount).toBe(2)
    const dcaRows = d.recentTrades.filter(
      (t) => t.txHash === '0x4691b42a570290c84c63c23f702d258e2bc766f5078dc312eb32400d169d7fac',
    )
    expect(dcaRows).toHaveLength(1)
  })

  it('labels DCA executions, carries route + chain from the parent order', () => {
    const d = computeDashboard([], [execRow()])
    const dca = d.recentTrades[0]
    expect(dca.type).toBe('dca_buy')
    expect(dca.source).toBe('velora') // Augustus V6 router → velora (groups with instant velora swaps)
    expect(dca.chainId).toBe(8453)
    expect(dca.tokenIn).toBe('WETH')
    expect(dca.tokenOut).toBe('UNI')
  })

  it('values a chunk as orders.amount_in / dca_total (no overcount from the full-amount row)', () => {
    const d = computeDashboard([], [execRow()])
    // 10 WETH / 10 chunks = 1 WETH → 1 * APPROX_PRICES.WETH (3500) = 3500, NOT 35000
    expect(d.allTime.totalVolume).toBe(3500)
    expect(d.recentTrades[0].volumeUsd).toBe(3500)
  })

  it('includes executions in totals, Best Routes, Popular Pairs', () => {
    const d = computeDashboard([swapRow()], [execRow()])
    expect(d.allTime.totalVolume).toBe(7000) // 3500 swap + 3500 dca chunk

    const velora = d.bySource.find((s) => s.source === 'velora')
    expect(velora).toBeDefined()
    expect(velora!.tradeCount).toBe(1)
    expect(velora!.volumeUsd).toBe(3500)

    const pair = d.topPairs.find((p) => p.pair === 'WETH/UNI')
    expect(pair).toBeDefined()
    expect(pair!.tradeCount).toBe(1)
  })

  it('keeps winRate as quote-win share (executions never dilute instant-swap win rates)', () => {
    // 1 instant swap (1inch) + 1 DCA fill (velora). winRate is a QUOTE contest,
    // which DCA fills do not enter: 1inch must stay at 100% (1 of 1 swaps won),
    // and velora — present only via the execution — is 0% (won no quote).
    const d = computeDashboard([swapRow({ source: '1inch' })], [execRow()])
    const oneInch = d.bySource.find((s) => s.source === '1inch')
    const velora = d.bySource.find((s) => s.source === 'velora')
    expect(oneInch!.winRate).toBe(100)
    expect(velora!.tradeCount).toBe(1) // still counted in Best Routes
    expect(velora!.volumeUsd).toBe(3500)
    expect(velora!.winRate).toBe(0) // but won no quote
  })

  it('winRate for swaps-only input is identical to pre-change behaviour', () => {
    // Two instant swaps, different sources → 50/50, exactly as before executions
    // were ever merged in (no regression).
    const d = computeDashboard(
      [swapRow({ id: 's1', tx_hash: '0xa', source: '1inch' }), swapRow({ id: 's2', tx_hash: '0xb', source: 'cowswap' })],
      [],
    )
    expect(d.bySource.find((s) => s.source === '1inch')!.winRate).toBe(50)
    expect(d.bySource.find((s) => s.source === 'cowswap')!.winRate).toBe(50)
  })

  it('feeds Volume Trend + last24h windows (deterministic clock)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-24T12:00:00.000Z'))
    const d = computeDashboard([swapRow()], [execRow()])
    expect(d.last24h.tradeCount).toBe(2)
    expect(d.last24h.totalVolume).toBe(7000)
    const totalDailyTrades = d.dailyVolume.reduce((s, x) => s + x.tradeCount, 0)
    expect(totalDailyTrades).toBe(2)
  })

  it('never double-counts a tx present in both tables (swap wins)', () => {
    const d = computeDashboard(
      [swapRow({ tx_hash: '0xdup' })],
      [execRow({ tx_hash: '0xdup' })],
    )
    expect(d.allTime.tradeCount).toBe(1)
    expect(d.recentTrades[0].type).toBe('swap')
  })

  it('does not regress instant-swap analytics when there are no executions', () => {
    const d = computeDashboard([swapRow()], [])
    expect(d.allTime.tradeCount).toBe(1)
    expect(d.allTime.totalVolume).toBe(3500)
    expect(d.recentTrades[0].type).toBe('swap')
  })

  it('skips execution rows whose parent order failed to embed (no crash)', () => {
    const d = computeDashboard([], [execRow({ orders: null })])
    expect(d.allTime.tradeCount).toBe(0)
    expect(executionToEvent(execRow({ orders: null }))).toBeNull()
  })

  it('maps limit/stop-loss order types to their dashboard labels', () => {
    const limit = executionToEvent(execRow({}, { order_type: 'limit', dca_total: 1, amount_in: (1n * 10n ** 18n).toString() }))
    const sltp = executionToEvent(execRow({}, { order_type: 'stop_loss', dca_total: 1, amount_in: (1n * 10n ** 18n).toString() }))
    expect(limit?.type).toBe('limit_fill')
    expect(sltp?.type).toBe('sltp_trigger')
  })
})
