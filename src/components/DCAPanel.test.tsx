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
  // [CHORE-DCA-WETH-INPUT] CreateDCAForm now reads useTokenBalances() (which calls useBalance +
  // useReadContracts) for the "wrap ETH first" advisory hint. Default: empty balances ⇒ no hint,
  // so the existing build/sign/submit assertions are unaffected.
  useBalance: () => ({ data: undefined, isLoading: false, isError: false }),
  useReadContracts: () => ({ data: [], isLoading: false, isError: false }),
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
    // [CHORE-DCA-WETH-INPUT] The DCA INPUT now defaults to the chain's WETH (18 dec), not USDC.
    enterAmount('100') // 100 WETH over the default 10 buys ⇒ 10 WETH/buy, well above the floor

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
    // [CHORE-DCA-WETH-INPUT] INPUT defaults to WETH (18 dec) now: 5e-14 WETH = 50,000 base units
    // over the default 10 buys ⇒ 5,000 base units/buy < 10,000 floor (still a sub-floor case).
    enterAmount('0.00000000000005')

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

describe('DCAPanel — buys/interval presets [chore/dca-ux-tweaks]', () => {
  it('renders the updated Number of Buys presets (3/5/10/15/20/30); 7 and 14 are gone', () => {
    renderWithProviders(<DCAPanel />)
    for (const n of ['3', '5', '10', '15', '20', '30']) {
      expect(screen.getByRole('button', { name: n })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: '7' })).toBeNull()
    expect(screen.queryByRole('button', { name: '14' })).toBeNull()
  })

  it('offers a 1h interval option (added first)', () => {
    renderWithProviders(<DCAPanel />)
    // '1h' is also an expiry label, so there is ≥1 such button; the interval one is present.
    expect(screen.getAllByRole('button', { name: '1h' }).length).toBeGreaterThanOrEqual(1)
  })

  it('a high buy count (30) that puts the per-chunk under MIN_ORDER_AMOUNT surfaces the floor hint and blocks submit', async () => {
    renderWithProviders(<DCAPanel />)
    // 2e-13 WETH = 200,000 base units. At the default 10 buys → 20,000/buy (ok); at 30 → 6,666/buy (< 10,000 floor).
    enterAmount('0.0000000000002')
    expect(screen.queryByText(/on-chain minimum/i)).toBeNull() // ok at the default buy count

    fireEvent.click(screen.getByRole('button', { name: '30' }))

    expect(await screen.findByText(/on-chain minimum/i)).toBeInTheDocument()
    fireEvent.click(startDcaButton())
    // Under-floor ⇒ never frozen for review, never signed.
    await waitFor(() => expect(mockSignTypedDataAsync).not.toHaveBeenCalled())
    expect(screen.queryByTestId('confirm-review')).toBeNull()
  })
})

// [CHORE-DCA-CUSTOM-PERIODS] Custom interval/buys mode — Base only, frontend + order-creation
// validation only (no contract/keeper/gate change). Pure clamp/guard math is unit-tested in
// lib/order-engine/dca-custom.test.ts; these integration tests pin the UI wiring + the
// signed-params invariant end-to-end (real useOrderEngine, only Supabase I/O mocked).
describe('DCAPanel — Custom mode [CHORE-DCA-CUSTOM-PERIODS]', () => {
  it('the Custom toggle swaps the buys/interval presets for numeric inputs, and back', () => {
    renderWithProviders(<DCAPanel />)
    expect(screen.getByRole('button', { name: '10' })).toBeInTheDocument() // preset default visible

    fireEvent.click(screen.getByTestId('dca-custom-toggle'))
    expect(screen.getByTestId('dca-custom-buys-input')).toBeInTheDocument()
    expect(screen.getByTestId('dca-custom-interval-input')).toBeInTheDocument()
    expect(screen.getByTestId('dca-custom-expiry-auto')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '10' })).toBeNull() // preset grid gone

    fireEvent.click(screen.getByTestId('dca-custom-toggle'))
    expect(screen.getByRole('button', { name: '10' })).toBeInTheDocument() // presets restored
    expect(screen.queryByTestId('dca-custom-buys-input')).toBeNull()
  })

  it('clamps an out-of-range buys/interval value on blur', () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('dca-custom-toggle'))

    const buysInput = screen.getByTestId('dca-custom-buys-input') as HTMLInputElement
    fireEvent.change(buysInput, { target: { value: '500' } })
    fireEvent.blur(buysInput)
    expect(buysInput.value).toBe('100') // DCA_CUSTOM_BUYS_MAX

    const intervalInput = screen.getByTestId('dca-custom-interval-input') as HTMLInputElement
    fireEvent.change(intervalInput, { target: { value: '0' } })
    fireEvent.blur(intervalInput)
    expect(intervalInput.value).toBe('1') // DCA_CUSTOM_INTERVAL_NUMBER_MIN
  })

  it('caps buys and warns when the requested count would produce a dust chunk', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('dca-custom-toggle'))
    // 0.01 WETH ≈ $35 total (APPROX_PRICES). 100 buys → $0.35/buy, under the $5 default floor.
    // floor(35/5) = 7 buys clears it.
    enterAmount('0.01')
    const buysInput = screen.getByTestId('dca-custom-buys-input') as HTMLInputElement
    fireEvent.change(buysInput, { target: { value: '100' } })

    const warning = await screen.findByTestId('dca-min-chunk-warning')
    expect(warning.textContent).toMatch(/capped to 7 buys/)
  })

  it('blocks submit (never signs) when the total is too small to clear the minimum even at 1 buy', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('dca-custom-toggle'))
    // 0.001 WETH ≈ $3.50 total — below the $5 default floor even for a single buy.
    enterAmount('0.001')

    const warning = await screen.findByTestId('dca-min-chunk-warning')
    expect(warning.textContent).toMatch(/below the \$5 minimum/)

    fireEvent.click(startDcaButton())
    await waitFor(() => expect(mockSignTypedDataAsync).not.toHaveBeenCalled())
    expect(screen.queryByTestId('confirm-review')).toBeNull()
  })

  it('auto-derives expiry from interval × buys, and the existing hard-warn fires when that exceeds MAX_EXPIRY_DAYS', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('dca-custom-toggle'))
    enterAmount('100') // large total ⇒ never dust-capped here, isolates the expiry guard

    // 10 days × 100 buys = 1000 days, far past the 90-day server ceiling.
    fireEvent.click(screen.getByTestId('dca-custom-interval-unit-days'))
    fireEvent.change(screen.getByTestId('dca-custom-interval-input'), { target: { value: '10' } })
    fireEvent.change(screen.getByTestId('dca-custom-buys-input'), { target: { value: '100' } })

    expect(await screen.findByTestId('dca-expiry-block')).toBeInTheDocument()
    fireEvent.click(startDcaButton())
    await waitFor(() => expect(mockSignTypedDataAsync).not.toHaveBeenCalled())
    expect(screen.queryByTestId('confirm-review')).toBeNull()
  })

  it('signs a valid Custom order with dcaInterval/dcaTotal exactly matching the clamped custom values (within contract bounds)', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('dca-custom-toggle'))
    enterAmount('100')

    fireEvent.click(screen.getByTestId('dca-custom-interval-unit-hours'))
    fireEvent.change(screen.getByTestId('dca-custom-interval-input'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('dca-custom-buys-input'), { target: { value: '5' } })

    fireEvent.click(startDcaButton())
    fireEvent.click(await screen.findByTestId('confirm-review'))

    await waitFor(() => expect(mockCreateOrderInSupabase).toHaveBeenCalledTimes(1))
    const submitArg = mockCreateOrderInSupabase.mock.calls[0][0] as { dcaInterval: number; dcaTotal: number }
    expect(submitArg.dcaInterval).toBe(2 * 3600) // 2h — mirrors the contract's dcaInterval > 0 guard
    expect(submitArg.dcaTotal).toBe(5)           // mirrors the contract's dcaTotal > 0 guard
  })
})
