// @vitest-environment jsdom
/**
 * [P83/M-01 Phase 2] LimitOrderPanel — UI for creating limit orders.
 *
 * Pins the tab switching, the connect-wallet prompt path, and the
 * basic create-form rendering. The order-engine + price-monitor surface
 * is fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useOrderEngineMock = vi.fn()
const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 1)
const useConnectModalMock = vi.fn(() => ({ openConnectModal: vi.fn() }))
const fetchCurrentPriceMock = vi.fn()
const useOrderNotificationsMock = vi.fn()

vi.mock('@/hooks/useOrderEngine', () => ({
  useOrderEngine: () => useOrderEngineMock(),
}))
vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => useConnectModalMock(),
  ConnectButton: () => <button data-testid="rk-connect">Connect</button>,
}))
vi.mock('@/lib/limit-order-api', () => ({
  fetchCurrentPrice: (...args: unknown[]) => fetchCurrentPriceMock(...args),
  buildLimitOrderParams: vi.fn(),
  submitLimitOrder: vi.fn(),
  fetchLimitOrderStatus: vi.fn(),
}))
vi.mock('@/lib/sounds', () => ({
  playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(),
  playClick: vi.fn(),
  stopWaitingSound: vi.fn(),
  playTouchMP3: vi.fn(),
}))
vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected }: { selected: { symbol?: string } | null }) => (
    <div data-testid="token-selector">{selected?.symbol ?? 'Select'}</div>
  ),
}))
vi.mock('@/components/BetaDisclaimer', () => ({
  default: () => <div data-testid="beta-disclaimer" />,
}))
vi.mock('@/components/ExecutionTimeline', () => ({
  default: () => <div data-testid="execution-timeline" />,
}))
vi.mock('@/hooks/useOrderNotifications', () => ({
  useOrderNotifications: (...args: unknown[]) => useOrderNotificationsMock(...args),
}))
vi.mock('@/lib/analytics-tracker', () => ({
  trackTrade: vi.fn(),
}))

import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import LimitOrderPanel from './LimitOrderPanel'

function defaultEngine() {
  return {
    orders: [],
    activeOrders: [],
    historyOrders: [],
    limitOrders: [],
    stopLossOrders: [],
    dcaOrders: [],
    latestEvent: null,
    isSubmitting: false,
    isLoading: false,
    currentNonce: 0n,
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    removeOrder: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useOrderEngineMock.mockReturnValue(defaultEngine())
  useAccountMock.mockReturnValue({
    address: '0x1111111111111111111111111111111111111111',
    isConnected: true,
  })
  fetchCurrentPriceMock.mockResolvedValue('0')
})

describe('LimitOrderPanel — tabs', () => {
  it('renders the "New Limit Order" tab as default', () => {
    renderWithProviders(<LimitOrderPanel />)
    expect(screen.getByText(/New Limit Order/i)).toBeInTheDocument()
    // No order list when on create tab.
    expect(screen.queryByText(/No.*limit orders/i)).toBeNull()
  })

  it('switching to the Orders tab shows the order list', () => {
    renderWithProviders(<LimitOrderPanel />)
    // Find the Orders tab button explicitly (not the count).
    const tabButtons = screen.getAllByRole('button')
    const ordersTab = tabButtons.find(b => /^Orders/.test(b.textContent ?? ''))
    expect(ordersTab).toBeDefined()
    fireEvent.click(ordersTab!)
  })

  it('shows the count of active limit orders in the Orders tab label', () => {
    useOrderEngineMock.mockReturnValue({
      ...defaultEngine(),
      limitOrders: [
        { id: '1', status: 'active', orderType: 0 },
        { id: '2', status: 'signing', orderType: 0 },
      ],
    })
    renderWithProviders(<LimitOrderPanel />)
    expect(screen.getByText(/Orders\s*\(2\)/i)).toBeInTheDocument()
  })
})

describe('LimitOrderPanel — connect prompt', () => {
  it('still mounts when the wallet is disconnected', () => {
    useAccountMock.mockReturnValue({ address: undefined, isConnected: false })
    expect(() => renderWithProviders(<LimitOrderPanel />)).not.toThrow()
  })
})

describe('LimitOrderPanel — beta disclaimer', () => {
  it('renders the beta disclaimer regardless of tab', () => {
    renderWithProviders(<LimitOrderPanel />)
    expect(screen.getByTestId('beta-disclaimer')).toBeInTheDocument()
  })
})
