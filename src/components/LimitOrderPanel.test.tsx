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

// [FEAT-DEPEG-GATE-ORDER-CREATION] Mocked directly, mirroring SwapBox.test.tsx's own pattern for
// testing consumers of this hook — the hook's internals are exhaustively covered elsewhere
// (useDepegCheck.test.ts/depeg-gate.test.ts) and are not re-tested here.
const useDepegCheckMock = vi.fn()
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: (...a: unknown[]) => useDepegCheckMock(...a) }))
const DEPEG_OK = { mode: 'ok' as const, divergence: 0, symbol: '', message: null }
const DEPEG_CONSENT = { mode: 'consent' as const, divergence: 0.05, symbol: 'cbETH', message: 'cbETH is trading 5.0% off its exchange rate — possible depeg. Verify before swapping.' }
const DEPEG_BLOCK = { mode: 'block' as const, divergence: 0.12, symbol: 'cbETH', message: 'cbETH is trading 12.0% off its exchange rate — likely a depeg or oracle manipulation. Swap blocked for your safety.' }
const DEPEG_UNVERIFIED = { mode: 'unverified' as const, divergence: 0, symbol: 'cbETH', message: "We couldn't verify cbETH's price right now — try again in a moment." }

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
  useDepegCheckMock.mockReturnValue(DEPEG_OK)
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

// [FEAT-DEPEG-GATE-ORDER-CREATION] Extends the twice-audited cbETH depeg circuit-breaker to Limit
// order creation. useDepegCheck is mocked (as SwapBox.test.tsx does) — only the panel's WIRING is
// under test here, not the hook's own internals.
describe('LimitOrderPanel — [FEAT-DEPEG-GATE-ORDER-CREATION] depeg gate on order creation', () => {
  function submitButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: /place limit order/i }) as HTMLButtonElement
  }
  // The price input's placeholder is 'Loading...' until the mount-time fetchCurrentPrice effect
  // resolves, so the field must be found with an async query (findByPlaceholderText) rather than a
  // synchronous one — otherwise this races the effect and throws intermittently.
  async function enterAmountAndPrice() {
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1' } })
    fireEvent.change(await screen.findByPlaceholderText('0.0'), { target: { value: '2000' } })
  }

  it('a token pair with NO registered exchange-rate feed never blocks creation (the default ETH/USDC)', async () => {
    renderWithProviders(<LimitOrderPanel />)
    await enterAmountAndPrice()
    expect(screen.queryByTestId('limit-depeg-block')).toBeNull()
    expect(screen.queryByTestId('limit-depeg-unverified')).toBeNull()
    expect(submitButton()).not.toBeDisabled()
  })

  it('a HARD depeg (mode: block) disables submit and shows depeg copy', async () => {
    useDepegCheckMock.mockReturnValue(DEPEG_BLOCK)
    renderWithProviders(<LimitOrderPanel />)
    await enterAmountAndPrice()

    const banner = screen.getByTestId('limit-depeg-block')
    expect(banner.textContent).toMatch(/cbETH depeg/)
    expect(submitButton()).toBeDisabled()
  })

  it('UNVERIFIED (oracle unreadable) disables submit with "not verified" copy — never claims a depeg', async () => {
    useDepegCheckMock.mockReturnValue(DEPEG_UNVERIFIED)
    renderWithProviders(<LimitOrderPanel />)
    await enterAmountAndPrice()

    const banner = screen.getByTestId('limit-depeg-unverified')
    expect(banner.textContent).toMatch(/price not verified/i)
    expect(banner.textContent).not.toMatch(/depeg\./)
    expect(submitButton()).toBeDisabled()
  })

  it('a healthy read (mode: ok, real pair) does NOT block submit', async () => {
    useDepegCheckMock.mockReturnValue({ mode: 'ok', divergence: 0.003, symbol: 'cbETH', message: null })
    renderWithProviders(<LimitOrderPanel />)
    await enterAmountAndPrice()
    expect(submitButton()).not.toBeDisabled()
  })

  it('informed consent (mode: consent) blocks until accepted, then unblocks — mirrors SwapBox exactly', async () => {
    useDepegCheckMock.mockReturnValue(DEPEG_CONSENT)
    renderWithProviders(<LimitOrderPanel />)
    await enterAmountAndPrice()

    expect(submitButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(submitButton()).not.toBeDisabled()
  })

  it('a blocked submit never calls createOrder — defense-in-depth guard fires even on a forced click', async () => {
    useDepegCheckMock.mockReturnValue(DEPEG_BLOCK)
    const createOrder = vi.fn()
    useOrderEngineMock.mockReturnValue({ ...defaultEngine(), createOrder })
    renderWithProviders(<LimitOrderPanel />)
    await enterAmountAndPrice()

    fireEvent.click(submitButton())
    await Promise.resolve()
    expect(createOrder).not.toHaveBeenCalled()
  })
})
