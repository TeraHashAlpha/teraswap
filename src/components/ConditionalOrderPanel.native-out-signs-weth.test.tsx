// @vitest-environment jsdom
/**
 * [fix/native-out-signs-weth-limit-sltp] A TAKE-PROFIT (Stop-Loss / Take-Profit panel) order whose
 * OUTPUT is native ETH must sign the chain's WRAPPED native as `order.tokenOut` — and must say so
 * on screen before the signature is requested.
 *
 * WHY — the identical defect the merged DCA fix removed (PR #488), which its author flagged at
 * ConditionalOrderPanel.tsx:331 as out of scope there. Verified against origin/main before this
 * change: line 331 is the `tokenOut:` field of the CreateOrderConfig literal, built straight from
 * the raw selector pick, and `useOrderEngine.createOrder` (hooks/useOrderEngine.ts:695-697)
 * resolves the native sentinel for tokenIn ONLY — `order.tokenOut` is assigned
 * `config.tokenOut.address` verbatim. So the sentinel reached the signed struct.
 *
 *  1. The native sentinel has NO CODE: eth_getCode(0xEeee…EEeE) -> "0x" on Base AND mainnet, so
 *     `IERC20(order.tokenOut).balanceOf(address(this))` — TeraSwapOrderExecutorV3.sol:567 (the
 *     pre-swap snapshot) and :579 (the post-swap delta), both UNCONDITIONAL and both ahead of every
 *     delivery branch — reverts on Solidity's extcodesize guard. Every fill reverts.
 *  2. The contract's "router returned native ETH -> forward ETH to the owner" branch (V3:593) is
 *     keyed on `order.tokenOut == WETH`, so signing the WRAPPED address is what BUYS the user
 *     native-ETH delivery.
 *
 * The two chain ids exercise DIFFERENT signing paths on purpose — Base (8453) is v3, mainnet (1)
 * is v2 — so the resolution is proved to sit BEFORE the v2/v3 fork rather than inside either
 * branch. Every expected address is read from `getWrappedNative(chainId)` at assertion time; there
 * is not one address literal in an assertion in this file.
 *
 * The SELL leg is LINK: this panel always feeds the SELL leg to Chainlink
 * (`findPriceFeed(tokenIn, chainId)`), and LINK/USD is in the feed map, so the flow reaches the
 * signature on the pair's own merits rather than on a feed technicality.
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

/** The SELL leg — non-stable, and LINK/USD is a real entry in the Chainlink feed map. */
const LINK: Record<number, { address: string; symbol: string; decimals: number }> = {
  8453: { address: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196', symbol: 'LINK', decimals: 18 },
  1: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18 },
}
/** The negative control's BUY leg. */
const USDC: Record<number, { address: string; symbol: string; decimals: number }> = {
  8453: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  1: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
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
// second, so `sell()`/`buy()` below index them. `selected?.symbol` is the selector's OWN label.
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
        data-testid="pick-link"
        onClick={() => onSelect({ ...LINK[CHAIN_ID], name: 'Chainlink', logoURI: '', category: 'DeFi', chainId: CHAIN_ID })}
      >pick-link</button>
      <button
        data-testid="pick-usdc"
        onClick={() => onSelect({ ...USDC[CHAIN_ID], name: 'USD Coin', logoURI: '', category: 'Stablecoin', chainId: CHAIN_ID })}
      >pick-usdc</button>
    </div>
  ),
}))

import { renderWithProviders, screen, fireEvent, waitFor, act } from '@/test-utils/render'
import ConditionalOrderPanel from './ConditionalOrderPanel'
import { getWrappedNative } from '@/lib/chains/registry'
import { NATIVE_ETH } from '@/lib/constants'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)

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
  renderWithProviders(<ConditionalOrderPanel />)
  await act(async () => { await Promise.resolve() })
}

/** Pick the pair, then let the USD-price effect settle so the trigger price is auto-filled. */
async function pickPair(buyTestId: string) {
  fireEvent.click(sell('pick-link'))
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
  // $20 LINK -> the panel's DEFAULT_TP_FACTOR (1.2) auto-fills the trigger at 24.00.
  mockGetTokenPriceUSD.mockResolvedValue(20)
})

describe('ConditionalOrderPanel — a native-ETH output is SIGNED as the chain\'s wrapped native', () => {
  // Base (8453) = the v3 signing path; mainnet (1) = the v2 signing path. Same expectation.
  for (const chainId of [8453, 1]) {
    it(`chain ${chainId}: order.tokenOut === getWrappedNative(${chainId}), never the sentinel`, async () => {
      await renderOn(chainId)
      await pickPair('pick-native')
      enterAmount('10')

      await driveToSignature()

      const wrapped = getWrappedNative(chainId)
      expect(signedTokenOut().toLowerCase()).toBe(wrapped.toLowerCase())
      expect(signedTokenOut().toLowerCase()).not.toBe(NATIVE_ETH.toLowerCase())
    })

    it(`chain ${chainId}: the persisted row's tokenOut is the SAME address that was signed`, async () => {
      await renderOn(chainId)
      await pickPair('pick-native')
      enterAmount('10')

      await driveToSignature()

      await waitFor(() => expect(mockCreateOrderInSupabase).toHaveBeenCalledTimes(1))
      const row = mockCreateOrderInSupabase.mock.calls[0][0] as { tokenOut: string }
      // The orderHash binds order.tokenOut; a row disagreeing with it is unexecutable bookkeeping.
      expect(row.tokenOut.toLowerCase()).toBe(signedTokenOut().toLowerCase())
      expect(row.tokenOut.toLowerCase()).toBe(getWrappedNative(chainId).toLowerCase())
    })
  }

  // Guards the premise of the loop above: if both chains silently collapsed onto one path, the
  // "before the v2/v3 fork" claim would be untested.
  for (const [chainId, version] of [[8453, '3'], [1, '2']] as const) {
    it(`chain ${chainId} signs through the v${version} path`, async () => {
      await renderOn(chainId)
      await pickPair('pick-native')
      enterAmount('10')
      await driveToSignature()
      expect(signedDomainVersion()).toBe(version)
    })
  }

  it('NEGATIVE CONTROL — a non-native tokenOut is passed through completely untouched', async () => {
    await renderOn(8453)
    await pickPair('pick-usdc')
    enterAmount('10')

    await driveToSignature()

    expect(signedTokenOut().toLowerCase()).toBe(USDC[8453].address.toLowerCase())
    // and specifically NOT rewritten to the wrapped native by an over-broad resolution
    expect(signedTokenOut().toLowerCase()).not.toBe(getWrappedNative(8453).toLowerCase())
  })
})

describe('ConditionalOrderPanel — the screen matches the signature', () => {
  it('the BUY selector reads WETH (not ETH) once native output is chosen', async () => {
    await renderOn(8453)
    fireEvent.click(sell('pick-link'))
    fireEvent.click(buy('pick-native'))

    // The selector's own label — not the surrounding markup — so this cannot pass on stray text.
    expect(screen.getAllByTestId('symbol')[1].textContent).toBe('WETH')
    // ...and the SELL selector is untouched by the buy-leg resolution.
    expect(screen.getAllByTestId('symbol')[0].textContent).toBe('LINK')
  })

  it('the review modal names the pair the user is about to SIGN — LINK → WETH', async () => {
    // Driven on the v2 path (chain 1) deliberately: there the modal mounts even with the OLD
    // behaviour, so this fails on the COPY ("LINK → ETH") rather than on the modal being absent.
    await renderOn(1)
    await pickPair('pick-native')
    enterAmount('10')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Set Take Profit at/i })) })

    const pair = await screen.findByTestId('order-pair')
    expect(pair.textContent).toBe('LINK → WETH')
    // The min-received line names the buy token too — it must not say ETH over a WETH struct.
    expect(screen.getByTestId('order-minout').textContent).toMatch(/WETH$/)
  })
})
