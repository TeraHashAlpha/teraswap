/**
 * [P98] Tests for the per-wallet swap aggregation.
 *
 * We test the pure `aggregatePersonalAnalytics` function with row
 * fixtures rather than the Supabase-fetching wrapper — that's both
 * faster and isolates the math from network setup.
 */

import { describe, it, expect } from 'vitest'
import { aggregatePersonalAnalytics } from './personal-analytics'

const WALLET = '0x1234567890abcdef1234567890abcdef12345678'

interface RowOverrides {
  created_at?: string
  source?: string
  token_in_symbol?: string | null
  token_out_symbol?: string | null
  amount_in_usd?: number | string | null
  is_gasless?: boolean | null
  gas_savings_usd?: number | string | null
  status?: string | null
  tx_hash?: string | null
}

function row(overrides: RowOverrides = {}) {
  return {
    created_at: '2026-05-01T12:00:00.000Z',
    source: '1inch',
    token_in_symbol: 'USDC',
    token_out_symbol: 'ETH',
    amount_in_usd: 1000,
    is_gasless: false,
    gas_savings_usd: 0,
    status: 'confirmed',
    tx_hash: '0xabc',
    ...overrides,
  }
}

describe('aggregatePersonalAnalytics', () => {
  it('returns the empty shape when the wallet has no swaps', () => {
    const out = aggregatePersonalAnalytics(WALLET, [])
    expect(out.wallet).toBe(WALLET.toLowerCase())
    expect(out.totalSwaps).toBe(0)
    expect(out.totalVolumeUsd).toBe(0)
    expect(out.gaslessRatio).toBe(0)
    expect(out.sourceWinRates).toEqual({})
    expect(out.topPairs).toEqual([])
    expect(out.bestHour).toBeNull()
    expect(out.bestDayOfWeek).toBeNull()
    expect(out.periodStart).toBe('')
    expect(out.periodEnd).toBe('')
  })

  it('counts confirmed and pending-with-tx swaps; ignores pending-without-tx and failed', () => {
    const rows = [
      row({ status: 'confirmed', tx_hash: '0x1' }),
      row({ status: 'pending', tx_hash: '0x2' }), // counts (real on-chain tx)
      row({ status: 'pending', tx_hash: null }),  // ignored (abandoned)
      row({ status: 'failed', tx_hash: '0x3' }),  // ignored (reverted)
    ]
    const out = aggregatePersonalAnalytics(WALLET, rows)
    expect(out.totalSwaps).toBe(2)
  })

  it('sums totalVolumeUsd across completed swaps', () => {
    const rows = [
      row({ amount_in_usd: 1000 }),
      row({ amount_in_usd: 2500.50 }),
      row({ amount_in_usd: 0 }),     // ignored
      row({ amount_in_usd: null }),  // ignored
    ]
    const out = aggregatePersonalAnalytics(WALLET, rows)
    expect(out.totalSwaps).toBe(4)
    expect(out.totalVolumeUsd).toBe(3500.50)
  })

  it('computes gaslessSwapCount, totalGasSavedUsd and gaslessRatio', () => {
    const rows = [
      row({ source: 'cowswap', is_gasless: true, gas_savings_usd: 4.20 }),
      row({ source: 'cowswap', is_gasless: true, gas_savings_usd: 8.80 }),
      row({ source: '1inch',  is_gasless: false, gas_savings_usd: 0 }),
      row({ source: 'velora', is_gasless: false, gas_savings_usd: 0 }),
    ]
    const out = aggregatePersonalAnalytics(WALLET, rows)
    expect(out.gaslessSwapCount).toBe(2)
    expect(out.totalGasSavedUsd).toBe(13)
    expect(out.gaslessRatio).toBe(0.5)
  })

  it('computes sourceWinRates as percentages summing to ~100', () => {
    const rows = [
      row({ source: '1inch' }),
      row({ source: '1inch' }),
      row({ source: 'cowswap' }),
      row({ source: 'velora' }),
    ]
    const out = aggregatePersonalAnalytics(WALLET, rows)
    expect(out.sourceWinRates['1inch']).toBe(50)
    expect(out.sourceWinRates['cowswap']).toBe(25)
    expect(out.sourceWinRates['velora']).toBe(25)
    const sum = Object.values(out.sourceWinRates).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(100, 2)
  })

  it('returns top 5 pairs sorted by count then volume', () => {
    const rows = [
      row({ token_in_symbol: 'USDC', token_out_symbol: 'ETH', amount_in_usd: 100 }),
      row({ token_in_symbol: 'USDC', token_out_symbol: 'ETH', amount_in_usd: 100 }),
      row({ token_in_symbol: 'WBTC', token_out_symbol: 'USDC', amount_in_usd: 50 }),
      row({ token_in_symbol: 'DAI',  token_out_symbol: 'ETH', amount_in_usd: 75 }),
      row({ token_in_symbol: 'USDT', token_out_symbol: 'ETH', amount_in_usd: 75 }),
      row({ token_in_symbol: 'PEPE', token_out_symbol: 'ETH', amount_in_usd: 75 }),
      row({ token_in_symbol: 'LINK', token_out_symbol: 'ETH', amount_in_usd: 75 }),
    ]
    const out = aggregatePersonalAnalytics(WALLET, rows)
    expect(out.topPairs).toHaveLength(5)
    expect(out.topPairs[0]).toEqual({ pair: 'USDC/ETH', count: 2, volumeUsd: 200 })
    // Remaining 5 pairs all have count=1 — alphabetical tie-break isn't
    // guaranteed, but each entry's count must be 1 and volume present.
    for (const p of out.topPairs.slice(1)) {
      expect(p.count).toBe(1)
      expect(p.volumeUsd).toBeGreaterThan(0)
    }
  })

  it('returns null bestHour/bestDayOfWeek below 10 swaps (noise threshold)', () => {
    const rows = Array.from({ length: 9 }, () => row())
    const out = aggregatePersonalAnalytics(WALLET, rows)
    expect(out.bestHour).toBeNull()
    expect(out.bestDayOfWeek).toBeNull()
  })

  it('returns bestHour/bestDayOfWeek when ≥10 swaps and a dominant bucket exists', () => {
    // 10 swaps all on the same UTC Tuesday at 14:00 — bestHour=14, bestDow=2.
    const rows = Array.from({ length: 10 }, () =>
      row({ created_at: '2026-05-05T14:00:00.000Z' }),
    )
    const out = aggregatePersonalAnalytics(WALLET, rows)
    expect(out.bestHour).toBe(14)
    expect(out.bestDayOfWeek).toBe(2) // 2026-05-05 is a Tuesday
  })

  it('records earliest periodStart and latest periodEnd', () => {
    const rows = [
      row({ created_at: '2026-04-01T00:00:00.000Z' }),
      row({ created_at: '2026-05-15T12:00:00.000Z' }),
      row({ created_at: '2026-03-20T09:00:00.000Z' }),
    ]
    const out = aggregatePersonalAnalytics(WALLET, rows)
    expect(out.periodStart).toBe('2026-03-20T09:00:00.000Z')
    expect(out.periodEnd).toBe('2026-05-15T12:00:00.000Z')
  })

  it('normalises the wallet to lowercase', () => {
    const out = aggregatePersonalAnalytics(WALLET.toUpperCase(), [])
    expect(out.wallet).toBe(WALLET.toLowerCase())
  })
})
