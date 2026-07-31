// @vitest-environment jsdom
/**
 * [CHORE-DCA-UX-FIXES] Bug 3b — a failed DCA position must render as "Failed" WITH a reason in the
 * Positions list, never silently vanish. The keeper persists no error string, so the card shows a
 * clear default reason when none is present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 8453)
const useOrderEngineMock = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
}))
// [SPRINT-V3-P2] see DCAPanel.routability.test.tsx — stub useChainlinkPrice directly rather than
// expanding this file's minimal wagmi mock with useReadContract.
vi.mock('@/hooks/useChainlinkPrice', () => ({
  useChainlinkPrice: () => ({ chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false }),
}))
// [FEAT-DEPEG-GATE-ORDER-CREATION] Same precedent as useChainlinkPrice above — stub directly
// rather than expanding this file's minimal wagmi mock with useReadContract. This suite doesn't
// exercise depeg behaviour, so a static 'ok' (no exchange-rate pair) keeps every test unaffected.
vi.mock('@/hooks/useDepegCheck', () => ({
  useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }),
}))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: new Map(), isLoading: false, isError: false }) }))
vi.mock('@/hooks/useTokenBalance', () => ({ useTokenBalance: () => ({ raw: 0n, hasValue: false, formatted: undefined, isLoading: false, isError: false }) }))
vi.mock('@/hooks/useOrderEngine', () => ({ useOrderEngine: () => useOrderEngineMock() }))
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => <button>Connect</button> }))
vi.mock('@/lib/sounds', () => ({
  playClick: vi.fn(), playTouchMP3: vi.fn(), playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(), startWaitingSound: vi.fn(), stopWaitingSound: vi.fn(),
}))
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: vi.fn() }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: vi.fn() }))
vi.mock('@/components/TokenSelector', () => ({ default: () => <div data-testid="token-selector" /> }))
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div /> }))
vi.mock('./OrderReviewModal', () => ({ default: () => null }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))

import { renderWithProviders, screen, fireEvent } from '@/test-utils/render'
import DCAPanel from './DCAPanel'
import { OrderType } from '@/lib/order-engine'

const ADDRESS = '0x1111111111111111111111111111111111111111'

function failedDcaOrder(over: { error?: string | null } = {}) {
  return {
    id: 'failed-1',
    orderHash: '0x' + 'aa'.repeat(32),
    order: { owner: ADDRESS, amountIn: 1_000000000000000000n },
    signature: '',
    status: 'error',
    orderType: OrderType.DCA,
    tokenInSymbol: 'ETHFI',
    tokenInDecimals: 18,
    tokenOutSymbol: 'ETH',
    tokenOutDecimals: 18,
    dcaExecuted: 0,
    dcaTotal: 10,
    createdAt: Date.now(),
    executedAt: null,
    expiresAt: Date.now() + 86_400_000,
    error: 'error' in over ? over.error : null,
    amountOut: null,
    txHash: null,
  }
}

function setOrders(orders: unknown[]) {
  useOrderEngineMock.mockReturnValue({
    dcaOrders: orders, activeOrders: [], historyOrders: orders,
    latestEvent: null, isSubmitting: false,
    createOrder: vi.fn(), pendingOrder: null, confirmOrder: vi.fn(), clearPendingOrder: vi.fn(),
    pendingCancel: null, confirmCancel: vi.fn(), clearPendingCancel: vi.fn(),
    cancelOrder: vi.fn(), cancelAllOrders: vi.fn(), removeOrder: vi.fn(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useChainIdMock.mockReturnValue(8453)
})

describe('DCAPanel Positions — failed order', () => {
  it('shows a failed DCA order as "Failed" with a default reason when the keeper left no error', () => {
    setOrders([failedDcaOrder({ error: null })])
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Positions/i }))
    expect(screen.getByText(/Failed/i)).toBeInTheDocument()
    // A human reason is shown even though order.error is null.
    expect(screen.getByText(/could not be executed/i)).toBeInTheDocument()
  })

  it('prefers the persisted error string when one exists', () => {
    setOrders([failedDcaOrder({ error: 'Signature rejected in wallet.' })])
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Positions/i }))
    expect(screen.getByText(/Signature rejected in wallet\./i)).toBeInTheDocument()
  })
})
