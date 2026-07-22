// @vitest-environment jsdom
/**
 * [CHORE-DCA-BUDGET-UX] DCAPanel — "Max execution cost" $ field.
 *
 * Display/derivation only: the $ input feeds the EXISTING maxSlippageBps value (already signed
 * via the v3 path, SPRINT-V3-P2). No new signed field, no signing change — this file never
 * asserts on the signed message beyond maxSlippageBps itself, already covered by DCAPanel.v3.test.tsx.
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
    // v3 deployed on Base (8453) for this file; null everywhere else (v2 mode).
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
function openAdvanced() {
  fireEvent.click(screen.getByText(/Advanced settings/i))
}
function startDcaButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Start DCA/i }) as HTMLButtonElement
}

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
    return { data: undefined, isLoading: false, refetch: mockRefetchNonce }
  })
  mockFetchUserOrders.mockResolvedValue([])
  mockFetchActiveOrders.mockResolvedValue([])
  mockCreateOrderInSupabase.mockResolvedValue({ order_hash: '0x' + 'aa'.repeat(32) })
  mockSubscribeToOrders.mockReturnValue(vi.fn())
  mockFetchDefiLlamaPrice.mockResolvedValue({ price: 2000, symbol: 'X', timestamp: 0, confidence: 1 })
})

describe('DCAPanel — Max execution cost budget field [CHORE-DCA-BUDGET-UX]', () => {
  it('is hidden in v2 mode (no v3 executor configured for the connected chain)', async () => {
    useChainIdMock.mockReturnValue(1) // mainnet — no v3 executor in the mock above
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    openAdvanced()

    expect(screen.queryByText(/Max execution cost/i)).toBeNull()
    expect(screen.queryByTestId('dca-budget-usd-input')).toBeNull()
  })

  it('is shown in v3 mode and typing a $ value re-derives maxSlippageBps (input->bps wiring)', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    openAdvanced()

    const input = await screen.findByTestId('dca-budget-usd-input')
    // $100 notional, priced via APPROX_PRICES/DefiLlama at ~$2000/ETH -> totalUsd ~$200000.
    // A $2 budget on that notional maps to a tiny bps well under the 3% default preset, so the
    // "3%" preset button should no longer read as selected once the user edits the $ field.
    fireEvent.change(input, { target: { value: '2' } })

    await waitFor(() => {
      const threePctButton = screen.getByRole('button', { name: '3%' })
      expect(threePctButton.className).not.toContain('border-cream-gold')
    })
  })

  it('clamping at the on-chain cap (500 bps) surfaces a visible warning', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    openAdvanced()

    const input = await screen.findByTestId('dca-budget-usd-input')
    // An enormous $ budget relative to any priced notional always clamps to the 500bps ceiling.
    fireEvent.change(input, { target: { value: '999999999' } })

    await waitFor(() => {
      expect(screen.getByTestId('dca-budget-clamp-warning')).toBeInTheDocument()
    })
  })

  it('the default shown placeholder is unchanged (DEFAULT_MAX_SLIPPAGE_BPS) when the field is untouched', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    openAdvanced()

    const input = await screen.findByTestId('dca-budget-usd-input') as HTMLInputElement
    // Untouched -> value is empty (placeholder shows the default $, not a controlled value),
    // and the 3% preset (DEFAULT_MAX_SLIPPAGE_BPS) still reads as selected.
    expect(input.value).toBe('')
    expect(screen.getByRole('button', { name: '3%' }).className).toContain('border-cream-gold')
  })

  it('selecting a bps preset after editing the $ field hands control back to the preset (no fighting)', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    openAdvanced()

    const input = await screen.findByTestId('dca-budget-usd-input')
    fireEvent.change(input, { target: { value: '2' } })
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('2'))

    fireEvent.click(screen.getByRole('button', { name: '5%' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '5%' }).className).toContain('border-cream-gold')
    })
  })

  it('does not change the signed maxSlippageBps message shape (still a plain number, no new field)', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    fireEvent.click(startDcaButton())
    fireEvent.click(await screen.findByTestId('confirm-review'))

    await waitFor(() => expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1))
    const signArg = mockSignTypedDataAsync.mock.calls[0][0] as {
      message: Record<string, unknown>
    }
    // No new key was added to the signed message by this chore.
    expect(Object.keys(signArg.message)).not.toContain('budgetUsd')
    expect(Object.keys(signArg.message)).not.toContain('maxExecutionCostUsd')
    expect(typeof signArg.message.maxSlippageBps).toBe('number')
  })
})
