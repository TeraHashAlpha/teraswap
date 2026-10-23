// @vitest-environment jsdom
/**
 * [fix/functional-chain-ui F4] Popular Pairs and Volume Trend rendered from the REAL
 * /api/analytics transform (computeDashboard) over the five-day fixture — the list must show the
 * metric it is ranked by, and the chart must run oldest → newest left to right.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => null,
  getSupabaseLogger: () => null,
  isSupabaseEnabled: () => false,
}))
vi.mock('@/hooks/useAnalytics', () => ({ useAnalytics: () => ({ dashboard: null, loading: false }) }))

import { PopularPairs, DailyVolumeChart } from './AnalyticsDashboard'
import { computeDashboard } from '@/app/api/analytics/route'
import { FIVE_DAY_NOW, FIVE_DAY_SWAPS } from '@/lib/__fixtures__/analytics-five-days'

function fiveDayDashboard() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(FIVE_DAY_NOW))
  const d = computeDashboard(FIVE_DAY_SWAPS, [])
  vi.useRealTimers()
  return d
}

afterEach(() => {
  cleanup()
})

describe('PopularPairs', () => {
  it('prints the volume it is ranked by, in descending order (not trade counts)', () => {
    const { container } = render(<PopularPairs data={fiveDayDashboard().topPairs} />)
    const rows = Array.from(container.querySelectorAll('[title$=" trades"]'))

    expect(rows.map((r) => r.textContent)).toEqual(['1WBTC/USDC$5.0K', '2WETH/USDC$3.0K', '3WETH/DAI$170.00'])
    // Trade count moved to the row tooltip; it is no longer the visible metric.
    expect(rows.map((r) => r.getAttribute('title'))).toEqual(['1 trades', '2 trades', '5 trades'])
    expect(container.textContent).not.toMatch(/\d+ trades/)
  })
})

describe('DailyVolumeChart', () => {
  it('draws bars oldest → newest and labels the left edge with the oldest day', () => {
    const { container } = render(<DailyVolumeChart data={fiveDayDashboard().dailyVolume} />)
    const bars = Array.from(container.querySelectorAll('[title*=" trades)"]'))

    expect(bars.map((b) => b.getAttribute('title')?.split(':')[0])).toEqual(['20 Jun', '21 Jun', '22 Jun', '23 Jun', '24 Jun'])
    const axis = container.querySelector('.justify-between')
    expect(axis?.firstElementChild?.textContent).toBe('20 Jun')
    expect(axis?.lastElementChild?.textContent).toBe('24 Jun')
  })
})
