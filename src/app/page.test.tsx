// @vitest-environment jsdom
/**
 * [SPRINT-DCA-UNGATE] Home page DCA-tab gating.
 *
 * page.tsx decides whether the DCA tab is the "Soon" teaser (disabled tab +
 * "Soon" pill — byte-identical to today) or the live, clickable DCA panel,
 * based purely on isDcaLive(connectedChainId). The flag + chain semantics of
 * isDcaLive itself are covered in src/lib/dca-launch.test.ts; here we mock it
 * to pin the page WIRING: the page passes the connected chain to the gate and
 * renders the teaser vs the panel accordingly.
 *
 *   - not live (flag off, any chain) ⇒ DCA tab disabled + "Soon" pill (teaser)
 *   - live + Base                    ⇒ DCA tab enabled, no pill, renders DCAPanel
 *   - flag on + mainnet (not live)   ⇒ DCA tab disabled + "Soon" pill (not offered)
 *
 * [SPRINT-P1B / ADR-014 (a)] Limit / SL·TP are back in the nav, gated by isLimitLive exactly the
 * way DCA is gated by isDcaLive. They were unwired by CHORE-ORDER-EXEC-PREP B while non-DCA was
 * structurally unexecutable (threat-model P1c); the pinned-route model makes them executable.
 * Guarded below: gated-off ⇒ "Soon" teaser (never a mountable panel), gated-on ⇒ live panel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'

const useChainIdMock = vi.fn(() => 8453)
const isDcaLiveMock = vi.fn<(chainId: number) => boolean>()
const isLimitLiveMock = vi.fn<(chainId: number) => boolean>()

vi.mock('wagmi', () => ({ useChainId: () => useChainIdMock() }))
vi.mock('@/lib/dca-launch', () => ({ isDcaLive: (id: number) => isDcaLiveMock(id) }))
// [SPRINT-P1B] Only the launch gate is needed from the order-engine barrel here.
vi.mock('@/lib/order-engine', () => ({ isLimitLive: (id: number) => isLimitLiveMock(id) }))
vi.mock('@/lib/sounds', () => ({ playTouchMP3: vi.fn() }))

// Stub every heavy child so Home mounts in jsdom without canvas / RPC / providers.
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

/** Render Home and click into the swap view (Home starts on the landing page). */
function renderSwapView() {
  render(<Home />)
  fireEvent.click(screen.getByText('launch-app'))
}

function tabButtons(): HTMLButtonElement[] {
  return screen.getAllByRole('button') as HTMLButtonElement[]
}

/** Find a mode-toggle tab by its leading label (textContent, e.g. "DCASoon"). */
function tabByLabel(re: RegExp): HTMLButtonElement {
  const btn = tabButtons().find(b => re.test(b.textContent ?? ''))
  if (!btn) throw new Error(`tab not found for ${re}`)
  return btn
}

/** The DCA tab button in the mode toggle. */
function dcaTab(): HTMLButtonElement {
  return tabByLabel(/^DCA/)
}

beforeEach(() => {
  vi.clearAllMocks()
  useChainIdMock.mockReturnValue(8453)
  isDcaLiveMock.mockReturnValue(false)
  // [SPRINT-P1B] Fail-closed default, matching the real gate with the flag unset.
  isLimitLiveMock.mockReturnValue(false)
})

describe('Home — DCA tab gating', () => {
  it('not live ⇒ DCA tab is the "Soon" teaser (disabled + "Soon" pill), byte-identical to today', () => {
    isDcaLiveMock.mockReturnValue(false)
    renderSwapView()
    const tab = dcaTab()
    expect(tab).toBeDisabled()
    expect(within(tab).getByText('Soon')).toBeInTheDocument()
  })

  it('live + Base ⇒ DCA tab is enabled with no "Soon" pill, and selecting it renders the DCA panel', async () => {
    useChainIdMock.mockReturnValue(8453)
    isDcaLiveMock.mockImplementation((id) => id === 8453)
    renderSwapView()
    const tab = dcaTab()
    expect(tab).not.toBeDisabled()
    expect(within(tab).queryByText('Soon')).toBeNull()
    // Selecting it shows the functional panel, never the "Coming Soon" teaser.
    fireEvent.click(tab)
    expect(await screen.findByTestId('dca-panel')).toBeInTheDocument()
    expect(screen.queryByText(/Coming Soon on L2/i)).toBeNull()
  })

  it('flag on but on mainnet ⇒ DCA not offered (disabled + "Soon" pill); page passes the connected chainId', () => {
    useChainIdMock.mockReturnValue(1)
    // Mainnet is not live (the gate's Base-only pin); the page must consult the connected chain.
    isDcaLiveMock.mockImplementation((id) => id === 8453)
    renderSwapView()
    const tab = dcaTab()
    expect(isDcaLiveMock).toHaveBeenCalledWith(1)
    expect(tab).toBeDisabled()
    expect(within(tab).getByText('Soon')).toBeInTheDocument()
  })

  // ── [SPRINT-P1B / ADR-014 (a)] Limit + SL/TP gating ──────────────────────────────────────
  const limitTab = () => tabButtons().find(b => /Limit/i.test(b.textContent ?? ''))!
  const sltpTab = () => tabButtons().find(b => /SL\s*\/\s*TP/i.test(b.textContent ?? ''))!

  it('Limit & SL/TP tabs exist again, but stay "Soon" while the limit gate is closed', () => {
    isLimitLiveMock.mockReturnValue(false)
    renderSwapView()
    expect(limitTab()).toBeDisabled()
    expect(within(limitTab()).getByText('Soon')).toBeInTheDocument()
    expect(sltpTab()).toBeDisabled()
    expect(within(sltpTab()).getByText('Soon')).toBeInTheDocument()
  })

  it('limit gate closed ⇒ selecting Limit can never mount the panel (teaser only)', () => {
    isLimitLiveMock.mockReturnValue(false)
    renderSwapView()
    fireEvent.click(limitTab())
    expect(screen.queryByTestId('limit-panel')).not.toBeInTheDocument()
  })

  it('limit gate open ⇒ Limit tab is enabled and mounts LimitOrderPanel', async () => {
    isLimitLiveMock.mockImplementation((id) => id === 8453)
    renderSwapView()
    expect(isLimitLiveMock).toHaveBeenCalledWith(8453)
    expect(limitTab()).toBeEnabled()
    fireEvent.click(limitTab())
    // next/dynamic mounts asynchronously — mirrors the DCA panel assertion above.
    expect(await screen.findByTestId('limit-panel')).toBeInTheDocument()
    expect(screen.queryByText(/Coming Soon on L2/i)).toBeNull()
  })

  it('limit gate open ⇒ SL/TP tab mounts the (Take-Profit-only) ConditionalOrderPanel', async () => {
    isLimitLiveMock.mockImplementation((id) => id === 8453)
    renderSwapView()
    fireEvent.click(sltpTab())
    expect(await screen.findByTestId('sltp-panel')).toBeInTheDocument()
  })

  it('limit gate consults the CONNECTED chain — mainnet stays gated even with the flag on', () => {
    useChainIdMock.mockReturnValue(1)
    isLimitLiveMock.mockImplementation((id) => id === 8453)
    renderSwapView()
    expect(isLimitLiveMock).toHaveBeenCalledWith(1)
    expect(limitTab()).toBeDisabled()
  })
})
