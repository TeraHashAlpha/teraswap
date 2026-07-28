// @vitest-environment jsdom
/**
 * [FEAT-DEPEG-GATE-ORDER-CREATION] ConditionalOrderPanel — the cbETH depeg circuit-breaker
 * extended to Take-Profit order creation (Stop-Loss is deferred to v4 and disabled in the UI, so
 * only Take-Profit is creatable and tested here).
 *
 * Modeled on LimitOrderPanel.test.tsx: useDepegCheck is mocked (as SwapBox.test.tsx does), so
 * only the panel's WIRING is under test — block/unverified/consent/no-pair correctly disable
 * submit, show the right copy, and the defense-in-depth guard fires even on a forced click.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useOrderEngineMock = vi.fn()
const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 1)
const useConnectModalMock = vi.fn(() => ({ openConnectModal: vi.fn() }))
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
vi.mock('@/lib/price-monitor', () => ({
  getTokenPriceUSD: vi.fn().mockResolvedValue(0),
}))
vi.mock('@/lib/sounds', () => ({
  playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(),
  playClick: vi.fn(),
  stopWaitingSound: vi.fn(),
  startWaitingSound: vi.fn(),
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
vi.mock('@/hooks/useOrderNotifications', () => ({
  useOrderNotifications: (...args: unknown[]) => useOrderNotificationsMock(...args),
}))
vi.mock('@/lib/analytics-tracker', () => ({
  trackTrade: vi.fn(),
}))

// [FEAT-DEPEG-GATE-ORDER-CREATION] Mocked directly, mirroring SwapBox.test.tsx's own pattern for
// testing consumers of this hook — the hook's internals are exhaustively covered elsewhere
// (useDepegCheck.test.ts/depeg-gate.test.ts) and are not re-tested here.
const useDepegCheckMock = vi.fn()
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: (...a: unknown[]) => useDepegCheckMock(...a) }))
const DEPEG_OK = { mode: 'ok' as const, divergence: 0, symbol: '', message: null }
const DEPEG_CONSENT = { mode: 'consent' as const, divergence: 0.05, symbol: 'cbETH', message: 'cbETH is trading 5.0% off its exchange rate — possible depeg. Verify before swapping.' }
const DEPEG_BLOCK = { mode: 'block' as const, divergence: 0.12, symbol: 'cbETH', message: 'cbETH is trading 12.0% off its exchange rate — likely a depeg or oracle manipulation. Swap blocked for your safety.' }
const DEPEG_UNVERIFIED = { mode: 'unverified' as const, divergence: 0, symbol: 'cbETH', message: "We couldn't verify cbETH's price right now — try again in a moment." }

import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import ConditionalOrderPanel from './ConditionalOrderPanel'

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
  useDepegCheckMock.mockReturnValue(DEPEG_OK)
})

describe('ConditionalOrderPanel — tabs', () => {
  it('renders the "New SL / TP" tab as default', () => {
    renderWithProviders(<ConditionalOrderPanel />)
    expect(screen.getByText(/New SL \/ TP/i)).toBeInTheDocument()
  })
})

describe('ConditionalOrderPanel — connect prompt', () => {
  it('still mounts when the wallet is disconnected', () => {
    useAccountMock.mockReturnValue({ address: undefined, isConnected: false })
    expect(() => renderWithProviders(<ConditionalOrderPanel />)).not.toThrow()
  })
})

// [FEAT-DEPEG-GATE-ORDER-CREATION] Extends the twice-audited cbETH depeg circuit-breaker to
// Take-Profit order creation (the only creatable conditional type — Stop-Loss stays disabled in
// the UI pending the v4 executor, unrelated to this change).
describe('ConditionalOrderPanel — [FEAT-DEPEG-GATE-ORDER-CREATION] depeg gate on order creation', () => {
  function submitButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: /set take profit/i }) as HTMLButtonElement
  }
  // Amount is a plain text input (unique placeholder '0.00'); trigger price is the sole
  // type="number" field, so role:spinbutton finds it unambiguously even while its own placeholder
  // is transiently 'Loading...' from the mount-time getTokenPriceUSD effect.
  function enterAmountAndTrigger() {
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1' } })
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2000' } })
  }

  it('a token pair with NO registered exchange-rate feed never blocks creation (the default ETH/USDC)', () => {
    renderWithProviders(<ConditionalOrderPanel />)
    enterAmountAndTrigger()
    expect(screen.queryByTestId('sltp-depeg-block')).toBeNull()
    expect(screen.queryByTestId('sltp-depeg-unverified')).toBeNull()
    expect(submitButton()).not.toBeDisabled()
  })

  it('a HARD depeg (mode: block) disables submit and shows depeg copy', () => {
    useDepegCheckMock.mockReturnValue(DEPEG_BLOCK)
    renderWithProviders(<ConditionalOrderPanel />)
    enterAmountAndTrigger()

    const banner = screen.getByTestId('sltp-depeg-block')
    expect(banner.textContent).toMatch(/cbETH depeg/)
    expect(submitButton()).toBeDisabled()
  })

  it('UNVERIFIED (oracle unreadable) disables submit with "not verified" copy — never claims a depeg', () => {
    useDepegCheckMock.mockReturnValue(DEPEG_UNVERIFIED)
    renderWithProviders(<ConditionalOrderPanel />)
    enterAmountAndTrigger()

    const banner = screen.getByTestId('sltp-depeg-unverified')
    expect(banner.textContent).toMatch(/price not verified/i)
    expect(banner.textContent).not.toMatch(/depeg\./)
    expect(submitButton()).toBeDisabled()
  })

  it('a healthy read (mode: ok, real pair) does NOT block submit', () => {
    useDepegCheckMock.mockReturnValue({ mode: 'ok', divergence: 0.003, symbol: 'cbETH', message: null })
    renderWithProviders(<ConditionalOrderPanel />)
    enterAmountAndTrigger()
    expect(submitButton()).not.toBeDisabled()
  })

  it('informed consent (mode: consent) blocks until accepted, then unblocks — mirrors SwapBox exactly', () => {
    useDepegCheckMock.mockReturnValue(DEPEG_CONSENT)
    renderWithProviders(<ConditionalOrderPanel />)
    enterAmountAndTrigger()

    expect(submitButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(submitButton()).not.toBeDisabled()
  })

  it('a blocked submit never calls createOrder — defense-in-depth guard fires even on a forced click', async () => {
    useDepegCheckMock.mockReturnValue(DEPEG_BLOCK)
    const createOrder = vi.fn()
    useOrderEngineMock.mockReturnValue({ ...defaultEngine(), createOrder })
    renderWithProviders(<ConditionalOrderPanel />)
    enterAmountAndTrigger()

    fireEvent.click(submitButton())
    await Promise.resolve()
    expect(createOrder).not.toHaveBeenCalled()
  })
})
