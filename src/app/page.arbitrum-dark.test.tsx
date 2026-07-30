// @vitest-environment jsdom
/**
 * [CHORE-ARBITRUM-ACTIVATION-SWITCH-PROOF] Page-level proof that the real (unmocked) dark state
 * on Arbitrum actually blocks <DCAPanel> from mounting.
 *
 * page.test.tsx mocks '@/lib/dca-launch' entirely (a file-scoped vi.mock, so it can't be
 * selectively un-mocked for one test in that file) — it pins the page's WIRING to isDcaLive, not
 * isDcaLive's own real behavior. This file is the real-gate counterpart: it mounts the actual
 * Home component (src/app/page.tsx — the real owner of the Coming-Soon-vs-<DCAPanel> branch) with
 * the connected chain set to Arbitrum (42161) and the real, unmocked dca-launch module. All
 * Arbitrum/launch env vars are explicitly cleared so the test doesn't depend on ambient process
 * state; today's real default (both Arbitrum vars unset) is exercised, proving the teaser shows
 * and DCAPanel never mounts — the state this repo will be in until the deploy + env flip lands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'

const useChainIdMock = vi.fn(() => 42161)

vi.mock('wagmi', () => ({ useChainId: () => useChainIdMock() }))
vi.mock('@/lib/sounds', () => ({ playTouchMP3: vi.fn() }))
// '@/lib/dca-launch' and '@/lib/order-engine' (isLimitLive) are intentionally NOT mocked here —
// the real gates run against real env.

// Stub every heavy child so Home mounts in jsdom without canvas / RPC / providers — identical to
// page.test.tsx's stub set, so the only behavioral difference from that file is the real gate.
vi.mock('@/components/ParticleNetwork', () => ({ default: () => null }))
vi.mock('@/components/LandingPage', () => ({
  default: ({ onLaunchApp }: { onLaunchApp: () => void }) => (
    <button onClick={onLaunchApp}>launch-app</button>
  ),
}))
vi.mock('@/components/ScrollSpy', () => ({ default: () => null }))
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

import { render, screen, fireEvent, within } from '@testing-library/react'
import Home from './page'

function renderSwapView() {
  render(<Home />)
  fireEvent.click(screen.getByText('launch-app'))
}

function tabButtons(): HTMLButtonElement[] {
  return screen.getAllByRole('button') as HTMLButtonElement[]
}

function dcaTab(): HTMLButtonElement {
  const btn = tabButtons().find(b => /^DCA/.test(b.textContent ?? ''))
  if (!btn) throw new Error('DCA tab not found')
  return btn
}

const ENV_KEYS = [
  'NEXT_PUBLIC_DCA_ENABLED',
  'NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR',
  'NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM',
] as const

beforeEach(() => {
  vi.clearAllMocks()
  useChainIdMock.mockReturnValue(42161)
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Home — real Arbitrum dark state (no mocked dca-launch)', () => {
  it("today's real defaults (both Arbitrum vars unset) ⇒ DCA tab is the Soon teaser and <DCAPanel> never mounts", () => {
    renderSwapView()
    const tab = dcaTab()
    expect(tab).toBeDisabled()
    expect(within(tab).getByText('Soon')).toBeInTheDocument()

    // The tab is disabled, so a real user (and jsdom) can never select it — the swap mode stays
    // on 'instant' and neither the teaser nor <DCAPanel> ever render. That IS the proof: the DCA
    // panel is unreachable, not merely unmounted-by-default.
    fireEvent.click(tab)
    expect(screen.queryByTestId('dca-panel')).not.toBeInTheDocument()
    expect(screen.queryByText(/Coming Soon on L2/i)).not.toBeInTheDocument()
  })

  it('even with the launch flag on, Arbitrum stays dark (FeeCollector + v3 still unset) ⇒ still the teaser', async () => {
    vi.stubEnv('NEXT_PUBLIC_DCA_ENABLED', 'true')
    renderSwapView()
    const tab = dcaTab()
    expect(tab).toBeDisabled()
    expect(within(tab).getByText('Soon')).toBeInTheDocument()

    fireEvent.click(tab)
    expect(screen.queryByTestId('dca-panel')).not.toBeInTheDocument()
  })
})
