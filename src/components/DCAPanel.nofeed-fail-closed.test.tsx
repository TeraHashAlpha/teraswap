// @vitest-environment jsdom
/**
 * [FIX-DCA-NOFEED-FAIL-CLOSED] DCAPanel — a DCA leg the EXECUTOR cannot price is refused before any
 * wallet interaction.
 *
 * Measured on Base 2026-09-09: a DCA WETH→ETHFI reached an on-chain approval AND an EIP-712
 * signature before anything refused it. The authoritative USD check lives server-side in
 * `api/orders/route.ts`, inside the POST handler — strictly AFTER OrderReviewModal's approve tx and
 * `useOrderEngine`'s `signTypedDataAsync`. And the on-chain protection the user was told to rely on
 * was not there either: `_fairValueOut` needs the EXECUTOR's own registered feeds
 * (TeraSwapOrderExecutorV3.sol:1046/1076), so an unregistered leg yields `hasFeed=false` and
 * `floorOut = scaledMin` (V3:540-554) — for an unpriceable output that is the ADR-013 dust fallback
 * (v3-min-derivation.ts:247-249), i.e. no meaningful floor at all.
 *
 * These are BEHAVIOUR tests, not copy tests. The load-bearing assertions are that the approval
 * writer and the typed-data signer were never invoked; the block text is checked only to prove the
 * user is told WHICH leg is the problem.
 *
 * The executor registry is NOT stubbed at the decision level: `readExecutorFeedCoverage` runs for
 * real against a fake `readContract` that replays the tuple shape and the REAL values read from
 * Base mainnet on 2026-09-09 (see BASE_TOKEN_USD_FEEDS below). So a change to the decode, the
 * fail-closed posture, or the queried function name fails here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSignTypedDataAsync = vi.fn<(args: unknown) => Promise<string>>()
/** The approval transaction sender — `useOrderApproval.approve` calls exactly this. */
const mockWriteContractAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockRefetchNonce = vi.fn<() => Promise<unknown>>()
const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 8453)

const mockCreateOrderInSupabase = vi.fn()
const mockFetchUserOrders = vi.fn()
const mockFetchActiveOrders = vi.fn()
const mockCancelOrderInSupabase = vi.fn()
const mockSubscribeToOrders = vi.fn()
const mockCheckOracleCoverage = vi.fn()
const mockFetchDefiLlamaPrice = vi.fn()

/** The Base (8453) OrderExecutorV3 — docs/DEPLOYMENTS.md, LIVE since the 2026-07-21 cutover. */
const V3_ADDRESS = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'

/** Every readContract call the panel's feed gate makes, in order — the chain-awareness evidence. */
const registryCalls: Array<{ address: string; functionName: string; token: string }> = []
const clientCalls: number[] = []
let registryThrows = false

/**
 * `tokenUsdFeeds(address)` as it really answers on Base, read 2026-09-09 with
 *   cast call 0x686b…60a0 "tokenUsdFeeds(address)(address,uint8,uint8,uint256,bool)" <token>
 * Tuple order is the contract's: feed, feedDecimals, tokenDecimals, maxStaleness, registered.
 * Absent keys are the genuine on-chain answer for an unregistered token: the zero struct.
 */
const BASE_TOKEN_USD_FEEDS: Record<string, readonly [string, number, number, bigint, boolean]> = {
  // WETH
  '0x4200000000000000000000000000000000000006': [
    '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 8, 18, 3600n, true,
  ],
  // USDC
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': [
    '0x458138Fc0D67027E9A6778ef40a6ffC318c69061', 8, 6, 90000n, true,
  ],
}
const UNREGISTERED = ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false] as const

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
  useSignTypedData: () => ({ signTypedDataAsync: mockSignTypedDataAsync }),
  useWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
  // Nonces for useOrderEngine; `undefined` allowance for useOrderApproval (⇒ needsApproval).
  useReadContract: (opts: { functionName?: string }) =>
    opts.functionName === 'nonces' || opts.functionName === 'invalidatedNonces'
      ? { data: opts.functionName === 'nonces' ? 5n : 0n, isLoading: false, refetch: mockRefetchNonce }
      : { data: undefined, isLoading: false, refetch: mockRefetchNonce },
  useReadContracts: () => ({ data: [], isLoading: false, isError: false }),
  // Hash-driven, so an approve tx actually CONFIRMS and the modal advances to the sign step. A
  // flat `isSuccess: true` would mark the order pre-approved at mount and the approve button would
  // never render at all — which would make "the approval mock was never called" vacuous.
  useWaitForTransactionReceipt: ({ hash }: { hash?: string }) => ({ isSuccess: !!hash, isError: false }),
  useBalance: () => ({ data: undefined, isLoading: false, isError: false }),
}))

/**
 * THE gate under test reads through this factory. Stubbing it here (rather than stubbing
 * `readExecutorFeedCoverage`) keeps the real decision — decode, fail-closed posture, which function
 * is called on which address — inside the assertions.
 */
vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: (chainId: number) => {
    clientCalls.push(chainId)
    return {
      readContract: async (args: { address: string; functionName: string; args: readonly unknown[] }) => {
        registryCalls.push({
          address: args.address,
          functionName: args.functionName,
          token: String(args.args[0]).toLowerCase(),
        })
        if (registryThrows) throw new Error('rpc unavailable')
        return BASE_TOKEN_USD_FEEDS[String(args.args[0]).toLowerCase()] ?? UNREGISTERED
      },
    }
  },
  _clearClientCache: vi.fn(),
}))

/**
 * Pinned healthy so nothing here can pass or fail for Chainlink-identity reasons — that gate has its
 * own suite (DCAPanel.oracle-fail-closed.test.tsx). This file is about the EXECUTOR's registry,
 * which is a different question with a different answer.
 */
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
    // v3 live on Base — the production shape of any chain a user can reach this panel on
    // (page.tsx renders DCAPanel behind isDcaLive, which requires this to be non-null).
    getOrderExecutorV3: (chainId: number) => (chainId === 8453 ? V3_ADDRESS : null),
    getOrderExecutorV3Domain: (chainId: number) => {
      if (chainId !== 8453) throw new Error(`No OrderExecutorV3 deployed on chain ${chainId}`)
      return { name: 'TeraSwapOrderExecutor' as const, version: '3' as const, chainId, verifyingContract: V3_ADDRESS }
    },
    // Makes the REAL OrderReviewModal render its real Approve button, so "the approval mock was
    // never called" is a claim about a surface that demonstrably exists (proved by the control).
    resolveSigningExecutor: (chainId: number, isV3Order: boolean) =>
      isV3Order && chainId === 8453 ? V3_ADDRESS : null,
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
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div data-testid="beta-disclaimer" /> }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))
// OrderReviewModal is deliberately NOT mocked: it is where the approve button lives.

/**
 * Neither output is marked 'Imported', so the separate routability gate never engages — this file
 * is only about the executor's fair-value registry.
 */
vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected, onSelect, hideNativeInput }: {
    selected: { symbol?: string } | null
    onSelect: (t: unknown) => void
    hideNativeInput?: boolean
  }) => (
    <div data-testid={hideNativeInput ? 'token-selector-in' : 'token-selector-out'}>
      <span>{selected?.symbol ?? 'Select'}</span>
      {!hideNativeInput && (
        <>
          <button
            data-testid="pick-unregistered-out"
            onClick={() => onSelect({
              address: '0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB',
              symbol: 'ETHFI', name: 'Ether.fi', decimals: 18, logoURI: '', category: 'DeFi', chainId: 8453,
            })}
          >pick-unregistered</button>
          <button
            data-testid="pick-registered-out"
            onClick={() => onSelect({
              address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '', category: 'Stablecoin', chainId: 8453,
            })}
          >pick-registered</button>
        </>
      )}
    </div>
  ),
}))

import { renderWithProviders, screen, fireEvent, waitFor, act } from '@/test-utils/render'
import DCAPanel from './DCAPanel'
import { EXECUTOR_FEED_REGISTRY_FN } from '@/lib/order-engine/executor-feed-registry'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)
const WETH_BASE = '0x4200000000000000000000000000000000000006'

const enterAmount = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: v } })

/**
 * Drive creation as far as the UI is willing to take the user, clicking every control it offers —
 * which is what the person in the measured incident did. This is what makes the tests below fail on
 * BEHAVIOUR rather than on a missing banner: before the fix the same clicks walk straight through
 * the consent modal, the real Approve button and the real Confirm & Sign button, so the two
 * `not.toHaveBeenCalled()` assertions are the ones that break.
 */
async function driveCreationAsFarAsTheUiAllows() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start DCA/i })) })
  // Pre-fix only: the no-feed consent modal stood here and Accept continued to signing. Post-fix
  // the modal has no DCA path at all, so this query simply finds nothing.
  const accept = screen.queryByTestId('nofeed-consent-accept')
  if (accept) await act(async () => { fireEvent.click(accept) })
  const approve = screen.queryByTestId('order-approve')
  if (approve) await act(async () => { fireEvent.click(approve) })
  const confirm = screen.queryByTestId('order-confirm')
  if (confirm) await act(async () => { fireEvent.click(confirm) })
}

/**
 * Every wallet-facing call the creation flow can make. The first two are the acceptance criterion:
 * an on-chain approval transaction and an EIP-712 signature, neither of which may be requested for
 * an order the executor cannot price.
 */
function expectNoWalletInteraction() {
  expect(mockWriteContractAsync).not.toHaveBeenCalled()  // the approval tx
  expect(mockSignTypedDataAsync).not.toHaveBeenCalled()  // the EIP-712 signature
  expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()
  expect(screen.queryByTestId('order-approve')).toBeNull()
  expect(screen.queryByTestId('order-confirm')).toBeNull()
}

beforeEach(() => {
  vi.clearAllMocks()
  registryCalls.length = 0
  clientCalls.length = 0
  registryThrows = false
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: 8453 } })
  useChainIdMock.mockReturnValue(8453)
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

describe('DCAPanel — a leg the executor cannot price is refused BEFORE any wallet interaction', () => {
  it('an unregistered tokenOut blocks creation: no approval tx, no signature', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-unregistered-out'))
    enterAmount('100')

    await driveCreationAsFarAsTheUiAllows()

    expectNoWalletInteraction()
    // Secondary, and only after the behaviour: the user is told WHICH leg is the problem.
    const block = await screen.findByTestId('dca-submit-block')
    expect(block.textContent).toMatch(/ETHFI/)
    expect(block.textContent).toMatch(/buying/i)
  })

  it('NON-VACUITY — the same flow with a registered tokenOut reaches the real approve button', async () => {
    // Without this the test above would pass just as well if the button were simply broken. Here
    // the review modal mounts, its real Approve button renders, and clicking it calls the very
    // writeContractAsync the blocked case asserts was never called.
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-registered-out'))
    enterAmount('100')

    await driveCreationAsFarAsTheUiAllows()

    expect(screen.queryByTestId('dca-submit-block')).toBeNull()
    expect(mockWriteContractAsync).toHaveBeenCalledTimes(1)  // the real approve button was there
    expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1)  // and so was the real sign button
  })

  it('a registry it cannot READ also blocks — "could not check" is never "checked, fine"', async () => {
    registryThrows = true
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-registered-out'))
    enterAmount('100')

    await driveCreationAsFarAsTheUiAllows()

    expectNoWalletInteraction()
    expect((await screen.findByTestId('dca-submit-block')).textContent).toMatch(/could not check/i)
  })

  it('the DEFAULT output (native ETH) is refused too — the sentinel is what gets SIGNED', async () => {
    // useOrderEngine.createOrder resolves a native-ETH tokenIn to wrapped native and leaves tokenOut
    // untouched, so order.tokenOut is the 0xEeee… sentinel and that is the key _fairValueOut looks
    // up. It is not registered on Base (measured 2026-09-09), so hasFeed is false and the floor is
    // the dust fallback. Pinning it here so a future "normalise the sentinel to WETH" convenience
    // cannot quietly re-open the hole by answering a question the contract never asks.
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    await driveCreationAsFarAsTheUiAllows()

    expectNoWalletInteraction()
    await screen.findByTestId('dca-submit-block')
    expect(registryCalls.map(c => c.token)).toContain('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
  })
})

describe('DCAPanel — the check is asked of the executor on the ACTIVE chain', () => {
  it('queries tokenUsdFeeds on the active chain\'s executor, for BOTH signed legs', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-registered-out'))
    enterAmount('100')
    await driveCreationAsFarAsTheUiAllows()

    await waitFor(() => expect(registryCalls.length).toBe(2))
    // The client is built for the CONNECTED chain — no hardcoded id, no frontend list.
    expect(clientCalls).toEqual([8453])
    for (const call of registryCalls) {
      expect(call.address).toBe(V3_ADDRESS)
      expect(call.functionName).toBe(EXECUTOR_FEED_REGISTRY_FN)
    }
    // Spend leg (WETH, as signed) and buy leg (USDC) — both, because _fairValueOut needs both.
    expect(registryCalls.map(c => c.token).sort()).toEqual(
      [WETH_BASE.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'].sort(),
    )
  })

  it('switching chain away from the executor\'s chain blocks rather than querying another chain', async () => {
    useChainIdMock.mockReturnValue(1)
    useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: 1 } })
    renderWithProviders(<DCAPanel />)
    // v3 is not configured on mainnet in this suite, so the panel is in its chain-unavailable
    // state and nothing is queried — the gate never reaches out to the wrong chain's executor.
    expect(screen.getByTestId('dca-chain-unavailable')).toBeInTheDocument()
    expect(registryCalls).toHaveLength(0)
  })
})

describe('DCAPanel — the no-feed consent modal is gone from the DCA flow', () => {
  it('an unregistered output shows the refusal, never the "you\'re not unprotected" modal', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-unregistered-out'))
    enterAmount('100')
    await driveCreationAsFarAsTheUiAllows()

    await waitFor(() => expect(screen.getByTestId('dca-submit-block')).toBeInTheDocument())
    expect(screen.queryByTestId('nofeed-consent-modal')).toBeNull()
    // …and the refusal makes no protection promise of its own.
    expect(screen.getByTestId('dca-submit-block').textContent).not.toMatch(/not unprotected/i)
  })
})
