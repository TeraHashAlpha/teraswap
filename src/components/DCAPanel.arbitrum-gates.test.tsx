// @vitest-environment jsdom
/**
 * [feat/arbitrum-dca-gates] DCAPanel on Arbitrum One (42161) — the three gates this branch opens, and
 * the one it deliberately leaves in front of the user.
 *
 * Opened: `ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS` now lists 42161 and `ROUTERS_BY_CHAIN` carries a
 * derived Arbitrum set. NOTHING in `@/lib/order-engine/config` is mocked here — the panel resolves
 * the REAL `getOrderExecutorV3(42161)` from the REAL env slot, which this file sets to the address
 * EXTRACTED from `docs/DEPLOYMENTS.md`'s "OrderExecutor V3 · Arbitrum One (42161)" row (never typed;
 * a failed extraction exits with the sentinel 42 before any test runs).
 *
 * Left in place: the FIX-DCA-NOFEED-FAIL-CLOSED gate (executor-feed-registry.ts, PR #484), which
 * asks the executor's own `tokenUsdFeeds` for BOTH legs before approve/sign. On 2026-09-11 that
 * registry answers the ZERO struct (`registered=false`) for WETH and USDC on two Arbitrum RPCs — the
 * registrations are queued on-chain (TimelockQueued ×2, readyAt 2026-09-13T14:51:45Z / 14:52:54Z)
 * and this PR is not merged until they execute. So:
 *
 *   EMPTY registry (today)     ⇒ `dca-submit-block` naming the unregistered leg(s), no wallet call.
 *   registered=true, both legs ⇒ the guard PASSES: the review modal mounts and the real Approve
 *                                 button sends the approval to the DEPLOYMENTS.md executor — the
 *                                 panel-level identity proof for the spender.
 *
 * FOUND WHILE WRITING THE POSITIVE CASE — a THIRD gate the branch prompt did not list, opened by the
 * follow-up commit on this branch: `useOrderEngine.confirmOrder` and `confirmCancel` used to refuse
 * when `getOrderExecutor(chainId)` — the **v2** executor — was null, and the CancelOrder EIP-712
 * ownership-proof domain was `getOrderExecutorDomain` (v2) on both the client and `api/orders/[id]`.
 * Base has a v2 executor, so none of that ever fired there; Arbitrum is v3-ONLY
 * (ORDER_EXECUTOR_BY_CHAIN has no 42161 entry, pinned by config.test.ts). It was NOT opened for
 * creation alone — that would have minted orders the UI could neither sign a cancel for nor cancel
 * on-chain, the INC-2026-08-26-001 class. Now: both preconditions resolve the executor from the
 * ORDER's version (resolveSigningExecutor — the same resolver the approval spender uses), and the
 * proof domain is the one chain-level rule getCancelOrderDomain (v2's where v2 exists, else v3's)
 * on client and API alike. The third-gate case below pins the new truth at the panel: after the
 * approval to the DEPLOYMENTS.md executor, the EIP-712 signature is requested under
 * {name:'TeraSwapOrderExecutor', version:'3', chainId:42161, verifyingContract:<that executor>} and
 * the order is POSTed for 42161. The cancel half (on-chain cancelOrder on the same executor, proof
 * under the same domain) is pinned at the hook in useOrderEngine.v3-only-chain.test.ts and at the
 * API in orders-cancel.arbitrum-v3-only.test.ts.
 *
 * The chain-unavailable banner must NOT render in any state: the executor exists. And the
 * order-map gate (ADR-020) must not fire either: a router is committed, and it is the Arbitrum set's
 * default (Augustus V6), read from the real map.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Env BEFORE any import: config.ts reads NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM at load ──
const { ARBITRUM_V3 } = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const rows = readFileSync(resolve(process.cwd(), 'docs/DEPLOYMENTS.md'), 'utf8').split('\n')
  const row = rows.find(l => /\*\*OrderExecutor V3\*\*.*Arbitrum One \(42161\)/.test(l)) ?? ''
  const address = (row.match(/0x[0-9a-fA-F]{40}/) ?? [])[0]
  if (!address) {
    console.error('SENTINEL 42: could not extract the Arbitrum OrderExecutor V3 row from docs/DEPLOYMENTS.md')
    process.exit(42)
  }
  process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM = address
  return { ARBITRUM_V3: address as `0x${string}` }
})

const ARBITRUM = 42161

const mockSignTypedDataAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockWriteContractAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockRefetchNonce = vi.fn<() => Promise<unknown>>()
const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => ARBITRUM)

const mockCreateOrderInSupabase = vi.fn()
const mockFetchUserOrders = vi.fn()
const mockFetchActiveOrders = vi.fn()
const mockCancelOrderInSupabase = vi.fn()
const mockSubscribeToOrders = vi.fn()
const mockCheckOracleCoverage = vi.fn()
const mockFetchDefiLlamaPrice = vi.fn()

/** Every `tokenUsdFeeds` read the panel makes, in order — the evidence that the check ran on 42161. */
const registryCalls: Array<{ address: string; functionName: string; token: string }> = []
const clientCalls: number[] = []

/**
 * The executor's answer per leg. `EMPTY` is the exact zero struct both Arbitrum RPCs returned on
 * 2026-09-11 for WETH and USDC (tuple order feed, feedDecimals, tokenDecimals, maxStaleness,
 * registered). `REGISTERED` is what the two queued `setTokenUsdFeed` actions will write — the feed
 * address is read from the chain's own feed registry, the staleness values are the queued ones.
 */
type FeedRow = readonly [string, number, number, bigint, boolean]
const EMPTY: FeedRow = ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false]
let registryMode: 'empty' | 'registered' = 'empty'
let registeredRows: Record<string, FeedRow> = {}

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
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

// THE gate under test reads through this factory; the decision (decode, fail-closed posture, which
// function on which address) stays real inside readExecutorFeedCoverage.
vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: (chainId: number) => {
    clientCalls.push(chainId)
    return {
      readContract: async (args: { address: string; functionName: string; args: readonly unknown[] }) => {
        const token = String(args.args[0]).toLowerCase()
        registryCalls.push({ address: args.address, functionName: args.functionName, token })
        return registryMode === 'registered' ? (registeredRows[token] ?? EMPTY) : EMPTY
      },
    }
  },
  _clearClientCache: vi.fn(),
}))

// Chainlink identity / depeg / balances pinned healthy: those gates have their own suites.
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

// Supabase I/O stubbed; getOrderExecutorV3 / getOrderExecutorV3Domain / resolveSigningExecutor /
// getDefaultRouter are the REAL ones — that is the point of this file.
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
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div data-testid="beta-disclaimer" /> }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))
// OrderReviewModal is deliberately NOT mocked: it is where the approve + sign buttons live.
vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected, hideNativeInput }: { selected: { symbol?: string } | null; hideNativeInput?: boolean }) => (
    <div data-testid={hideNativeInput ? 'token-selector-in' : 'token-selector-out'}>
      <span>{selected?.symbol ?? 'Select'}</span>
    </div>
  ),
}))

import { renderWithProviders, screen, fireEvent, waitFor, act } from '@/test-utils/render'
import DCAPanel from './DCAPanel'
import { getChainConfig } from '@/lib/chains/registry'
import { CHAINLINK_FEEDS_BY_CHAIN } from '@/lib/chains/chainlink-feeds'
import { EXECUTOR_FEED_REGISTRY_FN } from '@/lib/order-engine/executor-feed-registry'
import {
  getOrderExecutorV3, getOrderExecutor, getDefaultRouter, ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS,
  NO_ROUTER_FOR_CHAIN_REASON,
} from '@/lib/order-engine/config'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)

// The two legs the panel defaults to on Arbitrum (WETH spend, canonical USDC buy) — from the chain
// registry, never typed — and their feeds from the chain's own Chainlink registry.
const ARB = getChainConfig(ARBITRUM)
const WETH = ARB.tokens.WETH!.toLowerCase()
const USDC = ARB.tokens.USDC!.toLowerCase()
const ETH_USD_FEED = CHAINLINK_FEEDS_BY_CHAIN[ARBITRUM][WETH]
const USDC_USD_FEED = CHAINLINK_FEEDS_BY_CHAIN[ARBITRUM][USDC]

const enterAmount = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: v } })

/** Drive creation as far as the UI allows — the same walk DCAPanel.nofeed-fail-closed.test.tsx uses. */
async function driveCreationAsFarAsTheUiAllows() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start DCA/i })) })
  const approve = screen.queryByTestId('order-approve')
  if (approve) await act(async () => { fireEvent.click(approve) })
  const confirm = screen.queryByTestId('order-confirm')
  if (confirm) await act(async () => { fireEvent.click(confirm) })
}

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
  registryMode = 'empty'
  registeredRows = {
    // What the queued actions write: (feed, feedDecimals, tokenDecimals, maxStaleness, registered).
    [WETH]: [ETH_USD_FEED, 8, 18, 3596n, true],
    [USDC]: [USDC_USD_FEED, 8, 6, 596n, true],
  }
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: ARBITRUM } })
  useChainIdMock.mockReturnValue(ARBITRUM)
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

describe('[feat/arbitrum-dca-gates] the two gates are open on 42161 — REAL config, env slot = the DEPLOYMENTS.md address', () => {
  it('sanity: 42161 is eligible, the env slot resolves the extracted executor, and the Arbitrum default router is Augustus V6', () => {
    expect(ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS).toContain(ARBITRUM)
    expect(getOrderExecutorV3(ARBITRUM)).toBe(ARBITRUM_V3)
    expect(getDefaultRouter(ARBITRUM)?.label).toBe('ParaSwap Augustus v6')
    // The two legs and their feeds really came from the registries, not from this file.
    expect(WETH).toMatch(/^0x[0-9a-f]{40}$/)
    expect(USDC).toMatch(/^0x[0-9a-f]{40}$/)
    expect(ETH_USD_FEED).toBeTruthy()
    expect(USDC_USD_FEED).toBeTruthy()
  })

  it('the chain-unavailable banner does NOT render on Arbitrum any more (an executor exists), and neither does the ADR-020 no-router refusal', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    expect(screen.queryByTestId('dca-chain-unavailable')).toBeNull()
    await driveCreationAsFarAsTheUiAllows()
    expect(screen.queryByTestId('dca-route-block')).toBeNull()
    expect(screen.queryByText(NO_ROUTER_FOR_CHAIN_REASON)).toBeNull()
  })
})

describe('[feat/arbitrum-dca-gates] the #484 no-feed guard is what gates the panel on Arbitrum', () => {
  it('registry EMPTY (the on-chain state until the queued feeds execute) ⇒ the no-registered-price-source block, no approval, no signature', async () => {
    registryMode = 'empty'
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    await driveCreationAsFarAsTheUiAllows()

    expectNoWalletInteraction()
    const block = await screen.findByTestId('dca-submit-block')
    expect(block.textContent).toMatch(/no registered price source/i)
    expect(block.textContent).toMatch(/Arbitrum One/)
    // Both legs are named as unregistered — WETH (spending) and USDC (buying) — today's exact state.
    expect(block.textContent).toMatch(/WETH/)
    expect(block.textContent).toMatch(/USDC/)
    // …and it was the ARBITRUM executor that was asked, for both signed legs.
    expect(clientCalls).toEqual([ARBITRUM])
    expect(registryCalls).toHaveLength(2)
    for (const call of registryCalls) {
      expect(call.address).toBe(ARBITRUM_V3)
      expect(call.functionName).toBe(EXECUTOR_FEED_REGISTRY_FN)
    }
    expect(registryCalls.map(c => c.token).sort()).toEqual([WETH, USDC].sort())
  })

  it('registered=true for BOTH legs (the post-execute state) ⇒ the #484 guard PASSES: no block, the review modal mounts and the real Approve sends the approval to the DEPLOYMENTS.md executor', async () => {
    registryMode = 'registered'
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    await driveCreationAsFarAsTheUiAllows()

    // The gate this PR leaves in front of the user did NOT fire…
    expect(screen.queryByTestId('dca-submit-block')).toBeNull()
    // …because both legs answered registered, on the Arbitrum executor.
    expect(clientCalls).toEqual([ARBITRUM])
    expect(registryCalls.map(c => c.token).sort()).toEqual([WETH, USDC].sort())
    for (const call of registryCalls) expect(call.address).toBe(ARBITRUM_V3)
    // The real approve button was there and was clicked: the approval goes to the SAME executor
    // the order would verify against (BUG-DCA-APPROVE-SPENDER-V3 — resolveSigningExecutor, real).
    expect(mockWriteContractAsync).toHaveBeenCalledTimes(1)
    const approval = mockWriteContractAsync.mock.calls[0][0] as { address: string; args: readonly unknown[] }
    expect(String(approval.args[0]).toLowerCase()).toBe(ARBITRUM_V3.toLowerCase())
    expect(approval.address.toLowerCase()).toBe(WETH) // the spend leg's ERC-20
  })

  it('THE THIRD GATE (opened): after the approval, confirmOrder signs under the V3 domain of the DEPLOYMENTS.md executor (version "3", chainId 42161) and POSTs the order for 42161 — the v2 precondition is gone', async () => {
    // Flipped deliberately from the predecessor's "flow stops here" pin, with the cancel half proven
    // in the same change (hook + API suites named in the header). Arbitrum STILL has no v2 executor —
    // the gate opened because the precondition became version-aware, not because v2 appeared:
    expect(getOrderExecutor(ARBITRUM)).toBeNull()
    expect(getOrderExecutorV3(ARBITRUM)).toBe(ARBITRUM_V3)

    registryMode = 'registered'
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    await driveCreationAsFarAsTheUiAllows()

    // Approval happened (previous case) …
    expect(mockWriteContractAsync).toHaveBeenCalledTimes(1)
    const approval = mockWriteContractAsync.mock.calls[0][0] as { args: readonly unknown[] }
    expect(String(approval.args[0]).toLowerCase()).toBe(ARBITRUM_V3.toLowerCase())
    // … and so did the sign step, under the v3 domain of the SAME executor the approval went to.
    expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1)
    const typed = mockSignTypedDataAsync.mock.calls[0][0] as {
      domain: { name: string; version: string; chainId: number; verifyingContract: string }
      primaryType: string
      types: { Order: Array<{ name: string; type: string }> }
      message: Record<string, unknown>
    }
    expect(typed.domain).toEqual({
      name: 'TeraSwapOrderExecutor', version: '3', chainId: ARBITRUM, verifyingContract: ARBITRUM_V3,
    })
    expect(typed.primaryType).toBe('Order')
    expect(typed.types.Order.some(f => f.name === 'maxSlippageBps' && f.type === 'uint16')).toBe(true)
    expect(typeof typed.message.maxSlippageBps).toBe('number')
    expect(String(typed.message.router).toLowerCase()).toBe(getDefaultRouter(ARBITRUM)!.address.toLowerCase())
    // The order reached the API for the chain it was signed under, tagged v3.
    expect(mockCreateOrderInSupabase).toHaveBeenCalledTimes(1)
    const posted = mockCreateOrderInSupabase.mock.calls[0][0] as { chainId: number; maxSlippageBps?: number }
    expect(posted.chainId).toBe(ARBITRUM)
    expect(posted.maxSlippageBps).toBe(typed.message.maxSlippageBps)
    // Neither the feed guard nor the old v2 wording fired.
    expect(screen.queryByTestId('dca-submit-block')).toBeNull()
    await waitFor(() =>
      expect(document.body.textContent).not.toMatch(/Conditional orders are not yet available on chain 42161\./),
    )
  })

  it('registered for ONE leg only ⇒ still refused, naming the other leg (the feed pair must be complete)', async () => {
    registryMode = 'registered'
    registeredRows = { [WETH]: registeredRows[WETH] } // USDC still the zero struct
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    await driveCreationAsFarAsTheUiAllows()

    expectNoWalletInteraction()
    const block = await screen.findByTestId('dca-submit-block')
    expect(block.textContent).toMatch(/USDC/)
    expect(block.textContent).toMatch(/buying/i)
    expect(block.textContent).not.toMatch(/WETH \(the token you're spending\)/)
  })
})
