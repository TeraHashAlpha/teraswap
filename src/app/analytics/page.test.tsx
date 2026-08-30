// @vitest-environment jsdom
/**
 * /analytics must show public protocol stats with NO wallet connected.
 * PersonalDashboard is additional, and only mounts when a wallet is connected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const useAccountMock = vi.fn(() => ({ isConnected: false }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
}))
vi.mock('@/components/ParticleNetwork', () => ({ default: () => null }))
vi.mock('@/components/Header', () => ({ default: () => null }))
vi.mock('@/components/Footer', () => ({ default: () => null }))
vi.mock('@/components/PersonalDashboard', () => ({
  default: () => <div data-testid="personal-dashboard">My Analytics</div>,
}))

import { render, screen } from '@testing-library/react'
import AnalyticsPage from './page'

const SAMPLE_STATS = {
  enabled: true,
  totalSwaps: 17,
  totalQuotes: 42,
  topSwapSources: [['1inch', 10]] as [string, number][],
  topQuoteWinners: [['cowswap', 5]] as [string, number][],
  gasless: {
    totalGaslessSwaps: 3,
    totalGasSavedUsd: 1.25,
    gaslessRatio: 0.1765,
    avgGasSavingsPerSwap: 0.42,
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ isConnected: false })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      if (String(url) !== '/api/stats') {
        throw new Error(`unexpected fetch: ${String(url)}`)
      }
      return {
        ok: true,
        json: async () => SAMPLE_STATS,
      }
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/analytics page — public protocol stats', () => {
  it('renders the public protocol section with no wallet connected', async () => {
    render(<AnalyticsPage />)
    expect(await screen.findByTestId('public-protocol-stats')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /protocol performance/i })).toBeInTheDocument()
    expect(await screen.findByText(SAMPLE_STATS.totalSwaps.toLocaleString())).toBeInTheDocument()
    expect(screen.queryByTestId('personal-dashboard')).not.toBeInTheDocument()
    expect(screen.queryByText(/connect a wallet to see your analytics/i)).not.toBeInTheDocument()
  })

  it('still shows PersonalDashboard in addition when a wallet is connected', async () => {
    useAccountMock.mockReturnValue({ isConnected: true })
    render(<AnalyticsPage />)
    expect(await screen.findByTestId('public-protocol-stats')).toBeInTheDocument()
    expect(await screen.findByTestId('personal-dashboard')).toBeInTheDocument()
  })

  it('says not available yet when /api/stats is disabled, with a reason and no zeroed metrics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ enabled: false }),
      })),
    )
    render(<AnalyticsPage />)
    const unavailable = await screen.findByTestId('protocol-stats-unavailable')
    expect(unavailable).toHaveTextContent(/not available yet/i)
    expect(unavailable).toHaveTextContent(/stats backend is not configured/i)
    expect(screen.queryByTestId('protocol-metric-totalSwaps')).not.toBeInTheDocument()
    expect(screen.queryByTestId('protocol-metric-totalQuotes')).not.toBeInTheDocument()
    expect(screen.queryByTestId('protocol-chart-sources')).not.toBeInTheDocument()
    expect(screen.queryByTestId('protocol-chart-winners')).not.toBeInTheDocument()
    expect(screen.queryByText('0')).not.toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument()
  })

  it('says not available yet for a metric with no data yet, without fabricating a zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          enabled: true,
          totalSwaps: 0,
          totalQuotes: SAMPLE_STATS.totalQuotes,
          topSwapSources: [],
          topQuoteWinners: SAMPLE_STATS.topQuoteWinners,
        }),
      })),
    )
    render(<AnalyticsPage />)
    const emptySwaps = await screen.findByTestId('protocol-metric-totalSwaps-unavailable')
    expect(emptySwaps).toHaveTextContent(/not available yet/i)
    expect(emptySwaps).toHaveTextContent(/no swaps recorded yet/i)
    expect(screen.queryByTestId('protocol-metric-totalSwaps')).not.toBeInTheDocument()
    expect(screen.getByTestId('protocol-metric-totalQuotes')).toHaveTextContent(
      SAMPLE_STATS.totalQuotes.toLocaleString(),
    )
    expect(screen.getByTestId('protocol-chart-sources-unavailable')).toHaveTextContent(/not available yet/i)
    expect(screen.queryByTestId('protocol-chart-sources')).not.toBeInTheDocument()
    expect(screen.getByTestId('protocol-chart-winners')).toBeInTheDocument()
  })
})
