// @vitest-environment jsdom
/**
 * [ADR-020 / finding B6] DCAPanel must REFUSE to sign on a chain with no order-engine router set.
 *
 * `getDefaultRouter` used to fall back twice — unknown chain ⇒ mainnet map, unknown key ⇒ mainnet
 * `1inch` — so on Arbitrum One the panel would have committed a MAINNET router address into a
 * signed DCA order. The router is fixed at signing and replayed by the keeper on every fill, so a
 * router the chain's own executor does not whitelist produces an order that can never execute and
 * can only be cancelled.
 *
 * The harness mirrors DCAPanel.routability.test.tsx (same minimal wagmi/hook stubs) with ONE
 * deliberate difference: `useChainId` reports 42161, and the router map is the REAL one — nothing
 * about config.ts is mocked here, because the module under test IS the chain lookup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 42161)
const createOrderMock = vi.fn()
const checkRouteMock = vi.fn()
const checkOracleMock = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
}))
vi.mock('@/hooks/useChainlinkPrice', () => ({
  useChainlinkPrice: () => ({ chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false }),
}))
vi.mock('@/hooks/useDepegCheck', () => ({
  useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }),
}))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: new Map(), isLoading: false, isError: false }) }))
vi.mock('@/hooks/useTokenBalance', () => ({
  useTokenBalance: () => ({ raw: 1_000000000000000000000n, hasValue: true, formatted: '1000', isLoading: false, isError: false }),
}))
vi.mock('@/lib/order-engine/check-route', () => ({
  checkRoute: (...args: unknown[]) => checkRouteMock(...args),
  NO_ROUTE_REASON: 'No swap route found for this pair on this network.',
}))
vi.mock('@/lib/order-engine/check-oracle', () => ({
  checkOracleCoverage: (...args: unknown[]) => checkOracleMock(...args),
}))
vi.mock('@/hooks/useOrderEngine', () => ({
  useOrderEngine: () => ({
    dcaOrders: [], activeOrders: [], historyOrders: [], latestEvent: null, isSubmitting: false,
    createOrder: createOrderMock,
    pendingOrder: null, confirmOrder: vi.fn(), clearPendingOrder: vi.fn(),
    pendingCancel: null, confirmCancel: vi.fn(), clearPendingCancel: vi.fn(),
    cancelOrder: vi.fn(), cancelAllOrders: vi.fn(), removeOrder: vi.fn(),
  }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => <button>Connect</button> }))
vi.mock('@/lib/sounds', () => ({
  playClick: vi.fn(), playTouchMP3: vi.fn(), playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(), startWaitingSound: vi.fn(), stopWaitingSound: vi.fn(),
}))
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: vi.fn() }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: vi.fn() }))
vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected }: { selected: { symbol?: string } | null }) => (
    <div data-testid="token-selector">{selected?.symbol ?? 'Select'}</div>
  ),
}))
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div /> }))
vi.mock('./OrderReviewModal', () => ({ default: () => null }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))

import { renderWithProviders, screen, fireEvent, waitFor } from '@/test-utils/render'
import { NO_ROUTER_FOR_CHAIN_REASON, getDefaultRouter } from '@/lib/order-engine'
import DCAPanel from './DCAPanel'

const ADDRESS = '0x1111111111111111111111111111111111111111'

/** The chain the finding is about: a real OrderExecutorV3 is deployed, config.ts has no entry. */
const ARBITRUM_CHAIN_ID = 42161
/** The chain the panel actually ships on — the control that proves the guard is chain-specific. */
const BASE_CHAIN_ID = 8453

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useChainIdMock.mockReturnValue(ARBITRUM_CHAIN_ID)
  checkOracleMock.mockResolvedValue({ hasOracle: true })
  checkRouteMock.mockResolvedValue({ routable: true })
})

const enterAmount = (v: string) => fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: v } })
const startDca = () => fireEvent.click(screen.getByRole('button', { name: /Start DCA/i }))

describe('DCAPanel — [ADR-020] refuses to sign on a chain with no router set', () => {
  it('sanity: the fixture chains really do differ in the router map', () => {
    // If this ever stops holding, every assertion below is vacuous — fail here instead.
    expect(getDefaultRouter(ARBITRUM_CHAIN_ID)).toBeNull()
    expect(getDefaultRouter(BASE_CHAIN_ID)).not.toBeNull()
  })

  it('shows the named refusal and NEVER calls createOrder on Arbitrum One (42161)', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    startDca()

    const block = await screen.findByTestId('dca-route-block')
    expect(block).toHaveTextContent(NO_ROUTER_FOR_CHAIN_REASON)
    expect(createOrderMock).not.toHaveBeenCalled()
  })

  it('refuses BEFORE the routability probe — nothing is quoted, approved or signed', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    startDca()

    await screen.findByTestId('dca-route-block')
    expect(checkRouteMock).not.toHaveBeenCalled()
    expect(createOrderMock).not.toHaveBeenCalled()
  })

  it('the SAME panel on Base (8453) still signs — the guard is chain-specific, not a blanket block', async () => {
    useChainIdMock.mockReturnValue(BASE_CHAIN_ID)
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    startDca()

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('dca-route-block')).toBeNull()
    // …and it commits Base's own default router, not mainnet's.
    const config = createOrderMock.mock.calls[0][0] as { router: string }
    expect(config.router.toLowerCase()).toBe(getDefaultRouter(BASE_CHAIN_ID)!.address.toLowerCase())
  })
})
