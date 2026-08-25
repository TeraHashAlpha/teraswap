// @vitest-environment jsdom
/**
 * [FIX-CHAIN-SCOPED-FEATURE-MESSAGES] DCAPanel — the availability banner shown when the connected
 * chain has no v3 order-engine executor wired, versus the oracle price-verification banner shown
 * when a chain DOES have an executor but a Chainlink feed failed to read.
 *
 * The two states must stay distinct: a chain with no executor is an infrastructure gap (v3Enabled
 * is false, so `oracleGate` is never even armed — see DCAPanel's own `oracleBlocked = v3Enabled &&
 * oracleGate.blocked`), while a chain WITH an executor whose feed can't be read is a genuine
 * fail-closed price-verification block (ADR-013) that must render unchanged. Conflating them would
 * either misdiagnose a missing executor as an oracle problem, or — the more dangerous direction —
 * silently swallow a real oracle failure on a chain that DOES sign orders.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSignTypedDataAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockWriteContractAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockRefetchNonce = vi.fn<() => Promise<unknown>>()
const mockReadContractImpl = vi.fn<
  (opts: { address?: string; functionName: string }) => {
    data: unknown
    isLoading: boolean
    isError?: boolean
    refetch: () => Promise<unknown>
  }
>()
const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 8453)

const mockCreateOrderInSupabase = vi.fn()
const mockFetchUserOrders = vi.fn()
const mockFetchActiveOrders = vi.fn()
const mockCancelOrderInSupabase = vi.fn()
const mockSubscribeToOrders = vi.fn()
const mockFetchDefiLlamaPrice = vi.fn()

// Base has a wired v3 executor here; Arbitrum One (42161) deliberately does not — mirrors
// production today (SPRINT-48-ARBITRUM-DCA-PREP shipped Arbitrum's v3 slot unset).
const V3_ADDRESS = '0x3333333333333333333333333333333333333333'
const ARBITRUM_CHAIN_ID = 42161
const BASE_ETH_USD_FEED = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
  useSignTypedData: () => ({ signTypedDataAsync: mockSignTypedDataAsync }),
  useWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
  useReadContract: (opts: { address?: string; functionName: string }) => mockReadContractImpl(opts),
  useBalance: () => ({ data: undefined, isLoading: false, isError: false }),
  useReadContracts: () => ({ data: [], isLoading: false, isError: false }),
}))

vi.mock('@/hooks/useDepegCheck', () => ({
  useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }),
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
    // Base (8453) has a wired v3 executor; Arbitrum One (42161) does not — the real
    // ORDER_EXECUTOR_BY_CHAIN state today (this fix must not change it).
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
vi.mock('./NoFeedConsentModal', () => ({ default: () => null }))

import { renderWithProviders, screen, fireEvent, waitFor } from '@/test-utils/render'
import DCAPanel from './DCAPanel'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)

function enterAmount(value: string) {
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value } })
}

function healthyRound() {
  const now = BigInt(Math.floor(Date.now() / 1000))
  return [1n, 2000_00000000n, now - 60n, now - 60n, 1n]
}

function feedReads(override?: (addr: string, fn: string) => { data: unknown; isError?: boolean } | undefined) {
  return ({ address, functionName }: { address?: string; functionName: string }) => {
    if (functionName === 'nonces') return { data: 5n, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'invalidatedNonces') return { data: 0n, isLoading: false, refetch: mockRefetchNonce }
    const addr = (address ?? '').toLowerCase()
    const forced = override?.(addr, functionName)
    if (forced) return { ...forced, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'latestRoundData') return { data: healthyRound(), isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'decimals') return { data: 8, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'description') return { data: 'ETH / USD', isLoading: false, refetch: mockRefetchNonce }
    return { data: undefined, isLoading: false, refetch: mockRefetchNonce }
  }
}

/** Same identity-mismatch fixture as DCAPanel.oracle-fail-closed.test.tsx — a real oracle failure. */
function mockIdentityMismatch() {
  mockReadContractImpl.mockImplementation(
    feedReads((addr, fn) =>
      addr === BASE_ETH_USD_FEED.toLowerCase() && fn === 'description'
        ? { data: 'BTC / USD' }
        : undefined,
    ),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockWriteContractAsync.mockResolvedValue('0x' + 'ff'.repeat(32))
  mockRefetchNonce.mockResolvedValue({ data: 5n })
  mockReadContractImpl.mockImplementation(feedReads())
  mockFetchUserOrders.mockResolvedValue([])
  mockFetchActiveOrders.mockResolvedValue([])
  mockCreateOrderInSupabase.mockResolvedValue({ order_hash: '0x' + 'aa'.repeat(32) })
  mockSubscribeToOrders.mockReturnValue(vi.fn())
  mockFetchDefiLlamaPrice.mockResolvedValue({ price: 2000, symbol: 'X', timestamp: 0, confidence: 1 })
})

describe('DCAPanel — chain-scoped availability vs. oracle price-verification [FIX-CHAIN-SCOPED-FEATURE-MESSAGES]', () => {
  it('no executor for the chain (Arbitrum One): shows the availability message naming the chain, not the oracle banner', async () => {
    useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: ARBITRUM_CHAIN_ID } })
    useChainIdMock.mockReturnValue(ARBITRUM_CHAIN_ID)
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    const banner = await screen.findByTestId('dca-chain-unavailable')
    expect(banner.textContent).toMatch(/DCA is not available on Arbitrum One yet/i)
    // Never blames the oracle for an absent executor.
    expect(banner.textContent).not.toMatch(/price could not be verified/i)
    expect(banner.textContent).not.toMatch(/Chainlink/i)
    expect(screen.queryByTestId('dca-oracle-block')).toBeNull()
  })

  it('has an executor (Base) but the feed cannot be read: the existing oracle-verification banner renders unchanged', async () => {
    useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: 8453 } })
    useChainIdMock.mockReturnValue(8453)
    mockIdentityMismatch()
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    const banner = await screen.findByTestId('dca-oracle-block')
    expect(banner.textContent).toMatch(/price could not be verified/i)
    // The chain-availability banner must not fire — Base DOES have an executor.
    expect(screen.queryByTestId('dca-chain-unavailable')).toBeNull()
  })

  it('a healthy Base order still signs — the fix does not touch the working v3 path', async () => {
    useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: 8453 } })
    useChainIdMock.mockReturnValue(8453)
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    expect(screen.queryByTestId('dca-oracle-block')).toBeNull()
    expect(screen.queryByTestId('dca-chain-unavailable')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Start DCA/i }))
    fireEvent.click(await screen.findByTestId('confirm-review'))

    await waitFor(() => expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1))
  })
})
