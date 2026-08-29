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
})
