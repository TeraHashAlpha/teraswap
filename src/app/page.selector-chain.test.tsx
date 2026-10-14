// @vitest-environment jsdom
/**
 * [fix/dca-chain-switch / P2] The DCA tab gate follows the SELECTOR chain (useQuoteChainId), not
 * wagmi's useChainId(). With no wallet, wagmi reports its config default (mainnet) — so a visitor who
 * picked Base in ChainSelector used to get the "Soon" teaser. Here wagmi's useChainId is pinned to 1
 * the whole time to prove it is never the source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'

const isConnectedMock = vi.fn(() => false)
const walletChainMock = vi.fn<() => number | undefined>(() => undefined)
const switchChainMock = vi.fn()
const isDcaLiveMock = vi.fn<(chainId: number) => boolean>()

vi.mock('wagmi', () => ({
  useChainId: () => 1, // wagmi's config default — must NOT drive the gate
  useAccount: () => ({ isConnected: isConnectedMock(), chain: walletChainMock() ? { id: walletChainMock() } : undefined }),
  useSwitchChain: () => ({ switchChain: switchChainMock }),
}))
vi.mock('@/lib/dca-launch', async () => ({
  ...(await vi.importActual<typeof import('@/lib/dca-launch')>('@/lib/dca-launch')),
  isDcaLive: (id: number) => isDcaLiveMock(id),
}))
vi.mock('@/lib/order-engine', () => ({ isLimitLive: () => false }))
vi.mock('@/lib/sounds', () => ({ playTouchMP3: vi.fn() }))
vi.mock('@/components/ParticleNetwork', () => ({ default: () => null }))
vi.mock('@/components/LandingPage', () => ({
  default: ({ onLaunchApp }: { onLaunchApp: () => void }) => <button onClick={onLaunchApp}>launch-app</button>,
}))
vi.mock('@/components/ScrollSpy', () => ({ default: () => null }))
vi.mock('@/components/Header', () => ({ default: () => null }))
vi.mock('@/components/SwapBox', () => ({ default: () => <div data-testid="swapbox" /> }))
vi.mock('@/components/SwapHistory', () => ({ default: () => null }))
vi.mock('@/components/Footer', () => ({ default: () => null }))
vi.mock('@/components/SwapErrorBoundary', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/HelpButton', () => ({ default: () => null }))
vi.mock('@/components/NotificationBanner', () => ({ default: () => null }))
vi.mock('@/components/DCAPanel', () => ({
  default: ({ chainId }: { chainId?: number }) => <div data-testid="dca-panel" data-chain={chainId} />,
}))
vi.mock('@/components/LimitOrderPanel', () => ({ default: () => null }))
vi.mock('@/components/ConditionalOrderPanel', () => ({ default: () => null }))
vi.mock('@/components/AnalyticsDashboard', () => ({ default: () => null }))
vi.mock('@/components/OrderDashboard', () => ({ default: () => null }))
vi.mock('@/components/WalletHistory', () => ({ default: () => null }))
vi.mock('@/components/PortfolioTab', () => ({ default: () => null }))

import { render, screen, fireEvent, within, act } from '@testing-library/react'
import Home from './page'
import { useDisconnectedChainSelection } from '@/hooks/useChainId'

const tabs = () => screen.getAllByRole('button') as HTMLButtonElement[]
const dcaTab = () => tabs().find(b => /^DCA/.test(b.textContent ?? ''))!
function renderSwapView() {
  render(<Home />)
  fireEvent.click(screen.getByText('launch-app'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_DCA_ENABLED', 'true')
  isConnectedMock.mockReturnValue(false)
  walletChainMock.mockReturnValue(undefined)
  isDcaLiveMock.mockImplementation((id) => id === 8453 || id === 42161)
  useDisconnectedChainSelection.setState({ chainId: null })
})
afterEach(() => vi.unstubAllEnvs())

describe('Home — DCA gate follows the selector chain [P2]', () => {
  it('no wallet + Base selected ⇒ DCA is live (tab enabled, panel mounts keyed/fed the selector chain)', async () => {
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    renderSwapView()
    expect(isDcaLiveMock).toHaveBeenCalledWith(8453)
    expect(isDcaLiveMock).not.toHaveBeenCalledWith(1) // wagmi's default chain was never consulted
    expect(dcaTab()).not.toBeDisabled()
    expect(within(dcaTab()).queryByText('Soon')).toBeNull()
    fireEvent.click(dcaTab())
    const panel = await screen.findByTestId('dca-panel')
    expect(panel.getAttribute('data-chain')).toBe('8453')
  })

  it('no wallet + nothing selected (default Ethereum) ⇒ tab selectable; it says where DCA runs; no "Coming to L2 soon"', () => {
    renderSwapView()
    expect(dcaTab()).not.toBeDisabled()
    fireEvent.click(dcaTab())
    expect(screen.getByTestId('coming-soon-runs-on').textContent).toBe('DCA runs on Base and Arbitrum One')
    expect(document.body.textContent).not.toMatch(/Coming to L2 soon|Coming Soon on L2/i)
    expect(screen.queryByTestId('dca-panel')).toBeNull()
  })

  it('the switch action (no wallet) selects the chain and opens the live panel; with a wallet it asks wagmi', async () => {
    renderSwapView()
    fireEvent.click(dcaTab())
    fireEvent.click(screen.getByTestId('switch-to-8453'))
    expect(useDisconnectedChainSelection.getState().chainId).toBe(8453)
    expect(await screen.findByTestId('dca-panel')).toBeInTheDocument()
  })

  it('connected on Ethereum ⇒ the switch action calls wagmi switchChain with the target chain', () => {
    isConnectedMock.mockReturnValue(true)
    walletChainMock.mockReturnValue(1)
    renderSwapView()
    fireEvent.click(dcaTab())
    fireEvent.click(screen.getByTestId('switch-to-42161'))
    expect(switchChainMock).toHaveBeenCalledWith({ chainId: 42161 })
  })

  it('launch flag OFF ⇒ the tab stays the disabled "Soon" teaser on every chain', () => {
    vi.stubEnv('NEXT_PUBLIC_DCA_ENABLED', 'false')
    isDcaLiveMock.mockReturnValue(false)
    renderSwapView()
    expect(dcaTab()).toBeDisabled()
    act(() => useDisconnectedChainSelection.setState({ chainId: 8453 }))
    expect(dcaTab()).toBeDisabled()
  })
})
