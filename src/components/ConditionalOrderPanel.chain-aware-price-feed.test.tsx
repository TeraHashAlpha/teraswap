// @vitest-environment jsdom
/**
 * [fix/limit-sltp-chain-aware-price-feed — Auditor H2 on merge 227a7f2] A TAKE-PROFIT order must
 * sign an `order.priceFeed` that exists ON THE CHAIN IT IS SIGNED FOR.
 *
 * Same finding, same fix, other panel — see the header of
 * LimitOrderPanel.chain-aware-price-feed.test.tsx for the full mechanism. The difference that
 * matters here: this panel feeds the SELL leg to Chainlink (`findPriceFeed(tokenIn, chainId)`),
 * where the Limit panel feeds the buy leg whenever the sell leg is a stablecoin. So the two panels
 * reach the same broken look-up down different paths and both need the same chain-aware helper.
 *
 * Every expected feed address is read from `getChainlinkFeed` at assertion time — no literals.
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
const mockGetTokenPriceUSD = vi.fn()

/** The chain under test — read by the wagmi mock AND by the TokenSelector mock's per-chain tokens. */
let CHAIN_ID = 8453

/** The Base (8453) OrderExecutorV3 — docs/DEPLOYMENTS.md, LIVE since the 2026-07-21 cutover. */
const V3_BASE = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'

/** A chain the feed registry does not cover at all — CHAINLINK_FEEDS_BY_CHAIN[10] is undefined. */
const UNCOVERED_CHAIN_ID = 10

const USDC: Record<number, { address: string; symbol: string; decimals: number }> = {
  8453: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  1: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
  [UNCOVERED_CHAIN_ID]: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
}

/**
 * LINK — its MAINNET address has a mainnet feed; its BASE address has NO entry in
 * CHAINLINK_FEEDS_BY_CHAIN[8453]. Under the old symbol-keyed look-up both resolved to the mainnet
 * LINK/USD aggregator, which is the finding.
 */
const LINK: Record<number, { address: string; symbol: string; decimals: number }> = {
  8453: { address: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196', symbol: 'LINK', decimals: 18 },
  1: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18 },
  [UNCOVERED_CHAIN_ID]: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18 },
}

vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: vi.fn().mockResolvedValue(undefined) }),
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

vi.mock('@/lib/price-monitor', () => ({
  getTokenPriceUSD: (...args: unknown[]) => mockGetTokenPriceUSD(...args),
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
    isLimitLive: (chainId: number) => chainId === 8453,
    resolveSigningExecutor: (chainId: number, isV3Order: boolean) =>
      isV3Order ? (chainId === 8453 ? V3_BASE : null) : actual.getOrderExecutor(chainId),
    // [ADR-020] The router gate fires BEFORE the feed gate and would refuse chain 10 for an
    // unrelated reason. Lending the uncovered chain a router isolates the FEED gate as the thing
    // under test; chains 1 and 8453 keep their real routers.
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
import ConditionalOrderPanel from './ConditionalOrderPanel'
import { getWrappedNative } from '@/lib/chains/registry'
import { getChainlinkFeed } from '@/lib/chains/chainlink-feeds'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)

/**
 * The chain's wrapped native as an ordinary catalog token. A hoisted function declaration so the
 * TokenSelector mock factory can reference it; only CALLED on click, long after module init. The
 * address comes from the registry, never a literal.
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

/** The amount box is the first '0.00' placeholder; the trigger-price box is the second. */
const enterAmount = (v: string) =>
  fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: v } })

async function driveToSignature() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Set Take Profit at/i })) })
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
  renderWithProviders(<ConditionalOrderPanel />)
  await act(async () => { await Promise.resolve() })
}

/** Pick the pair, then let the USD-price effect settle so the trigger price is auto-filled. */
async function pickPair(sellTestId: string, buyTestId: string) {
  fireEvent.click(sell(sellTestId))
  fireEvent.click(buy(buyTestId))
  await act(async () => { await Promise.resolve() })
  await waitFor(() => expect(screen.getAllByPlaceholderText('0.00')[1]).toHaveValue(24))
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
  // $20 sell leg → the panel's DEFAULT_TP_FACTOR (1.2) auto-fills the trigger at 24.00.
  mockGetTokenPriceUSD.mockResolvedValue(20)
})

describe('ConditionalOrderPanel — order.priceFeed is the feed for THE CHAIN BEING SIGNED FOR', () => {
  // Base (8453) = the v3 signing path; mainnet (1) = the v2 signing path. Same expectation.
  // Selling the WRAPPED NATIVE directly is also exactly the case PR #490's fallback existed for,
  // so these two tests double as the proof that deleting it loses nothing.
  for (const chainId of [8453, 1]) {
    it(`chain ${chainId}: selling the wrapped native signs getChainlinkFeed(WETH, ${chainId})`, async () => {
      await renderOn(chainId)
      await pickPair('pick-weth', 'pick-usdc')
      enterAmount('10')

      await driveToSignature()

      const expected = getChainlinkFeed(getWrappedNative(chainId), chainId)
      expect(expected).not.toBeNull()
      expect(signedPriceFeed().toLowerCase()).toBe(expected!.toLowerCase())
    })
  }

  it('H2 REGRESSION — a Base order never signs the MAINNET aggregator', async () => {
    await renderOn(8453)
    await pickPair('pick-weth', 'pick-usdc')
    enterAmount('10')

    await driveToSignature()

    const mainnetEthUsd = getChainlinkFeed(getWrappedNative(1), 1)!
    const baseEthUsd = getChainlinkFeed(getWrappedNative(8453), 8453)!
    expect(baseEthUsd.toLowerCase()).not.toBe(mainnetEthUsd.toLowerCase())
    expect(signedPriceFeed().toLowerCase()).not.toBe(mainnetEthUsd.toLowerCase())
    expect(signedPriceFeed().toLowerCase()).toBe(baseEthUsd.toLowerCase())
  })
})

describe('ConditionalOrderPanel — a feed that does not exist fails CLOSED', () => {
  it('an UNCOVERED CHAIN refuses before any wallet call — never a sibling chain’s aggregator', async () => {
    await renderOn(UNCOVERED_CHAIN_ID)
    await pickPair('pick-link', 'pick-usdc')
    enterAmount('10')

    await driveToSignature()

    // The token carries its MAINNET address and mainnet HAS a LINK feed — so the refusal is about
    // the CHAIN, not about an unknown token.
    expect(getChainlinkFeed(LINK[1].address, 1)).not.toBeNull()
    expect(getChainlinkFeed(LINK[UNCOVERED_CHAIN_ID].address, UNCOVERED_CHAIN_ID)).toBeNull()

    const err = await screen.findByTestId('conditional-submit-error')
    expect(err.textContent).toMatch(/No Chainlink price feed available for LINK/i)
    expectZeroWalletCalls()
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()
  })

  it('an UNCOVERED TOKEN on a covered chain (LINK on Base) refuses before any wallet call', async () => {
    await renderOn(8453)
    await pickPair('pick-link', 'pick-usdc')
    enterAmount('10')

    await driveToSignature()

    expect(getChainlinkFeed(LINK[8453].address, 8453)).toBeNull()
    const err = await screen.findByTestId('conditional-submit-error')
    expect(err.textContent).toMatch(/No Chainlink price feed available for LINK/i)
    expectZeroWalletCalls()
    await waitFor(() => expect(mockCreateOrderInSupabase).not.toHaveBeenCalled())
  })

  it('the refusal is never the zero address — address(0) would DISABLE the price condition', async () => {
    // TeraSwapOrderExecutorV3.sol:1105-1108 — `priceFeed == address(0)` returns (true, ""), the DCA
    // "execute unconditionally" branch. Signing it on a conditional order would strip the trigger
    // entirely, so "no feed" must refuse rather than degrade to a zero address.
    await renderOn(8453)
    await pickPair('pick-link', 'pick-usdc')
    enterAmount('10')

    await driveToSignature()

    expectZeroWalletCalls()
    expect(mockCreateOrderInSupabase.mock.calls).toHaveLength(0)
  })
})
