// @vitest-environment jsdom
/**
 * [CHORE-DCA-UX-FIXES] Bug 3a — DCA order-create routability gate.
 *
 * An imported/thin token with NO aggregator route on the target chain (e.g. ETHFI → ETH on Base)
 * must be BLOCKED before approve/sign — not signed and then silently failed by the keeper. The form
 * pre-checks routability via /api/quote (checkRoute) ONLY for imported tokens, so curated pairs keep
 * the zero-latency happy path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 8453)
const createOrderMock = vi.fn()
const checkRouteMock = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
}))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: new Map(), isLoading: false, isError: false }) }))
vi.mock('@/hooks/useTokenBalance', () => ({
  useTokenBalance: () => ({ raw: 1_000000000000000000000n, hasValue: true, formatted: '1000', isLoading: false, isError: false }),
}))
vi.mock('@/lib/order-engine/check-route', () => ({
  checkRoute: (...args: unknown[]) => checkRouteMock(...args),
  NO_ROUTE_REASON: 'No swap route found for this pair on this network.',
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
// TokenSelector mock: the INPUT selector (hideNativeInput) exposes a button that picks an imported token.
vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected, onSelect, hideNativeInput }: { selected: { symbol?: string } | null; onSelect: (t: unknown) => void; hideNativeInput?: boolean }) => (
    <div data-testid="token-selector">
      <span>{selected?.symbol ?? 'Select'}</span>
      {hideNativeInput ? (
        <button
          data-testid="pick-imported-input"
          onClick={() => onSelect({
            address: '0x6c240ca4a1a3d8c4c2c7e6b8d6f6e8a4b4c2a2a2',
            symbol: 'ETHFI', name: 'Ether.fi', decimals: 18, logoURI: '', category: 'Imported', chainId: 8453,
          })}
        >pick-imported</button>
      ) : (
        <button
          data-testid="pick-other-output"
          onClick={() => onSelect({
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '', category: 'Stablecoin', chainId: 8453,
          })}
        >pick-out</button>
      )}
    </div>
  ),
}))
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div /> }))
vi.mock('./OrderReviewModal', () => ({ default: () => null }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))

import { renderWithProviders, screen, fireEvent, waitFor, act } from '@/test-utils/render'
import DCAPanel from './DCAPanel'

const ADDRESS = '0x1111111111111111111111111111111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useChainIdMock.mockReturnValue(8453)
})

const enterAmount = (v: string) => fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: v } })
const startDca = () => fireEvent.click(screen.getByRole('button', { name: /Start DCA/i }))

describe('DCAPanel — routability gate (imported tokens)', () => {
  it('BLOCKS creation and warns when an imported token has no route (never calls createOrder)', async () => {
    checkRouteMock.mockResolvedValue({ routable: false, reason: 'No swap route found for this pair on this network.' })
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-imported-input')) // tokenIn → ETHFI (imported)
    enterAmount('100')
    startDca()

    await waitFor(() => expect(checkRouteMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/no swap route found/i)).toBeInTheDocument()
    expect(createOrderMock).not.toHaveBeenCalled()
  })

  it('proceeds to createOrder when the imported token IS routable', async () => {
    checkRouteMock.mockResolvedValue({ routable: true })
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-imported-input'))
    enterAmount('100')
    startDca()

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
  })

  it('does NOT pre-check routability for a curated pair (zero-latency happy path)', async () => {
    renderWithProviders(<DCAPanel />) // defaults: WETH → ETH, both curated/native
    enterAmount('100')
    startDca()

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
    expect(checkRouteMock).not.toHaveBeenCalled()
  })

  it('drops a stale route block when the pair changes while the check is in flight', async () => {
    let resolveCheck!: (v: { routable: boolean; reason?: string }) => void
    checkRouteMock.mockReturnValue(new Promise(r => { resolveCheck = r }))
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-imported-input')) // tokenIn → ETHFI (imported)
    enterAmount('100')
    startDca() // begins the in-flight check for the ETHFI pair
    await waitFor(() => expect(checkRouteMock).toHaveBeenCalledTimes(1))

    // User swaps the BUY token mid-check → a different pair that was never checked.
    fireEvent.click(screen.getByTestId('pick-other-output'))
    // The OLD check now resolves not-routable.
    await act(async () => { resolveCheck({ routable: false, reason: 'No swap route found on this network.' }) })

    // The stale block must NOT be applied to the newly-selected pair.
    expect(screen.queryByText(/no swap route found/i)).toBeNull()
  })

  it('passes the per-chunk amount and target chainId to checkRoute', async () => {
    checkRouteMock.mockResolvedValue({ routable: true })
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-imported-input'))
    enterAmount('100') // 100 ETHFI over the default 10 buys → 10 per chunk
    startDca()

    await waitFor(() => expect(checkRouteMock).toHaveBeenCalledTimes(1))
    const arg = checkRouteMock.mock.calls[0][0] as { src: string; amount: string; chainId: number; srcDecimals: number }
    expect(arg.src.toLowerCase()).toBe('0x6c240ca4a1a3d8c4c2c7e6b8d6f6e8a4b4c2a2a2')
    expect(arg.chainId).toBe(8453)
    expect(arg.srcDecimals).toBe(18)
    expect(arg.amount).toBe('10000000000000000000') // 10 ETHFI per chunk
  })
})
