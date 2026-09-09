// @vitest-environment jsdom
/**
 * [fix/dca-native-out-signs-weth] A DCA whose OUTPUT is native ETH must sign the chain's WRAPPED
 * native as `order.tokenOut` — and must say so on screen before the signature is requested.
 *
 * WHY, re-derived on-chain 2026-09-09 (never trusted from the prompt):
 *
 *  1. The native sentinel has NO CODE.
 *       eth_getCode(0xEeee…EEeE) → "0x"   on Base (8453) AND Ethereum mainnet (1)
 *     So `IERC20(order.tokenOut).balanceOf(address(this))` — TeraSwapOrderExecutorV3.sol:567 (the
 *     pre-swap snapshot) and :579 (the post-swap delta), both UNCONDITIONAL, both before any
 *     delivery branch — reverts on Solidity's extcodesize guard with empty revert data. Proven, not
 *     assumed: a throwaway Foundry harness calling that exact expression against a codeless address
 *     reverts, while the identical call against a real ERC-20 returns.
 *
 *  2. The sentinel is not in the executor's fair-value registry either.
 *       cast call 0x686b4f812291F4De238E59ED00BA6dD6129e60a0 \
 *         "tokenUsdFeeds(address)(address,uint8,uint8,uint256,bool)" 0xEeee…EEeE  --rpc-url base
 *       → (0x0000…0000, 0, 0, 0, false)          # unregistered
 *     while the chain's WRAPPED native IS registered:
 *       … 0x4200000000000000000000000000000000000006
 *       → (0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70, 8, 18, 3600, true)
 *
 *  3. The contract's own unwrap branch is keyed on the WRAPPED address, never the sentinel:
 *       V3:593  `else if (order.tokenOut == WETH && ethReceived >= floorOut)`
 *       cast call 0x686b…60a0 "WETH()(address)" → 0x4200000000000000000000000000000000000006
 *     i.e. signing WETH is what BUYS the user the native-ETH delivery path; signing the sentinel
 *     forfeits it and reverts first anyway.
 *
 * So a DCA buying native ETH has never been executable. These tests pin the fix at the two places
 * that matter and nowhere else: the SIGNED struct, and the copy the user reads before signing.
 *
 * Both chain ids exercise a DIFFERENT signing path on purpose — Base (8453) is v3 (oracle floor,
 * executor feed gate armed), mainnet (1) is v2 (minAmountOut '1', gate inert) — so the resolution
 * is proved to sit BEFORE the v2/v3 fork rather than inside either branch. Every expected address
 * is read from `getWrappedNative(chainId)` at assertion time; there is not one address literal in
 * an assertion in this file.
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
const mockCheckOracleCoverage = vi.fn()
const mockFetchDefiLlamaPrice = vi.fn()

/** The chain under test — read by the wagmi mock AND by the TokenSelector mock's per-chain tokens. */
let CHAIN_ID = 8453

/** The Base (8453) OrderExecutorV3 — docs/DEPLOYMENTS.md, LIVE since the 2026-07-21 cutover. */
const V3_BASE = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'

/** Per-chain USDC — the SPEND leg (v3 registry-registered on Base) and the negative-control BUY. */
const USDC: Record<number, { address: string; symbol: string; decimals: number }> = {
  8453: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  1: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
}

/**
 * `tokenUsdFeeds(address)` as it really answers on Base, read 2026-09-09 (see docblock §2).
 * Tuple order is the contract's: feed, feedDecimals, tokenDecimals, maxStaleness, registered.
 * Absent keys get the genuine on-chain answer for an unregistered token: the zero struct — which
 * is EXACTLY what the native sentinel answers, so this stub cannot flatter the fix.
 */
const BASE_TOKEN_USD_FEEDS: Record<string, readonly [string, number, number, bigint, boolean]> = {
  '0x4200000000000000000000000000000000000006': [
    '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 8, 18, 3600n, true,
  ],
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': [
    '0x458138Fc0D67027E9A6778ef40a6ffC318c69061', 8, 6, 90000n, true,
  ],
}
const UNREGISTERED = ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false] as const

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

vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: () => ({
    readContract: async (args: { args: readonly unknown[] }) =>
      BASE_TOKEN_USD_FEEDS[String(args.args[0]).toLowerCase()] ?? UNREGISTERED,
  }),
  _clearClientCache: vi.fn(),
}))

vi.mock('@/hooks/useChainlinkPrice', () => ({
  useChainlinkPrice: () => ({
    chainlinkPrice: 2000, executionPrice: null, deviation: 0, level: 'none',
    message: null, oracleUnavailable: false,
  }),
}))
vi.mock('@/hooks/useDepegCheck', () => ({
  useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }),
}))
vi.mock('@/hooks/useTokenBalances', () => ({
  useTokenBalances: () => ({ balances: new Map(), isLoading: false, isError: false }),
}))
vi.mock('@/hooks/useTokenBalance', () => ({
  useTokenBalance: () => ({ raw: 10_000n * 10n ** 18n, hasValue: true, formatted: '10000', isLoading: false, isError: false }),
}))
vi.mock('@/lib/order-engine/check-oracle', () => ({
  checkOracleCoverage: (...args: unknown[]) => mockCheckOracleCoverage(...args),
}))
vi.mock('@/lib/defillama', () => ({
  fetchDefiLlamaPrice: (...args: unknown[]) => mockFetchDefiLlamaPrice(...args),
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
    // Mirrors the real branch (config.ts:152) over THIS file's v3 map, so the real approve button
    // renders on both chains and neither case can pass by the modal simply not existing.
    resolveSigningExecutor: (chainId: number, isV3Order: boolean) =>
      isV3Order ? (chainId === 8453 ? V3_BASE : null) : actual.getOrderExecutor(chainId),
  }
})

vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => <button>Connect</button> }))
vi.mock('@/lib/sounds', () => ({
  playClick: vi.fn(), playTouchMP3: vi.fn(), playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(), startWaitingSound: vi.fn(), stopWaitingSound: vi.fn(),
}))
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: vi.fn() }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: vi.fn() }))
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div /> }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))
// OrderReviewModal is deliberately NOT mocked — it is the pre-signature screen Task 2 is about.

vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected, onSelect, hideNativeInput }: {
    selected: { symbol?: string } | null
    onSelect: (t: unknown) => void
    hideNativeInput?: boolean
  }) => (
    <div data-testid={hideNativeInput ? 'token-selector-in' : 'token-selector-out'}>
      <span data-testid={hideNativeInput ? 'symbol-in' : 'symbol-out'}>{selected?.symbol ?? 'Select'}</span>
      {hideNativeInput ? (
        <button
          data-testid="pick-usdc-in"
          onClick={() => onSelect({ ...USDC[CHAIN_ID], name: 'USD Coin', logoURI: '', category: 'Stablecoin', chainId: CHAIN_ID })}
        >pick-usdc-in</button>
      ) : (
        <>
          <button
            data-testid="pick-native-out"
            onClick={() => onSelect({
              address: NATIVE_ETH, symbol: 'ETH', name: 'Ether', decimals: 18,
              logoURI: '', category: 'Native',
            })}
          >pick-native-out</button>
          <button
            data-testid="pick-usdc-out"
            onClick={() => onSelect({ ...USDC[CHAIN_ID], name: 'USD Coin', logoURI: '', category: 'Stablecoin', chainId: CHAIN_ID })}
          >pick-usdc-out</button>
        </>
      )}
    </div>
  ),
}))

import { renderWithProviders, screen, fireEvent, waitFor, act } from '@/test-utils/render'
import DCAPanel from './DCAPanel'
import { getWrappedNative } from '@/lib/chains/registry'
import { NATIVE_ETH } from '@/lib/constants'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)

const enterAmount = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: v } })

/** Walk the create flow to the signature, clicking every control the UI actually offers. */
async function driveToSignature() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start DCA/i })) })
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
  mockCheckOracleCoverage.mockResolvedValue({ hasOracle: true })
  mockFetchDefiLlamaPrice.mockResolvedValue(null)
})

describe('DCAPanel — a native-ETH output is SIGNED as the chain\'s wrapped native', () => {
  // Base (8453) = the v3 signing path; mainnet (1) = the v2 signing path. Same expectation.
  for (const chainId of [8453, 1]) {
    it(`chain ${chainId}: order.tokenOut === getWrappedNative(${chainId}), never the sentinel`, async () => {
      CHAIN_ID = chainId
      useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: chainId } })

      renderWithProviders(<DCAPanel />)
      fireEvent.click(screen.getByTestId('pick-usdc-in'))    // spend USDC
      fireEvent.click(screen.getByTestId('pick-native-out')) // buy native ETH
      enterAmount('100')

      await driveToSignature()

      const wrapped = getWrappedNative(chainId)
      expect(signedTokenOut().toLowerCase()).toBe(wrapped.toLowerCase())
      expect(signedTokenOut().toLowerCase()).not.toBe(NATIVE_ETH.toLowerCase())
    })

    it(`chain ${chainId}: the persisted row's tokenOut is the SAME address that was signed`, async () => {
      CHAIN_ID = chainId
      useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: chainId } })

      renderWithProviders(<DCAPanel />)
      fireEvent.click(screen.getByTestId('pick-usdc-in'))
      fireEvent.click(screen.getByTestId('pick-native-out'))
      enterAmount('100')

      await driveToSignature()

      await waitFor(() => expect(mockCreateOrderInSupabase).toHaveBeenCalledTimes(1))
      const row = mockCreateOrderInSupabase.mock.calls[0][0] as { tokenOut: string }
      // The orderHash binds order.tokenOut; a row disagreeing with it is unexecutable bookkeeping.
      expect(row.tokenOut.toLowerCase()).toBe(signedTokenOut().toLowerCase())
      expect(row.tokenOut.toLowerCase()).toBe(getWrappedNative(chainId).toLowerCase())
    })
  }

  it('NEGATIVE CONTROL — a non-native tokenOut is passed through completely untouched', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-usdc-out')) // buy USDC; spend stays the default WETH
    enterAmount('100')

    await driveToSignature()

    expect(signedTokenOut().toLowerCase()).toBe(USDC[8453].address.toLowerCase())
    // and specifically NOT rewritten to the wrapped native by an over-broad resolution
    expect(signedTokenOut().toLowerCase()).not.toBe(getWrappedNative(8453).toLowerCase())
  })
})

describe('DCAPanel — the screen matches the signature', () => {
  it('the BUY selector reads WETH (not ETH) once native output is chosen', () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-native-out'))

    // The selector's own label — not the surrounding markup — so this cannot pass on stray text.
    expect(screen.getByTestId('symbol-out').textContent).toBe('WETH')
  })

  it('the review modal names the pair the user is about to SIGN — USDC → WETH', async () => {
    // Driven on the v2 path (chain 1) deliberately: there the modal mounts even with the OLD
    // behaviour, so this fails on the COPY ("USDC → ETH") rather than on the modal being absent —
    // which is the thing being pinned. The struct itself is pinned on both chains above.
    CHAIN_ID = 1
    useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: 1 } })
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-usdc-in'))
    fireEvent.click(screen.getByTestId('pick-native-out'))
    enterAmount('100')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start DCA/i })) })

    const pair = await screen.findByTestId('order-pair')
    expect(pair.textContent).toBe('USDC → WETH')
    // The min-received line names the buy token too — it must not say ETH over a WETH struct.
    expect(screen.getByTestId('order-minout').textContent).toMatch(/WETH$/)
  })
})
