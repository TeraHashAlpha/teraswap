// @vitest-environment jsdom
/**
 * [fix/native-out-signs-weth-limit-sltp] A LIMIT order whose OUTPUT is native ETH must sign the
 * chain's WRAPPED native as `order.tokenOut` — and must say so on screen before the signature is
 * requested.
 *
 * WHY — the identical defect the merged DCA fix removed (PR #488), which its author flagged at
 * LimitOrderPanel.tsx:423 as out of scope there. Verified against origin/main before this change:
 * line 423 is the `tokenOut:` field of the CreateOrderConfig literal, built straight from the raw
 * selector pick, and `useOrderEngine.createOrder` (hooks/useOrderEngine.ts:695-697) resolves the
 * native sentinel for tokenIn ONLY — `order.tokenOut` is assigned `config.tokenOut.address`
 * verbatim. So the sentinel reached the signed struct.
 *
 *  1. The native sentinel has NO CODE: eth_getCode(0xEeee…EEeE) -> "0x" on Base AND mainnet, so
 *     `IERC20(order.tokenOut).balanceOf(address(this))` — TeraSwapOrderExecutorV3.sol:567 (the
 *     pre-swap snapshot) and :579 (the post-swap delta), both UNCONDITIONAL and both ahead of every
 *     delivery branch — reverts on Solidity's extcodesize guard. Every fill reverts.
 *  2. The executor's fair-value registry has no entry for the sentinel, while the wrapped native
 *     IS registered.
 *  3. The contract's "router returned native ETH -> forward ETH to the owner" branch (V3:593) is
 *     keyed on `order.tokenOut == WETH`. Signing the WRAPPED address is what BUYS the user
 *     native-ETH delivery; signing the sentinel forfeits it and reverts first regardless.
 *
 * The two chain ids exercise DIFFERENT signing paths on purpose — Base (8453) is v3 (pinned
 * canonical route + maxSlippageBps => the v3 EIP-712 domain and types), mainnet (1) is v2 (no
 * maxSlippageBps => the v2 domain) — so the resolution is proved to sit BEFORE the v2/v3 fork
 * rather than inside either branch. Every expected address is read from `getWrappedNative(chainId)`
 * at assertion time; there is not one address literal in an assertion in this file.
 *
 * The SELL leg is a stablecoin on purpose: this panel makes the BUY leg the Chainlink feed token
 * whenever the sell leg is a stablecoin (`feedToken = sellIsStable ? tokenOut : tokenIn`), so this
 * is also the path that proves the resolved WETH still resolves a feed.
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

/** The SPEND leg: a stablecoin, so the BUY leg is what the Chainlink feed lookup is handed. */
const USDC: Record<number, { address: string; symbol: string; decimals: number }> = {
  8453: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  1: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
}
/** A non-stable spend leg with its own Chainlink feed — used by the negative control. */
const LINK: Record<number, { address: string; symbol: string; decimals: number }> = {
  8453: { address: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196', symbol: 'LINK', decimals: 18 },
  1: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18 },
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
    // v3 on Base only — the real eligibility list (ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS = [8453]).
    // Mainnet therefore takes the v2 branch here exactly as it does in production.
    getOrderExecutorV3: (chainId: number) => (chainId === 8453 ? V3_BASE : null),
    getOrderExecutorV3Domain: (chainId: number) => {
      if (chainId !== 8453) throw new Error(`No OrderExecutorV3 deployed on chain ${chainId}`)
      return { name: 'TeraSwapOrderExecutor' as const, version: '3' as const, chainId, verifyingContract: V3_BASE }
    },
    // The real gate additionally requires NEXT_PUBLIC_LIMIT_ENABLED === 'true', which no test
    // process sets. Stubbing ONLY the flag half keeps the chain half honest: Base is v3, mainnet
    // stays v2, which is exactly the fork these two chain ids exist to straddle.
    isLimitLive: (chainId: number) => chainId === 8453,
    resolveSigningExecutor: (chainId: number, isV3Order: boolean) =>
      isV3Order ? (chainId === 8453 ? V3_BASE : null) : actual.getOrderExecutor(chainId),
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
// OrderReviewModal is deliberately NOT mocked — it is the pre-signature screen Task 3 is about.

// Both selectors render the same controls; the SELL selector is first in the DOM, the BUY selector
// second, so `sell()`/`buy()` below index them. `selected?.symbol` is the selector's OWN label —
// asserting on it means the copy test cannot pass on stray text elsewhere in the panel.
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
      <button
        data-testid="pick-usdc"
        onClick={() => onSelect({ ...USDC[CHAIN_ID], name: 'USD Coin', logoURI: '', category: 'Stablecoin', chainId: CHAIN_ID })}
      >pick-usdc</button>
      <button
        data-testid="pick-link"
        onClick={() => onSelect({ ...LINK[CHAIN_ID], name: 'Chainlink', logoURI: '', category: 'DeFi', chainId: CHAIN_ID })}
      >pick-link</button>
      {/* [fix/limit-sltp-chain-aware-price-feed] The chain's wrapped native, picked directly —
          the negative control's Base sell leg, see the note on that test. */}
      <button
        data-testid="pick-weth"
        onClick={() => onSelect({
          address: getWrappedNative(CHAIN_ID), symbol: 'WETH', name: 'Wrapped Ether',
          decimals: 18, logoURI: '', category: 'Native', chainId: CHAIN_ID,
        })}
      >pick-weth</button>
    </div>
  ),
}))

import { renderWithProviders, screen, fireEvent, waitFor, act } from '@/test-utils/render'
import LimitOrderPanel from './LimitOrderPanel'
import { getWrappedNative } from '@/lib/chains/registry'
import { NATIVE_ETH } from '@/lib/constants'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)

/** Sell selector = first in the DOM; buy selector = second. */
const sell = (testId: string) => screen.getAllByTestId(testId)[0]
const buy = (testId: string) => screen.getAllByTestId(testId)[1]

const enterAmount = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: v } })

/**
 * The panel shows the INVERTED price when a stablecoin is sold for a non-stable, so "2000" is what
 * a user types for "1 WETH = 2000 USDC". The internal target (0.0005) is derived from it.
 */
const enterDisplayPrice = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: v } })

/** Walk the create flow to the signature, clicking every control the UI actually offers. */
async function driveToSignature() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Place Limit Order/i })) })
  const approve = screen.queryByTestId('order-approve')
  if (approve) await act(async () => { fireEvent.click(approve) })
  const confirm = screen.queryByTestId('order-confirm')
  if (confirm) await act(async () => { fireEvent.click(confirm) })
}

/** The `tokenOut` of the EIP-712 message actually handed to the wallet. */
function signedTokenOut(): string {
  expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1)
  const arg = mockSignTypedDataAsync.mock.calls[0][0] as { message: { tokenOut: string } }
  return arg.message.tokenOut
}

/** '3' on the v3 path, '2' on the v2 path — proves the two chain ids really do fork. */
function signedDomainVersion(): string {
  const arg = mockSignTypedDataAsync.mock.calls[0][0] as { domain: { version: string } }
  return arg.domain.version
}

async function renderOn(chainId: number) {
  CHAIN_ID = chainId
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: chainId } })
  renderWithProviders(<LimitOrderPanel />)
  // Flush the market-price effect so the target-price field is not overwritten mid-flow.
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

describe('LimitOrderPanel — a native-ETH output is SIGNED as the chain\'s wrapped native', () => {
  // Base (8453) = the v3 signing path; mainnet (1) = the v2 signing path. Same expectation.
  for (const chainId of [8453, 1]) {
    it(`chain ${chainId}: order.tokenOut === getWrappedNative(${chainId}), never the sentinel`, async () => {
      await renderOn(chainId)
      fireEvent.click(sell('pick-usdc'))    // sell USDC
      fireEvent.click(buy('pick-native'))   // buy native ETH
      await act(async () => { await Promise.resolve() })
      enterAmount('100')
      enterDisplayPrice('2000')

      await driveToSignature()

      const wrapped = getWrappedNative(chainId)
      expect(signedTokenOut().toLowerCase()).toBe(wrapped.toLowerCase())
      expect(signedTokenOut().toLowerCase()).not.toBe(NATIVE_ETH.toLowerCase())
    })

    it(`chain ${chainId}: the persisted row's tokenOut is the SAME address that was signed`, async () => {
      await renderOn(chainId)
      fireEvent.click(sell('pick-usdc'))
      fireEvent.click(buy('pick-native'))
      await act(async () => { await Promise.resolve() })
      enterAmount('100')
      enterDisplayPrice('2000')

      await driveToSignature()

      await waitFor(() => expect(mockCreateOrderInSupabase).toHaveBeenCalledTimes(1))
      const row = mockCreateOrderInSupabase.mock.calls[0][0] as { tokenOut: string }
      // The orderHash binds order.tokenOut; a row disagreeing with it is unexecutable bookkeeping.
      expect(row.tokenOut.toLowerCase()).toBe(signedTokenOut().toLowerCase())
      expect(row.tokenOut.toLowerCase()).toBe(getWrappedNative(chainId).toLowerCase())
    })
  }

  // Guards the premise of the loop above: if both chains silently collapsed onto one path, the
  // "before the v2/v3 fork" claim would be untested. '3'/'2' is the EIP-712 DOMAIN VERSION the
  // wallet was actually handed.
  for (const [chainId, version] of [[8453, '3'], [1, '2']] as const) {
    it(`chain ${chainId} signs through the v${version} path`, async () => {
      await renderOn(chainId)
      fireEvent.click(sell('pick-usdc'))
      fireEvent.click(buy('pick-native'))
      await act(async () => { await Promise.resolve() })
      enterAmount('100')
      enterDisplayPrice('2000')
      await driveToSignature()
      expect(signedDomainVersion()).toBe(version)
    })
  }

  // [fix/limit-sltp-chain-aware-price-feed — Auditor H2] The sell leg was LINK, and Base has NO
  // LINK entry in CHAINLINK_FEEDS_BY_CHAIN[8453]. This test reached a signature at all only
  // because the old symbol-keyed findPriceFeed answered with the MAINNET LINK aggregator — i.e.
  // it was silently exercising the defect. WETH is the non-stable Base sell leg that genuinely
  // has a Base feed; the assertions (tokenOut passed through, never rewritten to the wrapped
  // native) are unchanged and still the point of the test.
  it('NEGATIVE CONTROL — a non-native tokenOut is passed through completely untouched', async () => {
    await renderOn(8453)
    fireEvent.click(sell('pick-weth'))   // non-stable sell leg => the feed token is the SELL leg
    fireEvent.click(buy('pick-usdc'))    // buy USDC
    await act(async () => { await Promise.resolve() })
    enterAmount('100')
    enterDisplayPrice('20')

    await driveToSignature()

    expect(signedTokenOut().toLowerCase()).toBe(USDC[8453].address.toLowerCase())
    // and specifically NOT rewritten to the wrapped native by an over-broad resolution
    expect(signedTokenOut().toLowerCase()).not.toBe(getWrappedNative(8453).toLowerCase())
  })
})

describe('LimitOrderPanel — the screen matches the signature', () => {
  it('the BUY selector reads WETH (not ETH) once native output is chosen', async () => {
    await renderOn(8453)
    fireEvent.click(sell('pick-link'))
    fireEvent.click(buy('pick-native'))

    // The selector's own label — not the surrounding markup — so this cannot pass on stray text.
    expect(screen.getAllByTestId('symbol')[1].textContent).toBe('WETH')
    // ...and the SELL selector is untouched by the buy-leg resolution.
    expect(screen.getAllByTestId('symbol')[0].textContent).toBe('LINK')
  })

  it('the review modal names the pair the user is about to SIGN — USDC → WETH', async () => {
    // Driven on the v2 path (chain 1) deliberately: there the modal mounts even with the OLD
    // behaviour, so this fails on the COPY ("USDC → ETH") rather than on the modal being absent —
    // which is the thing being pinned. The struct itself is pinned on both chains above.
    await renderOn(1)
    fireEvent.click(sell('pick-usdc'))
    fireEvent.click(buy('pick-native'))
    await act(async () => { await Promise.resolve() })
    enterAmount('100')
    enterDisplayPrice('2000')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Place Limit Order/i })) })

    const pair = await screen.findByTestId('order-pair')
    expect(pair.textContent).toBe('USDC → WETH')
    // The min-received line names the buy token too — it must not say ETH over a WETH struct.
    expect(screen.getByTestId('order-minout').textContent).toMatch(/WETH$/)
  })
})
