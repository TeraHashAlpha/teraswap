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
const checkOracleMock = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
}))
// [SPRINT-V3-P2] CreateDCAForm now calls useChainlinkPrice (v3 signing derivation, inert while
// getOrderExecutorV3 is null everywhere). It internally uses wagmi's useReadContract, which this
// file's minimal wagmi mock doesn't provide — stub the hook directly instead of expanding the
// wagmi mock (these tests don't exercise v3 pricing).
vi.mock('@/hooks/useChainlinkPrice', () => ({
  useChainlinkPrice: () => ({ chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false }),
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
  // Default: the bought token HAS an oracle → no note (individual tests override).
  checkOracleMock.mockResolvedValue({ hasOracle: true })
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

describe('DCAPanel — creation guard (schedule cannot finish before expiry)', () => {
  it('BLOCKS when interval × buys > expiry: shows the block, disables submit, never signs', () => {
    renderWithProviders(<DCAPanel />) // defaults: curated WETH→ETH, 10 buys × 1d, 30d expiry (fits)
    enterAmount('100')
    // No block on the (fitting) defaults.
    expect(screen.queryByTestId('dca-expiry-block')).toBeNull()
    expect(screen.getByRole('button', { name: /Start DCA/i })).not.toBeDisabled()

    // Make the schedule overrun the expiry: 30 buys × 3d = 90d, but expiry stays 30d.
    fireEvent.click(screen.getByRole('button', { name: '30' })) // Number of Buys → 30
    fireEvent.click(screen.getByRole('button', { name: '3d' })) // Interval → 3d

    const block = screen.getByTestId('dca-expiry-block')
    expect(block).toBeInTheDocument()
    expect(block.textContent).toMatch(/expir/i)
    expect(screen.getByRole('button', { name: /Start DCA/i })).toBeDisabled()

    startDca() // clicking a disabled button must not create the order
    expect(createOrderMock).not.toHaveBeenCalled()
  })

  it('UNBLOCKS once the expiry is widened enough to fit the schedule', () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    fireEvent.click(screen.getByRole('button', { name: '30' })) // 30 buys
    fireEvent.click(screen.getByRole('button', { name: '3d' })) // × 3d = 90d
    expect(screen.getByTestId('dca-expiry-block')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '90d' })) // expiry 90d == needed 90d → fits
    expect(screen.queryByTestId('dca-expiry-block')).toBeNull()
    expect(screen.getByRole('button', { name: /Start DCA/i })).not.toBeDisabled()
  })
})

describe('DCAPanel — oracle-less advisory note', () => {
  it('renders the neutral note (naming the token) when the bought token has no oracle', async () => {
    checkOracleMock.mockResolvedValue({ hasOracle: false })
    renderWithProviders(<DCAPanel />) // default buy token = ETH; effect fires on mount (debounced)
    const note = await screen.findByTestId('dca-oracle-note')
    expect(note).toHaveTextContent(/has no price oracle/i)
    expect(note).toHaveTextContent(/best available DEX route/i)
  })

  it('does NOT render the note when the token has an oracle, and NEVER disables submit', async () => {
    checkOracleMock.mockResolvedValue({ hasOracle: true })
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    // Give the debounced probe time to resolve, then confirm no note + submit enabled.
    await waitFor(() => expect(checkOracleMock).toHaveBeenCalled())
    expect(screen.queryByTestId('dca-oracle-note')).toBeNull()
    expect(screen.getByRole('button', { name: /Start DCA/i })).not.toBeDisabled()
  })

  it('is informational only — the note does NOT block submission (createOrder still fires)', async () => {
    checkOracleMock.mockResolvedValue({ hasOracle: false })
    renderWithProviders(<DCAPanel />) // curated ETH pair → no routability pre-check
    await screen.findByTestId('dca-oracle-note') // note is showing
    enterAmount('100')
    startDca()
    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
  })
})
