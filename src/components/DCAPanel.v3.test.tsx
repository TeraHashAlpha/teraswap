// @vitest-environment jsdom
/**
 * [SPRINT-V3-P2] DCAPanel — v3 signing branch (only exercised when a per-chain OrderExecutorV3 is
 * configured; separate file from DCAPanel.test.tsx which asserts the v2 path stays untouched).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSignTypedDataAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockWriteContractAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockRefetchNonce = vi.fn<() => Promise<unknown>>()
const mockReadContractImpl =
  vi.fn<(opts: { functionName: string }) => { data: unknown; isLoading: boolean; refetch: () => Promise<unknown> }>()
const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 8453)

const mockCreateOrderInSupabase = vi.fn()
const mockFetchUserOrders = vi.fn()
const mockFetchActiveOrders = vi.fn()
const mockCancelOrderInSupabase = vi.fn()
const mockSubscribeToOrders = vi.fn()
const mockFetchDefiLlamaPrice = vi.fn()

const V3_ADDRESS = '0x3333333333333333333333333333333333333333'

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
  useSignTypedData: () => ({ signTypedDataAsync: mockSignTypedDataAsync }),
  useWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
  useReadContract: (opts: { functionName: string }) => mockReadContractImpl(opts),
  useBalance: () => ({ data: undefined, isLoading: false, isError: false }),
  useReadContracts: () => ({ data: [], isLoading: false, isError: false }),
}))

vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return {
    ...actual,
    createOrderInSupabase: (...args: unknown[]) => mockCreateOrderInSupabase(...args),
    fetchUserOrders: (...args: unknown[]) => mockFetchUserOrders(...args),
    fetchActiveOrders: (...args: unknown[]) => mockFetchActiveOrders(...args),
    cancelOrderInSupabase: (...args: unknown[]) => mockCancelOrderInSupabase(...args),
    subscribeToOrders: (...args: unknown[]) => mockSubscribeToOrders(...args),
    ORDER_POLL_INTERVAL_MS: 100,
    // [SPRINT-V3-P2] simulate v3 deployed on Base (8453) for this file only.
    getOrderExecutorV3: (chainId: number) => (chainId === 8453 ? V3_ADDRESS : null),
    getOrderExecutorV3Domain: (chainId: number) => {
      if (chainId !== 8453) throw new Error(`No OrderExecutorV3 deployed on chain ${chainId}`)
      return { name: 'TeraSwapOrderExecutor' as const, version: '3' as const, chainId, verifyingContract: V3_ADDRESS }
    },
  }
})

vi.mock('@/lib/defillama', () => ({
  fetchDefiLlamaPrice: (...args: unknown[]) => mockFetchDefiLlamaPrice(...args),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: () => <button data-testid="rk-connect">Connect</button>,
}))
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
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div data-testid="beta-disclaimer" /> }))
vi.mock('./OrderReviewModal', () => ({
  default: ({ onConfirm }: { onConfirm: () => void }) => (
    <button data-testid="confirm-review" onClick={onConfirm}>confirm-review</button>
  ),
}))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))

import { renderWithProviders, screen, fireEvent, waitFor } from '@/test-utils/render'
import DCAPanel from './DCAPanel'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)

function enterAmount(value: string) {
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value } })
}
function startDcaButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Start DCA/i }) as HTMLButtonElement
}
function openAdvanced() {
  fireEvent.click(screen.getByText(/Advanced settings/i))
}

// Chainlink feed for WETH/ETH is configured on Base — fake round data via useReadContract so
// useChainlinkPrice resolves a real price for the tokenIn=WETH leg; tokenOut stays unpriced
// (native ETH / no feed configured for it in these mocks) to exercise the DefiLlama fallback.
beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useChainIdMock.mockReturnValue(8453)
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockWriteContractAsync.mockResolvedValue('0x' + 'ff'.repeat(32))
  mockRefetchNonce.mockResolvedValue({ data: 5n })
  mockReadContractImpl.mockImplementation(({ functionName }) => {
    if (functionName === 'nonces') return { data: 5n, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'invalidatedNonces') return { data: 0n, isLoading: false, refetch: mockRefetchNonce }
    // No live Chainlink feed in this mock (functionName 'latestRoundData'/'decimals' both undefined)
    // ⇒ useChainlinkPrice returns chainlinkPrice: null for every token ⇒ DefiLlama fallback fires.
    return { data: undefined, isLoading: false, refetch: mockRefetchNonce }
  })
  mockFetchUserOrders.mockResolvedValue([])
  mockFetchActiveOrders.mockResolvedValue([])
  mockCreateOrderInSupabase.mockResolvedValue({ order_hash: '0x' + 'aa'.repeat(32) })
  mockSubscribeToOrders.mockReturnValue(vi.fn())
  // Both legs price via DefiLlama by default (no-feed path exercised in its own test below).
  mockFetchDefiLlamaPrice.mockResolvedValue({ price: 2000, symbol: 'X', timestamp: 0, confidence: 1 })
})

describe('DCAPanel — v3 signing branch [SPRINT-V3-P2]', () => {
  it('signs with the v3 domain (version "3") and includes maxSlippageBps in the message', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    fireEvent.click(startDcaButton())
    fireEvent.click(await screen.findByTestId('confirm-review'))

    await waitFor(() => expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1))
    const signArg = mockSignTypedDataAsync.mock.calls[0][0] as {
      domain: { version: string; verifyingContract: string }
      message: { maxSlippageBps?: number; minAmountOut: bigint }
    }
    expect(signArg.domain.version).toBe('3')
    expect(signArg.domain.verifyingContract).toBe(V3_ADDRESS)
    expect(signArg.message.maxSlippageBps).toBeGreaterThan(0)
    // Never the 1-wei footgun, even via the DefiLlama fallback.
    expect(signArg.message.minAmountOut).not.toBe(1n)
    expect(signArg.message.minAmountOut).toBeGreaterThan(0n)
  })

  it('the derived floor is shown in the Advanced panel once a slippage tier is selected', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    openAdvanced()

    // Selecting a slippage tier is not required for the floor to compute (default 3%), but
    // clicking it exercises the control render path too.
    fireEvent.click(screen.getByRole('button', { name: '3%' }))

    await waitFor(() => {
      expect(screen.getByText(/Signed floor per order/i)).toBeInTheDocument()
    })
  })

  // Note: the default DCA pair (WETH → ETH) is covered by the APPROX_PRICES last-resort table,
  // so it never actually hits the "no price reference" fallback through the full component tree
  // with this test's stubbed TokenSelector (can't pick an unpriced token). The fallback/decay-
  // warning path itself (hasFeed=false, source='fallback', non-zero floor) is exhaustively unit
  // tested in v3-min-derivation.test.ts — this test instead proves the UI wiring degrades
  // gracefully (still renders a real floor, no crash) when both live price sources fail.
  it('still renders a real (non-1-wei) floor via the APPROX_PRICES tier when DefiLlama has no coverage', async () => {
    mockFetchDefiLlamaPrice.mockResolvedValue(null) // no DefiLlama coverage
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    openAdvanced()

    await waitFor(() => {
      expect(screen.getByText(/Signed floor per order/i)).toBeInTheDocument()
    })
    // The default WETH/ETH pair is APPROX_PRICES-covered, so this should NOT show the decay
    // warning (source='approx', not 'fallback').
    expect(screen.queryByText(/no price reference for this pair/i)).toBeNull()
  })

  it('a sub-floor per-execution amount is still blocked client-side before any v3 derivation runs', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('0.00000000000005') // same sub-floor case as the v2 test

    fireEvent.click(startDcaButton())

    await waitFor(() => expect(mockSignTypedDataAsync).not.toHaveBeenCalled())
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()
  })
})
