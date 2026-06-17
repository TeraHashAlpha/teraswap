// @vitest-environment jsdom
/**
 * [SPRINT-DCA-UNGATE] DCAPanel — functional DCA order creation (Base only).
 *
 * Integration test against the REAL useOrderEngine (only wagmi + the Supabase
 * I/O layer are mocked), so the build → EIP-712 sign → submit path, the #200
 * client-side MIN_ORDER_AMOUNT floor, and the freeze-403 handling are all
 * exercised end-to-end:
 *   - renders the create form,
 *   - a valid DCA order builds, signs (Base domain) and submits,
 *   - a sub-floor per-execution amount is blocked client-side (never signed),
 *   - a freeze-403 surfaces a calm "DCA temporarily paused" state + disabled submit.
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

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
  useSignTypedData: () => ({ signTypedDataAsync: mockSignTypedDataAsync }),
  useWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
  useReadContract: (opts: { functionName: string }) => mockReadContractImpl(opts),
}))

// Keep enums/constants/config real (getOrderExecutor, MIN_ORDER_AMOUNT, presets);
// stub only the Supabase I/O surface.
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
  }
})

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
// Render the review modal as a single "confirm" button so we can drive Phase B (sign + submit).
vi.mock('./OrderReviewModal', () => ({
  default: ({ onConfirm }: { onConfirm: () => void }) => (
    <button data-testid="confirm-review" onClick={onConfirm}>confirm-review</button>
  ),
}))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))

import { renderWithProviders, screen, fireEvent, waitFor } from '@/test-utils/render'
import DCAPanel from './DCAPanel'
import { getOrderExecutor } from '@/lib/order-engine'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)
// Mirrors the server's freeze-403 body message (route.ts), as rethrown by createOrderInSupabase.
const FREEZE_MSG =
  'New DCA orders are temporarily paused: scheduled maintenance. Existing orders are unaffected and you can still cancel them.'

function enterAmount(value: string) {
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value } })
}

function startDcaButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Start DCA/i }) as HTMLButtonElement
}

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useChainIdMock.mockReturnValue(8453) // Base
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
})

describe('DCAPanel — create form', () => {
  it('renders the DCA create form when connected', () => {
    renderWithProviders(<DCAPanel />)
    expect(screen.getByText(/Dollar Cost Averaging/i)).toBeInTheDocument()
  })
})

describe('DCAPanel — valid order build → sign → submit', () => {
  it('builds, EIP-712 signs against the Base executor domain, and submits a DCA order', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100') // 100 USDC over 7 buys ⇒ ~14.28 USDC/buy, well above the floor

    fireEvent.click(startDcaButton())
    // Phase A froze the order for review — confirm it to sign + submit (Phase B).
    fireEvent.click(await screen.findByTestId('confirm-review'))

    await waitFor(() => expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1))
    const signArg = mockSignTypedDataAsync.mock.calls[0][0] as {
      domain: { chainId: number; verifyingContract: string }
    }
    expect(signArg.domain.chainId).toBe(8453)
    expect(signArg.domain.verifyingContract).toBe(getOrderExecutor(8453))

    await waitFor(() => expect(mockCreateOrderInSupabase).toHaveBeenCalledTimes(1))
    const submitArg = mockCreateOrderInSupabase.mock.calls[0][0] as { orderType: string }
    expect(submitArg.orderType).toBe('dca')
  })
})

describe('DCAPanel — #200 client-side MIN_ORDER_AMOUNT floor', () => {
  it('blocks a sub-floor per-execution amount client-side — never reaches review or signing', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('0.05') // 0.05 USDC over 7 buys ⇒ ~7,142 base units/buy < 10,000 floor

    fireEvent.click(startDcaButton())

    // No review modal is ever frozen, and no signature is requested.
    await waitFor(() => expect(mockSignTypedDataAsync).not.toHaveBeenCalled())
    expect(screen.queryByTestId('confirm-review')).toBeNull()
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()
  })
})

describe('DCAPanel — freeze (403) handling', () => {
  it('surfaces a calm "DCA temporarily paused" state and disables submit on the freeze-403', async () => {
    mockCreateOrderInSupabase.mockRejectedValueOnce(new Error(FREEZE_MSG))
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    fireEvent.click(startDcaButton())
    fireEvent.click(await screen.findByTestId('confirm-review'))

    // Friendly paused message (not the raw error) + the submit control disabled.
    expect(await screen.findByText(/existing orders are unaffected/i)).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: /temporarily paused/i }) as HTMLButtonElement
    expect(submit).toBeDisabled()
  })
})
