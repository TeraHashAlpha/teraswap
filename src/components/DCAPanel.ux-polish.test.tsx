// @vitest-environment jsdom
/**
 * [CHORE-DCA-UX-POLISH] DCA spend-step polish — covers the three additions on top of
 * the already-shipped WETH-input work:
 *   - a wallet balance line for the selected spend token ("Balance: X WETH" / "—"),
 *   - 25/50/100% quick-fill buttons (BigInt math, exact 100%, disabled at 0/disconnected),
 *   - the per-chunk MIN_ORDER_AMOUNT hint re-validated after a preset fills,
 *   - Order Expiry rendered OUTSIDE Advanced settings (Slippage stays inside).
 *
 * useTokenBalances + useOrderEngine are mocked so the test drives the form UI directly
 * (no multicall / Supabase / signing wiring) — the build→sign path is covered by
 * DCAPanel.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 8453)
const useTokenBalancesMock = vi.fn()
const createOrderMock = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
}))

vi.mock('@/hooks/useTokenBalances', () => ({
  useTokenBalances: () => useTokenBalancesMock(),
}))

vi.mock('@/hooks/useOrderEngine', () => ({
  useOrderEngine: () => ({
    dcaOrders: [],
    activeOrders: [],
    historyOrders: [],
    latestEvent: null,
    isSubmitting: false,
    createOrder: createOrderMock,
    pendingOrder: null,
    confirmOrder: vi.fn(),
    clearPendingOrder: vi.fn(),
    pendingCancel: null,
    confirmCancel: vi.fn(),
    clearPendingCancel: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    removeOrder: vi.fn(),
  }),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: () => <button data-testid="rk-connect">Connect</button>,
}))
vi.mock('@/lib/sounds', () => ({
  playClick: vi.fn(),
  playTouchMP3: vi.fn(),
  playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(),
  startWaitingSound: vi.fn(),
  stopWaitingSound: vi.fn(),
}))
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: vi.fn() }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: vi.fn() }))
vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected }: { selected: { symbol?: string } | null }) => (
    <div data-testid="token-selector">{selected?.symbol ?? 'Select'}</div>
  ),
}))
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div data-testid="beta-disclaimer" /> }))
vi.mock('./OrderReviewModal', () => ({ default: () => null }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))

import { renderWithProviders, screen, fireEvent } from '@/test-utils/render'
import DCAPanel from './DCAPanel'
import { getWrappedNative } from '@/lib/chains/registry'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const WETH_ADDR = getWrappedNative(8453).toLowerCase() // Base WETH — chain-aware, not hardcoded
const ONE = 10n ** 18n

function setBalances(opts: { raw?: bigint; formatted?: string; isLoading?: boolean } = {}) {
  const map = new Map<string, { raw: bigint; formatted: string }>()
  if (opts.raw !== undefined) {
    map.set(WETH_ADDR, { raw: opts.raw, formatted: opts.formatted ?? '0' })
  }
  useTokenBalancesMock.mockReturnValue({
    balances: map,
    isLoading: opts.isLoading ?? false,
    isError: false,
  })
}

const amountInput = () => screen.getByPlaceholderText('0.00') as HTMLInputElement
const pctButton = (label: '25%' | '50%' | '100%') => screen.getByRole('button', { name: label })

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useChainIdMock.mockReturnValue(8453) // Base — WETH default input
  setBalances({ raw: 2_500000000000000000n, formatted: '2.5' }) // 2.5 WETH
})

describe('DCAPanel spend step — balance line', () => {
  it('shows the connected wallet balance of the selected spend token', () => {
    renderWithProviders(<DCAPanel />)
    expect(screen.getByTestId('dca-spend-balance')).toHaveTextContent('Balance: 2.5 WETH')
  })

  it('shows "—" while balances are loading', () => {
    setBalances({ isLoading: true })
    renderWithProviders(<DCAPanel />)
    expect(screen.getByTestId('dca-spend-balance')).toHaveTextContent('Balance: —')
  })

  it('shows "—" when the wallet is disconnected', () => {
    useAccountMock.mockReturnValue({ address: undefined, isConnected: false })
    renderWithProviders(<DCAPanel />)
    expect(screen.getByTestId('dca-spend-balance')).toHaveTextContent('Balance: —')
  })
})

describe('DCAPanel spend step — quick-fill % presets', () => {
  it('100% fills the input with the exact full balance (to the wei)', () => {
    // 1.000000000000000001 WETH — a Number() round-trip would drop the +1 wei.
    setBalances({ raw: ONE + 1n, formatted: '1' })
    renderWithProviders(<DCAPanel />)
    fireEvent.click(pctButton('100%'))
    expect(amountInput()).toHaveValue('1.000000000000000001')
  })

  it('25% fills floor(balance / 4), formatted', () => {
    setBalances({ raw: 2_500000000000000000n, formatted: '2.5' })
    renderWithProviders(<DCAPanel />)
    fireEvent.click(pctButton('25%'))
    expect(amountInput()).toHaveValue('0.625')
  })

  it('50% fills half the balance', () => {
    setBalances({ raw: 2_500000000000000000n, formatted: '2.5' })
    renderWithProviders(<DCAPanel />)
    fireEvent.click(pctButton('50%'))
    expect(amountInput()).toHaveValue('1.25')
  })

  it('disables the % buttons when the balance is zero', () => {
    setBalances({}) // no entry ⇒ balance 0
    renderWithProviders(<DCAPanel />)
    expect(pctButton('25%')).toBeDisabled()
    expect(pctButton('50%')).toBeDisabled()
    expect(pctButton('100%')).toBeDisabled()
  })

  it('disables the % buttons when disconnected', () => {
    useAccountMock.mockReturnValue({ address: undefined, isConnected: false })
    renderWithProviders(<DCAPanel />)
    expect(pctButton('100%')).toBeDisabled()
  })
})

describe('DCAPanel spend step — per-chunk MIN re-validation', () => {
  it('surfaces the min hint after a preset fills a sub-floor per-chunk amount', () => {
    // 50,000 base units total; default 10 buys ⇒ floor(50000/10)=5,000 < 10,000 floor.
    setBalances({ raw: 50_000n, formatted: '<0.0001' })
    renderWithProviders(<DCAPanel />)
    fireEvent.click(pctButton('100%'))
    expect(amountInput()).toHaveValue('0.00000000000005')
    expect(screen.getByText(/on-chain minimum/i)).toBeInTheDocument()
  })

  it('shows no min hint for a healthy preset fill', () => {
    setBalances({ raw: 2_500000000000000000n, formatted: '2.5' })
    renderWithProviders(<DCAPanel />)
    fireEvent.click(pctButton('100%'))
    expect(screen.queryByText(/on-chain minimum/i)).toBeNull()
  })
})

describe('DCAPanel — Order Expiry always visible', () => {
  it('renders the Order Expiry control without expanding Advanced settings', () => {
    renderWithProviders(<DCAPanel />)
    expect(screen.getByText(/Advanced settings/i)).toBeInTheDocument() // collapsed by default
    expect(screen.getByText(/Order Expiry/i)).toBeInTheDocument() // expiry is out of Advanced
    expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument() // expiry preset (not an interval label)
  })

  it('keeps Slippage tolerance under Advanced (hidden until expanded)', () => {
    renderWithProviders(<DCAPanel />)
    expect(screen.queryByText(/Slippage tolerance/i)).toBeNull()
    fireEvent.click(screen.getByText(/Advanced settings/i))
    expect(screen.getByText(/Slippage tolerance/i)).toBeInTheDocument()
  })
})
