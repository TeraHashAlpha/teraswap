// @vitest-environment jsdom
/**
 * /swap is a real App Router page that renders the existing swap experience
 * by importing SwapBox (and the rest of the in-app shell). It must not 404
 * and must not require the landing "Launch app" callback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'

const useChainIdMock = vi.fn(() => 8453)
const isDcaLiveMock = vi.fn<(chainId: number) => boolean>()
const isLimitLiveMock = vi.fn<(chainId: number) => boolean>()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('wagmi', () => ({ useChainId: () => useChainIdMock() }))
vi.mock('@/lib/dca-launch', () => ({ isDcaLive: (id: number) => isDcaLiveMock(id) }))
vi.mock('@/lib/order-engine', () => ({ isLimitLive: (id: number) => isLimitLiveMock(id) }))
vi.mock('@/lib/sounds', () => ({ playTouchMP3: vi.fn() }))

vi.mock('@/components/ParticleNetwork', () => ({ default: () => null }))
vi.mock('@/components/Header', () => ({ default: () => null }))
vi.mock('@/components/SwapBox', () => ({ default: () => <div data-testid="swapbox" /> }))
vi.mock('@/components/SwapHistory', () => ({ default: () => null }))
vi.mock('@/components/Footer', () => ({ default: () => null }))
vi.mock('@/components/SwapErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/HelpButton', () => ({ default: () => null }))
vi.mock('@/components/NotificationBanner', () => ({ default: () => null }))
vi.mock('@/components/DCAPanel', () => ({ default: () => <div data-testid="dca-panel">DCA Panel</div> }))
vi.mock('@/components/LimitOrderPanel', () => ({ default: () => <div data-testid="limit-panel">Limit Panel</div> }))
vi.mock('@/components/ConditionalOrderPanel', () => ({ default: () => <div data-testid="sltp-panel">SL/TP Panel</div> }))
vi.mock('@/components/AnalyticsDashboard', () => ({ default: () => null }))
vi.mock('@/components/OrderDashboard', () => ({ default: () => null }))
vi.mock('@/components/WalletHistory', () => ({ default: () => null }))
vi.mock('@/components/PortfolioTab', () => ({ default: () => null }))

import { render, screen } from '@testing-library/react'
import SwapPage from './page'

beforeEach(() => {
  vi.clearAllMocks()
  useChainIdMock.mockReturnValue(8453)
  isDcaLiveMock.mockReturnValue(false)
  isLimitLiveMock.mockReturnValue(false)
})

describe('/swap page', () => {
  it('renders the swap UI on first paint (no landing callback, not a 404)', () => {
    expect(() => render(<SwapPage />)).not.toThrow()
    expect(screen.getByTestId('swapbox')).toBeInTheDocument()
  })
})
