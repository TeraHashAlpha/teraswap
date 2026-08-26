// @vitest-environment jsdom
/**
 * [FIX-USD-SCOPE-GUARD-AND-UNCHECKABLE-DUST-GUARD, L-2] The `dca-minchunk-uncheckable` notice.
 *
 * `applyDcaMinChunkGuard` fails OPEN — silently — whenever `totalUsd` is null (spend leg has no
 * live Chainlink/DefiLlama price). That silence used to be masked: `totalUsd` was priced from the
 * always-present `APPROX_PRICES` table, so the client-side SC-02 min-chunk guard always had a number
 * to check. Now that the gate reads only live prices (FIX-CBETH-DIRECT-FEED-AND-APPROX-SCOPE), a
 * table-only/unpriced token silently skips the client check with no indication to the user — this
 * suite pins the notice that replaces the silence, and that it never fires alongside the
 * oracle-blocked banner (which already covers "we could not verify this price" for the cases where
 * v3 signing is armed).
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

const V3_ADDRESS = '0x3333333333333333333333333333333333333333'
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
  default: ({
    selected, onSelect, hideNativeInput,
  }: { selected: { symbol?: string } | null; onSelect: (t: unknown) => void; hideNativeInput?: boolean }) => {
    const side = hideNativeInput ? 'in' : 'out'
    return (
      <div data-testid={`token-selector-${side}`}>
        {selected?.symbol ?? 'Select'}
        <button data-testid={`pick-feedless-${side}`} onClick={() => onSelect(FEEDLESS_TOKEN)}>pick-feedless</button>
      </div>
    )
  },
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

/** A token absent from every feed registry AND from the DefiLlama mock's priced set below. */
const FEEDLESS_TOKEN = {
  address: '0x00000000000000000000000000000000deadfeed',
  symbol: 'NOFEED',
  decimals: 18,
  name: 'No Feed Token',
  chainId: 8453,
}

function enterAmount(value: string) {
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value } })
}
function toggleCustomMode() {
  fireEvent.click(screen.getByTestId('dca-custom-toggle'))
}
function pickFeedlessSpend() {
  fireEvent.click(screen.getByTestId('pick-feedless-in'))
}
function startDcaButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Start DCA/i }) as HTMLButtonElement
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

function mockIdentityMismatch() {
  mockReadContractImpl.mockImplementation(
    feedReads((addr, fn) =>
      addr === BASE_ETH_USD_FEED.toLowerCase() && fn === 'description'
        ? { data: 'BTC / USD' }
        : undefined,
    ),
  )
}

/** DefiLlama: healthy $2000 for any address EXCEPT the feedless fixture, which resolves null —
 *  modeling "no live price from either source" for the spend leg once it's selected as feedless. */
function defillamaByAddress(addr: string) {
  return addr.toLowerCase() === FEEDLESS_TOKEN.address.toLowerCase()
    ? Promise.resolve(null)
    : Promise.resolve({ price: 2000, symbol: 'X', timestamp: 0, confidence: 1 })
}

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: 8453 } })
  useChainIdMock.mockReturnValue(8453)
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockWriteContractAsync.mockResolvedValue('0x' + 'ff'.repeat(32))
  mockRefetchNonce.mockResolvedValue({ data: 5n })
  mockReadContractImpl.mockImplementation(feedReads())
  mockFetchUserOrders.mockResolvedValue([])
  mockFetchActiveOrders.mockResolvedValue([])
  mockCreateOrderInSupabase.mockResolvedValue({ order_hash: '0x' + 'aa'.repeat(32) })
  mockSubscribeToOrders.mockReturnValue(vi.fn())
  mockFetchDefiLlamaPrice.mockImplementation((addr: string) => defillamaByAddress(addr))
})

describe('DCAPanel — dca-minchunk-uncheckable [FIX-USD-SCOPE-GUARD-AND-UNCHECKABLE-DUST-GUARD]', () => {
  it('an unpriced spend leg (no Chainlink feed, DefiLlama also empty) renders the notice', async () => {
    renderWithProviders(<DCAPanel />)
    toggleCustomMode()
    pickFeedlessSpend()
    await waitFor(() => expect(screen.getByTestId('token-selector-in').textContent).toMatch(/NOFEED/))
    enterAmount('100')

    const notice = await screen.findByTestId('dca-minchunk-uncheckable')
    expect(notice.textContent).toMatch(/per-chunk minimum could not be checked/i)
    expect(notice.textContent).toMatch(/NOFEED/)
    expect(screen.queryByTestId('dca-oracle-block')).toBeNull()
  })

  it('a priced spend leg (healthy default WETH) does NOT render the notice', async () => {
    renderWithProviders(<DCAPanel />)
    toggleCustomMode()
    enterAmount('100')

    await waitFor(() => expect(startDcaButton()).toBeInTheDocument())
    expect(screen.queryByTestId('dca-minchunk-uncheckable')).toBeNull()
  })

  it('an oracle-blocked panel shows the oracle banner, never this one', async () => {
    mockIdentityMismatch()
    renderWithProviders(<DCAPanel />)
    toggleCustomMode()
    enterAmount('100')

    await waitFor(() => expect(screen.getByTestId('dca-oracle-block')).toBeInTheDocument())
    // The spend leg IS unpriced here too (identity mismatch ⇒ chainlinkPriceIn null, and the fallback
    // to DefiLlama is itself blocked by the oracle failure) — the uncheckable notice must still not
    // fire, because the oracle banner already covers this case with the correct, more specific reason.
    expect(screen.queryByTestId('dca-minchunk-uncheckable')).toBeNull()
  })
})
