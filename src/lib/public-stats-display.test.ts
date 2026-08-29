/**
 * Display rules for public protocol stats. These tests drive the shipped
 * helper — they do not re-implement it, and they do not invent figures.
 */

import { describe, it, expect } from 'vitest'
import {
  NOT_AVAILABLE_YET,
  protocolStatsGate,
  countMetric,
  listMetric,
  gaslessMetrics,
} from './public-stats-display'

describe('protocolStatsGate', () => {
  it('stays in loading until a payload arrives (no zeroed figures)', () => {
    expect(protocolStatsGate(null, { loading: true, failed: false })).toEqual({
      status: 'loading',
    })
  })

  it('treats a failed fetch as not available yet, with a reason', () => {
    const view = protocolStatsGate(null, { loading: false, failed: true })
    expect(view).toMatchObject({
      status: 'unavailable',
      message: NOT_AVAILABLE_YET,
    })
    if (view.status === 'unavailable') {
      expect(view.reason.length).toBeGreaterThan(0)
    }
  })

  it('treats { enabled: false } as not available yet, with a reason', () => {
    const view = protocolStatsGate(
      { enabled: false },
      { loading: false, failed: false },
    )
    expect(view).toEqual({
      status: 'unavailable',
      message: NOT_AVAILABLE_YET,
      reason: 'The stats backend is not configured.',
    })
  })

  it('surfaces the API error string as the reason when present', () => {
    const view = protocolStatsGate(
      { enabled: false, error: 'Failed to fetch stats' },
      { loading: false, failed: false },
    )
    expect(view).toEqual({
      status: 'unavailable',
      message: NOT_AVAILABLE_YET,
      reason: 'Failed to fetch stats',
    })
  })

  it('marks an enabled payload as ready without inventing numbers', () => {
    expect(
      protocolStatsGate({ enabled: true }, { loading: false, failed: false }),
    ).toEqual({ status: 'ready' })
  })
})

describe('countMetric', () => {
  it('refuses zero, missing, and non-finite values as measurements', () => {
    for (const value of [0, undefined, null, Number.NaN, -1] as const) {
      const view = countMetric(value, 'No swaps recorded yet.')
      expect(view).toEqual({
        available: false,
        message: NOT_AVAILABLE_YET,
        reason: 'No swaps recorded yet.',
      })
    }
  })

  it('passes through a real positive number received from the API', () => {
    expect(countMetric(3, 'No swaps recorded yet.')).toEqual({
      available: true,
      value: 3,
    })
  })
})

describe('listMetric', () => {
  it('treats an empty or missing list as not available yet', () => {
    expect(listMetric([], 'No swap-source breakdown recorded yet.')).toEqual({
      available: false,
      message: NOT_AVAILABLE_YET,
      reason: 'No swap-source breakdown recorded yet.',
    })
    expect(listMetric(undefined, 'No swap-source breakdown recorded yet.')).toMatchObject({
      available: false,
      message: NOT_AVAILABLE_YET,
    })
  })

  it('passes through a non-empty list received from the API', () => {
    const items: [string, number][] = [['1inch', 4]]
    expect(listMetric(items, 'No swap-source breakdown recorded yet.')).toEqual({
      available: true,
      items,
    })
  })

  it('drops zero-count rows instead of charting them as measurements', () => {
    expect(
      listMetric(
        [['1inch', 0], ['cowswap', 0]],
        'No swap-source breakdown recorded yet.',
      ),
    ).toMatchObject({
      available: false,
      message: NOT_AVAILABLE_YET,
    })
    expect(
      listMetric(
        [['1inch', 0], ['cowswap', 4]],
        'No swap-source breakdown recorded yet.',
      ),
    ).toEqual({
      available: true,
      items: [['cowswap', 4]],
    })
  })
})

describe('gaslessMetrics', () => {
  it('does not present a zeroed gasless block as measurements', () => {
    const view = gaslessMetrics({
      totalGaslessSwaps: 0,
      totalGasSavedUsd: 0,
      gaslessRatio: 0,
      avgGasSavingsPerSwap: 0,
    })
    expect(view.totalGaslessSwaps.available).toBe(false)
    expect(view.totalGasSavedUsd.available).toBe(false)
    expect(view.gaslessRatio.available).toBe(false)
    expect(view.avgGasSavingsPerSwap.available).toBe(false)
  })
})
