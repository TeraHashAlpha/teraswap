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
 * deliberate difference: `useChainId` reports a chain with NO order-engine router set, and the
 * router map is the REAL one — nothing about config.ts is mocked here, because the module under
 * test IS the chain lookup.
 *
 * [feat/arbitrum-dca-gates] That chain WAS Arbitrum One (42161). It now has a derived set
 * (config.ts ARBITRUM_ROUTERS, ADR-020 amendment), so it moved to the OTHER side of this file: a
 * positive control proving the panel commits Arbitrum's OWN default router (Augustus V6) — not
 * mainnet's 1inch, the cross-chain coincidence B6 warned about. Optimism (10) — registered nowhere
 * in config.ts's router map — now stands in as the chain with no set, exactly as it does in
 * router-map-fail-closed.test.ts. Chain 10 has no token catalog, so the two catalog lookups the
 * panel uses for its DEFAULT legs are given a synthetic WETH/USDC pair for it below (the catalog
 * is not this file's subject; the router map — still real, still unmocked — is).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 10)
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
// [feat/arbitrum-dca-gates] Default legs for the no-set fixture chain (10), which has no catalog.
// Every REAL chain (1 / 8453 / 42161) falls through to the actual catalog, untouched.
vi.mock('@/lib/chains/tokens', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chains/tokens')>('@/lib/chains/tokens')
  const synthetic = (symbol: string, address: string, decimals: number) => ({
    address, symbol, name: symbol, decimals, logoURI: '', category: 'Synthetic', chainId: 10,
  })
  return {
    ...actual,
    findChainToken: (address: string, chainId: number) =>
      chainId === 10 ? synthetic('WETH', address, 18) : actual.findChainToken(address, chainId),
    getCanonicalUsdc: (chainId: number) =>
      chainId === 10 ? synthetic('USDC', '0x0b2c639c533813f4aa9d7837caf62653d097ff85', 6) : actual.getCanonicalUsdc(chainId),
  }
})
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

/** A chain config.ts has no order-engine router set for (see the header: was 42161). */
const UNKNOWN_CHAIN_ID = 10
/** The chain the panel actually ships on — the control that proves the guard is chain-specific. */
const BASE_CHAIN_ID = 8453
/** [feat/arbitrum-dca-gates] The chain the finding was about, now on the positive side. */
const ARBITRUM_CHAIN_ID = 42161

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useChainIdMock.mockReturnValue(UNKNOWN_CHAIN_ID)
  checkOracleMock.mockResolvedValue({ hasOracle: true })
  checkRouteMock.mockResolvedValue({ routable: true })
})

const enterAmount = (v: string) => fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: v } })
const startDca = () => fireEvent.click(screen.getByRole('button', { name: /Start DCA/i }))

describe('DCAPanel — [ADR-020] refuses to sign on a chain with no router set', () => {
  it('sanity: the fixture chains really do differ in the router map', () => {
    // If this ever stops holding, every assertion below is vacuous — fail here instead.
    expect(getDefaultRouter(UNKNOWN_CHAIN_ID)).toBeNull()
    expect(getDefaultRouter(BASE_CHAIN_ID)).not.toBeNull()
    expect(getDefaultRouter(ARBITRUM_CHAIN_ID)).not.toBeNull()
  })

  it('shows the named refusal and NEVER calls createOrder on a chain with no router set', async () => {
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

  it('[feat/arbitrum-dca-gates] the SAME panel on Arbitrum One (42161) now commits Arbitrum\'s OWN default router — never mainnet\'s 1inch coincidence', async () => {
    useChainIdMock.mockReturnValue(ARBITRUM_CHAIN_ID)
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    startDca()

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('dca-route-block')).toBeNull()
    const config = createOrderMock.mock.calls[0][0] as { router: string }
    expect(config.router.toLowerCase()).toBe(getDefaultRouter(ARBITRUM_CHAIN_ID)!.address.toLowerCase())
    expect(config.router.toLowerCase()).not.toBe(getDefaultRouter(1)!.address.toLowerCase())
    expect(getDefaultRouter(ARBITRUM_CHAIN_ID)!.label).toBe('ParaSwap Augustus v6')
  })
})
