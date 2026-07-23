// @vitest-environment jsdom
/**
 * [CHORE-DCA-COST-PREVIEW] DCAPanel — per-buy cost preview line.
 *
 * Real order-engine module (only Supabase I/O is mocked, same convention as DCAPanel.test.tsx),
 * so this exercises the ACTUAL computeDcaCostPreview wiring against the real DEFAULT_TOKENS/
 * APPROX_PRICES/DCA_TOTAL_PRESETS, not a stub.
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
  useBalance: () => ({ data: undefined, isLoading: false, isError: false }),
  useReadContracts: () => ({ data: [], isLoading: false, isError: false }),
  useReadContract: (opts: { functionName: string }) => mockReadContractImpl(opts),
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
  }
})

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: () => <button data-testid="rk-connect">Connect</button>,
}))
vi.mock('@/lib/sounds', () => ({
  playClick: vi.fn(), playTouchMP3: vi.fn(), playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(), startWaitingSound: vi.fn(), stopWaitingSound: vi.fn(),
}))
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: vi.fn() }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: vi.fn() }))
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => null }))
vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected }: { selected: { symbol: string } | null }) => (
    <div data-testid="token-selector">{selected?.symbol}</div>
  ),
}))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => ({ chainlinkPrice: null }) }))
vi.mock('@/lib/defillama', () => ({ fetchDefiLlamaPrice: vi.fn().mockResolvedValue(null) }))

import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import DCAPanel from './DCAPanel'
import {
  DCA_NETWORK_COST_ESTIMATE_USD,
  DCA_NETWORK_COST_COVERAGE_LABEL,
} from '@/lib/order-engine'

const ADDRESS = '0x1111111111111111111111111111111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  mockReadContractImpl.mockReturnValue({ data: undefined, isLoading: false, refetch: mockRefetchNonce })
  mockFetchActiveOrders.mockResolvedValue([])
  mockFetchUserOrders.mockResolvedValue([])
  mockSubscribeToOrders.mockReturnValue(() => {})
})

function fillAmount(value: string) {
  const input = screen.getByPlaceholderText('0.00')
  fireEvent.change(input, { target: { value } })
}

describe('DCAPanel [CHORE-DCA-COST-PREVIEW] — per-buy cost preview', () => {
  it('is hidden when no amount has been entered', () => {
    renderWithProviders(<DCAPanel />)
    expect(screen.queryByTestId('dca-cost-preview')).not.toBeInTheDocument()
  })

  it('renders with correct fee math once an amount is entered (default WETH @ $3500, 10 buys)', () => {
    renderWithProviders(<DCAPanel />)
    fillAmount('10') // 10 WETH total @ $3500 = $35,000; default 10 buys => $3,500/chunk
    const preview = screen.getByTestId('dca-cost-preview')
    // 0.1% of $3,500 = $3.50
    expect(preview.textContent).toMatch(/\$3\.50/)
    expect(preview.textContent).toContain(`$${DCA_NETWORK_COST_ESTIMATE_USD.toFixed(2)}`)
    expect(preview.textContent).toContain(DCA_NETWORK_COST_COVERAGE_LABEL)
  })

  it('scales the fee line with a smaller chunk size (1 WETH total)', () => {
    renderWithProviders(<DCAPanel />)
    fillAmount('1') // 1 WETH total @ $3500 = $3,500; 10 buys => $350/chunk => fee $0.35
    const preview = screen.getByTestId('dca-cost-preview')
    expect(preview.textContent).toMatch(/\$0\.35/)
  })

  it('never contains the word "free" or "gasless" anywhere in the preview', () => {
    renderWithProviders(<DCAPanel />)
    fillAmount('10')
    const preview = screen.getByTestId('dca-cost-preview')
    expect(preview.textContent?.toLowerCase()).not.toMatch(/free|gasless/)
  })

  it('never claims "free"/"gasless" anywhere on the page, not just inside the preview element', () => {
    renderWithProviders(<DCAPanel />)
    fillAmount('10')
    const body = document.body.textContent?.toLowerCase() ?? ''
    expect(body).not.toMatch(/\bfree\b|gasless/)
  })
})
