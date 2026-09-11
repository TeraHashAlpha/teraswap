// @vitest-environment jsdom
/**
 * [fix/limit-sltp-chain-aware-price-feed — Auditor H2 on merge 227a7f2] A LIMIT order must sign an
 * `order.priceFeed` that exists ON THE CHAIN IT IS SIGNED FOR.
 *
 * WHY — `getChainlinkFeeds(_chainId)` (order-engine/config.ts:367) took a chainId and DISCARDED it,
 * returning the MAINNET map unconditionally, and this panel's `findPriceFeed` keyed that map by
 * SYMBOL. Limit/TP are Base-only (`isLimitLive` → limit-launch.ts:45, LIMIT_TP_CHAIN_ID = 8453), so
 * every Base order signed a MAINNET aggregator address. That address has no code on Base, and
 * `_checkPriceCondition` calls `feed.latestRoundData()` on it (TeraSwapOrderExecutorV3.sol:1117,
 * reached from the call site at :504) — Solidity's extcodesize guard reverts, so EVERY fill reverts
 * before any swap. Signed orders would be permanently unfillable, cancel-only.
 *
 * The fix routes `findPriceFeed` through `resolveOrderPriceFeed` (order-engine/price-feed.ts):
 * every non-mainnet chain resolves through the chain-aware, ADDRESS-keyed
 * `getChainlinkFeed(token, chainId)` (chains/chainlink-feeds.ts:100); mainnet keeps EXACTLY its
 * origin/main symbol-table behaviour (NARROWED — see price-feed.test.ts, which pins the set).
 *
 * EVERY expected feed address in this file is read from `getChainlinkFeed` at assertion time. There
 * is not one feed-address literal in an assertion — a test that hardcoded 0x71041ddd… would pass
 * just as well against a second, drifting copy of the map, which is the bug class itself. On
 * mainnet that expectation doubles as a cross-check: the symbol table's ETH/USD and the registry's
 * CHAINLINK_ETH_USD must be the same aggregator.
 *
 * The two chain ids straddle the v2/v3 signing fork on purpose (Base = v3, mainnet = v2), so the
 * resolution is proved to sit ahead of the fork rather than inside one branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSignTypedDataAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockWriteContractAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockRefetchNonce = vi.fn<() => Promise<unknown>>()
const useAccountMock = vi.fn()

const mockCreateOrderInSupabase = vi.fn()
const mockFetchUserOrders = vi.fn()
const mockFetchActiveOrders = vi.fn()
const mockCancelOrderInSupabase = vi.fn()
const mockSubscribeToOrders = vi.fn()
const mockFetchCurrentPrice = vi.fn()

/** The chain under test — read by the wagmi mock AND by the TokenSelector mock's per-chain tokens. */
let CHAIN_ID = 8453

/** The Base (8453) OrderExecutorV3 — docs/DEPLOYMENTS.md, LIVE since the 2026-07-21 cutover. */
const V3_BASE = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'

/**
 * A chain the feed registry does not cover at all: `CHAINLINK_FEEDS_BY_CHAIN[10]` is undefined and
 * `getChainConfig(10)` throws. Optimism is a real, plausible mis-connection — not a nonsense id.
 */
const UNCOVERED_CHAIN_ID = 10

/** The SPEND leg for the native-buy shape: a stablecoin, so the BUY leg is the feed token. */
const USDC: Record<number, { address: string; symbol: string; decimals: number }> = {
  8453: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  1: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
  // On the uncovered chain the addresses deliberately stay the MAINNET ones: a token that HAS a
  // mainnet feed must still resolve nothing on a chain the registry does not cover. That is the
  // cross-chain leak the old symbol-keyed lookup permitted.
  [UNCOVERED_CHAIN_ID]: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
}

/**
 * LINK — a non-stable spend leg. Its MAINNET address has a mainnet feed; its BASE address has NO
 * entry in CHAINLINK_FEEDS_BY_CHAIN[8453]. That asymmetry is the whole point: under the old
 * symbol-keyed lookup both resolved to the mainnet LINK/USD aggregator.
 */
const LINK: Record<number, { address: string; symbol: string; decimals: number }> = {
  8453: { address: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196', symbol: 'LINK', decimals: 18 },
  1: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18 },
  [UNCOVERED_CHAIN_ID]: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18 },
}

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => CHAIN_ID,
  useSignTypedData: () => ({ signTypedDataAsync: mockSignTypedDataAsync }),
  useWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
  useReadContract: (opts: { functionName?: string }) =>
    opts.functionName === 'nonces' || opts.functionName === 'invalidatedNonces'
      ? { data: opts.functionName === 'nonces' ? 5n : 0n, isLoading: false, refetch: mockRefetchNonce }
      : { data: undefined, isLoading: false, refetch: mockRefetchNonce },
  useReadContracts: () => ({ data: [], isLoading: false, isError: false }),
  useWaitForTransactionReceipt: ({ hash }: { hash?: string }) => ({ isSuccess: !!hash, isError: false }),
  useBalance: () => ({ data: undefined, isLoading: false, isError: false }),
}))

vi.mock('@/hooks/useDepegCheck', () => ({
  useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }),
}))

vi.mock('@/lib/limit-order-api', () => ({
  fetchCurrentPrice: (...args: unknown[]) => mockFetchCurrentPrice(...args),
  buildLimitOrderParams: vi.fn(),
  submitLimitOrder: vi.fn(),
  fetchLimitOrderStatus: vi.fn(),
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
    getOrderExecutorV3: (chainId: number) => (chainId === 8453 ? V3_BASE : null),
    getOrderExecutorV3Domain: (chainId: number) => {
      if (chainId !== 8453) throw new Error(`No OrderExecutorV3 deployed on chain ${chainId}`)
      return { name: 'TeraSwapOrderExecutor' as const, version: '3' as const, chainId, verifyingContract: V3_BASE }
    },
    // Only the NEXT_PUBLIC_LIMIT_ENABLED half is stubbed; the chain half stays honest, so Base is
    // still v3 and mainnet still v2 — the fork these chain ids exist to straddle.
    isLimitLive: (chainId: number) => chainId === 8453,
    resolveSigningExecutor: (chainId: number, isV3Order: boolean) =>
      isV3Order ? (chainId === 8453 ? V3_BASE : null) : actual.getOrderExecutor(chainId),
    // [ADR-020] The router gate (`getDefaultRouter` → null) fires BEFORE the feed gate and would
    // refuse chain 10 for a reason that has nothing to do with feeds. Lending the uncovered chain a
    // router removes that earlier gate so the FEED gate is the one actually under test. Chains 1 and
    // 8453 keep their real routers — this only ever synthesises one where production has none.
    getDefaultRouter: (chainId: number) => actual.getDefaultRouter(chainId) ?? actual.getDefaultRouter(1),
  }
})

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: () => <button>Connect</button>,
  useConnectModal: () => ({ openConnectModal: vi.fn() }),
}))
vi.mock('@/lib/sounds', () => ({
  playClick: vi.fn(), playTouchMP3: vi.fn(), playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(), startWaitingSound: vi.fn(), stopWaitingSound: vi.fn(),
}))
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: vi.fn() }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: vi.fn() }))
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div /> }))
vi.mock('@/components/ExecutionTimeline', () => ({ default: () => <div /> }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))

vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected, onSelect }: {
    selected: { symbol?: string } | null
    onSelect: (t: unknown) => void
  }) => (
    <div data-testid="token-selector">
      <span data-testid="symbol">{selected?.symbol ?? 'Select'}</span>
      <button
        data-testid="pick-native"
        onClick={() => onSelect({
          address: NATIVE_ETH, symbol: 'ETH', name: 'Ether', decimals: 18,
          logoURI: '', category: 'Native',
        })}
      >pick-native</button>
      {/* The WRAPPED native, picked DIRECTLY — the case the #490 fallback existed for. */}
      <button
        data-testid="pick-weth"
        onClick={() => onSelect(wrappedNativeToken(CHAIN_ID))}
      >pick-weth</button>
      <button
        data-testid="pick-usdc"
        onClick={() => onSelect({ ...USDC[CHAIN_ID], name: 'USD Coin', logoURI: '', category: 'Stablecoin', chainId: CHAIN_ID })}
      >pick-usdc</button>
      <button
        data-testid="pick-link"
        onClick={() => onSelect({ ...LINK[CHAIN_ID], name: 'Chainlink', logoURI: '', category: 'DeFi', chainId: CHAIN_ID })}
      >pick-link</button>
    </div>
  ),
}))

import { renderWithProviders, screen, fireEvent, waitFor, act } from '@/test-utils/render'
import LimitOrderPanel from './LimitOrderPanel'
import { getWrappedNative } from '@/lib/chains/registry'
import { getChainlinkFeed } from '@/lib/chains/chainlink-feeds'
import { NATIVE_ETH } from '@/lib/constants'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)

/**
 * The chain's wrapped native as an ordinary catalog token. A function declaration (hoisted) so the
 * TokenSelector mock factory above can reference it; it is only ever CALLED on click, long after
 * module init. The address comes from the registry, never a literal.
 */
function wrappedNativeToken(chainId: number) {
  return {
    address: getWrappedNative(chainId),
    symbol: 'WETH', name: 'Wrapped Ether', decimals: 18,
    logoURI: '', category: 'Native', chainId,
  }
}

/** Sell selector = first in the DOM; buy selector = second. */
const sell = (testId: string) => screen.getAllByTestId(testId)[0]
const buy = (testId: string) => screen.getAllByTestId(testId)[1]

const enterAmount = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: v } })

const enterDisplayPrice = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: v } })

async function driveToSignature() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Place Limit Order/i })) })
  const approve = screen.queryByTestId('order-approve')
  if (approve) await act(async () => { fireEvent.click(approve) })
  const confirm = screen.queryByTestId('order-confirm')
  if (confirm) await act(async () => { fireEvent.click(confirm) })
}

/** The `priceFeed` of the EIP-712 message actually handed to the wallet. */
function signedPriceFeed(): string {
  expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1)
  const arg = mockSignTypedDataAsync.mock.calls[0][0] as { message: { priceFeed: string } }
  return arg.message.priceFeed
}

/** Nothing left the browser: no signature request AND no transaction. */
function expectZeroWalletCalls() {
  expect(mockSignTypedDataAsync).not.toHaveBeenCalled()
  expect(mockWriteContractAsync).not.toHaveBeenCalled()
}

async function renderOn(chainId: number) {
  CHAIN_ID = chainId
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: chainId } })
  renderWithProviders(<LimitOrderPanel />)
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  vi.clearAllMocks()
  CHAIN_ID = 8453
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: CHAIN_ID } })
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockWriteContractAsync.mockResolvedValue('0x' + 'ff'.repeat(32))
  mockRefetchNonce.mockResolvedValue({ data: 5n })
  mockFetchUserOrders.mockResolvedValue([])
  mockFetchActiveOrders.mockResolvedValue([])
  mockCreateOrderInSupabase.mockResolvedValue({ order_hash: '0x' + 'aa'.repeat(32) })
  mockSubscribeToOrders.mockReturnValue(vi.fn())
  // 1 USDC = 0.0005 WETH — the internal (tokenOut-per-tokenIn) orientation the panel uses.
  mockFetchCurrentPrice.mockResolvedValue(0.0005)
})

describe('LimitOrderPanel — order.priceFeed is the feed for THE CHAIN BEING SIGNED FOR', () => {
  // Base (8453) = the v3 signing path; mainnet (1) = the v2 signing path. Same expectation.
  for (const chainId of [8453, 1]) {
    it(`chain ${chainId}: signs exactly getChainlinkFeed(wrappedNative, ${chainId})`, async () => {
      await renderOn(chainId)
      fireEvent.click(sell('pick-usdc'))    // stable sell leg ⇒ the BUY leg is the feed token
      fireEvent.click(buy('pick-native'))   // buy native ETH → resolved to the chain's WETH
      await act(async () => { await Promise.resolve() })
      enterAmount('100')
      enterDisplayPrice('2000')

      await driveToSignature()

      // Read from the helper, never a literal: a hardcoded address would pass against a drifting copy.
      const expected = getChainlinkFeed(getWrappedNative(chainId), chainId)
      expect(expected).not.toBeNull()
      expect(signedPriceFeed().toLowerCase()).toBe(expected!.toLowerCase())
    })
  }

  it('H2 REGRESSION — a Base order never signs the MAINNET aggregator', async () => {
    await renderOn(8453)
    fireEvent.click(sell('pick-usdc'))
    fireEvent.click(buy('pick-native'))
    await act(async () => { await Promise.resolve() })
    enterAmount('100')
    enterDisplayPrice('2000')

    await driveToSignature()

    const mainnetEthUsd = getChainlinkFeed(getWrappedNative(1), 1)!
    const baseEthUsd = getChainlinkFeed(getWrappedNative(8453), 8453)!
    // The two chains publish ETH/USD at DIFFERENT proxy addresses — the premise of the whole finding.
    expect(baseEthUsd.toLowerCase()).not.toBe(mainnetEthUsd.toLowerCase())
    expect(signedPriceFeed().toLowerCase()).not.toBe(mainnetEthUsd.toLowerCase())
    expect(signedPriceFeed().toLowerCase()).toBe(baseEthUsd.toLowerCase())
  })
})

describe('LimitOrderPanel — selling the wrapped native directly resolves a feed on every chain', () => {
  // PR #490 added a second look-up inside findPriceFeed because the MAINNET symbol map has
  // 'ETH/USD' and no 'WETH/USD'. [NARROWED] On mainnet that fallback is kept verbatim and is the
  // mechanism here; on Base the address-keyed helper has no symbol to miss — it maps both the
  // native sentinel AND the chain's wrapped-native ADDRESS onto that chain's ETH/USD proxy. Same
  // observable result down two different paths; both are driven to signature.
  for (const chainId of [8453, 1]) {
    it(`chain ${chainId}: SELLING the wrapped native directly still resolves a feed`, async () => {
      await renderOn(chainId)
      fireEvent.click(sell('pick-weth'))   // non-stable sell leg ⇒ the SELL leg is the feed token
      fireEvent.click(buy('pick-usdc'))
      await act(async () => { await Promise.resolve() })
      enterAmount('1')
      enterDisplayPrice('2000')

      await driveToSignature()

      const expected = getChainlinkFeed(getWrappedNative(chainId), chainId)
      expect(expected).not.toBeNull()
      expect(signedPriceFeed().toLowerCase()).toBe(expected!.toLowerCase())
    })
  }

  it('the helper itself maps the native sentinel and the wrapped native to the SAME feed, per chain', () => {
    for (const chainId of [8453, 1]) {
      const viaSentinel = getChainlinkFeed(NATIVE_ETH, chainId)
      const viaWrapped = getChainlinkFeed(getWrappedNative(chainId), chainId)
      expect(viaSentinel).not.toBeNull()
      expect(viaWrapped).not.toBeNull()
      expect(viaSentinel).toBe(viaWrapped)
    }
  })
})

describe('LimitOrderPanel — a feed that does not exist fails CLOSED', () => {
  it('an UNCOVERED CHAIN refuses before any wallet call — never a sibling chain’s aggregator', async () => {
    await renderOn(UNCOVERED_CHAIN_ID)
    fireEvent.click(sell('pick-link'))   // non-stable ⇒ LINK is the feed token
    fireEvent.click(buy('pick-usdc'))
    await act(async () => { await Promise.resolve() })
    enterAmount('10')
    enterDisplayPrice('20')

    await driveToSignature()

    // The token carries its MAINNET address and mainnet HAS a LINK feed — so this asserts the
    // refusal is about the CHAIN, not about an unknown token.
    expect(getChainlinkFeed(LINK[1].address, 1)).not.toBeNull()
    expect(getChainlinkFeed(LINK[UNCOVERED_CHAIN_ID].address, UNCOVERED_CHAIN_ID)).toBeNull()

    const err = await screen.findByTestId('limit-submit-error')
    expect(err.textContent).toMatch(/No Chainlink price feed available for LINK/i)
    expectZeroWalletCalls()
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()
  })

  it('an UNCOVERED TOKEN on a covered chain (LINK on Base) refuses before any wallet call', async () => {
    await renderOn(8453)
    fireEvent.click(sell('pick-link'))
    fireEvent.click(buy('pick-usdc'))
    await act(async () => { await Promise.resolve() })
    enterAmount('10')
    enterDisplayPrice('20')

    await driveToSignature()

    expect(getChainlinkFeed(LINK[8453].address, 8453)).toBeNull()
    const err = await screen.findByTestId('limit-submit-error')
    expect(err.textContent).toMatch(/No Chainlink price feed available for LINK/i)
    expectZeroWalletCalls()
    await waitFor(() => expect(mockCreateOrderInSupabase).not.toHaveBeenCalled())
  })

  it('the refusal is never the zero address — address(0) would DISABLE the price condition', async () => {
    // TeraSwapOrderExecutorV3.sol:1105-1108 — `priceFeed == address(0)` returns (true, ""), the DCA
    // "execute unconditionally" branch. Signing it on a Limit order would strip the price condition
    // entirely and fill at any price, so "no feed" must refuse, never degrade to a zero address.
    await renderOn(8453)
    fireEvent.click(sell('pick-link'))
    fireEvent.click(buy('pick-usdc'))
    await act(async () => { await Promise.resolve() })
    enterAmount('10')
    enterDisplayPrice('20')

    await driveToSignature()

    expectZeroWalletCalls()
    const rows = mockCreateOrderInSupabase.mock.calls
    expect(rows).toHaveLength(0)
  })
})
