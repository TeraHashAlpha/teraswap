// @vitest-environment jsdom
/**
 * [FIX-DCA-PANEL-ORACLE-FAIL-CLOSED] DCAPanel — the Chainlink oracle gate on DCA order creation.
 *
 * The bug: the panel called `useChainlinkPrice(...)` twice and took only `.chainlinkPrice`, throwing
 * away `oracleIntegrityFailed` and `oracleReadFailed`. That price is the reference
 * `deriveSigningMinAmountOut` builds the per-buy `minAmountOut` floor from, so an oracle that had
 * explicitly refused to vouch for the price still produced a floor the user SIGNED — and when the
 * feed's answer was missing entirely, the DefiLlama fallback (and behind it the hardcoded
 * APPROX_PRICES table) quietly supplied a substitute, laundering a fail-closed state into a
 * fail-open one.
 *
 * Every test here is written to fail if the fix is reverted — verified by mutation, not by
 * inspection. The two halves of the story are deliberately adjacent: an UNVERIFIED feed must block
 * and must not reach a non-oracle source, while a token with NO feed at all must keep working
 * exactly as before (that is the ordinary case for imported/thin DCA assets, and `evaluatePriceGate`
 * classifies it 'ok').
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
// The real Base ETH/USD feed. Both DEFAULT DCA legs resolve here on Base: tokenIn defaults to Base
// WETH, and native ETH (the tokenOut default) is mapped to the chain's wrapped-native.
// Its genuine FEED_EXPECTATIONS entry is { description: 'ETH / USD', decimals: 8 } (ADR-018).
const BASE_ETH_USD_FEED = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'
// [L-2] The base leg of Base cbETH's COMPOSED feed (cbETH/USD = cbETH/ETH × ETH/USD). Its genuine
// FEED_EXPECTATIONS entry is { description: 'CBETH / ETH', decimals: 18 } — a DIFFERENT identity and
// a DIFFERENT decimal count from the quote leg, which is why the per-address mock below exists: a
// single flat description/decimals pair would make the composed base leg fail identity verification
// and the L-2 test would then pass or fail for a reason that has nothing to do with L-2.
const BASE_CBETH_ETH_FEED = '0x806b4Ac04501c29769051e42783cF04dCE41440b'

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
  useSignTypedData: () => ({ signTypedDataAsync: mockSignTypedDataAsync }),
  useWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
  useReadContract: (opts: { address?: string; functionName: string }) => mockReadContractImpl(opts),
  useBalance: () => ({ data: undefined, isLoading: false, isError: false }),
  useReadContracts: () => ({ data: [], isLoading: false, isError: false }),
}))

// The depeg gate is a SEPARATE, already-shipped circuit-breaker. Pinned to 'ok' so nothing here can
// pass or fail for depeg reasons — this suite is about the Chainlink price-verification gate only,
// and one of its assertions is precisely that the two never get confused for each other.
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
    // v3 deployed on Base for this file. This is not an exotic setup: DCAPanel is only ever rendered
    // behind isDcaLive(chainId) (page.tsx), which itself requires getOrderExecutorV3(chainId) !==
    // null — the same condition as the panel's own `v3Enabled`. So this IS the production shape of
    // any chain where a user can reach the DCA panel at all.
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
/**
 * The OUTPUT token must be selectable now: both new tests below turn on which token is being bought
 * (a COMPOSED-feed one for L-2, a genuinely feedless one for L-1), and neither state is reachable
 * from the default WETH → ETH pair. The panel renders two TokenSelectors and only the SPEND one
 * passes `hideNativeInput`, so that prop is what distinguishes them — the same prop the panel
 * already relies on, not a test-only hook added to production code.
 */
vi.mock('@/components/TokenSelector', () => ({
  default: ({
    selected, onSelect, hideNativeInput,
  }: { selected: { symbol?: string } | null; onSelect: (t: unknown) => void; hideNativeInput?: boolean }) => {
    const side = hideNativeInput ? 'in' : 'out'
    return (
      <div data-testid={`token-selector-${side}`}>
        {selected?.symbol ?? 'Select'}
        <button
          data-testid={`pick-composed-${side}`}
          onClick={() => onSelect(CBETH_BASE)}
        >pick-composed</button>
        <button
          data-testid={`pick-feedless-${side}`}
          onClick={() => onSelect(FEEDLESS_TOKEN)}
        >pick-feedless</button>
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
/**
 * [L-1] Stubbed for its CONTROLS, not its copy. `handleNoFeedAccept` is the one caller that reaches
 * `handleCreate` without going through the button's own click handler, so it is the only surface from
 * which the in-handler guards can be exercised at all. Rendering only while `open` keeps the stub
 * honest about the real modal's gating.
 */
vi.mock('./NoFeedConsentModal', () => ({
  default: ({ open, onAccept, onReject }: { open: boolean; onAccept: () => void; onReject: () => void }) =>
    open ? (
      <div data-testid="nofeed-modal">
        <button data-testid="nofeed-accept" onClick={onAccept}>accept</button>
        <button data-testid="nofeed-reject" onClick={onReject}>reject</button>
      </div>
    ) : null,
}))

import { renderWithProviders, screen, fireEvent, waitFor, act } from '@/test-utils/render'
import { PRICE_IMPACT_CONSENT_CEILING } from '@/lib/constants'
import type { PriceCheck } from '@/lib/chainlink'
import DCAPanel, { evaluateDcaOracleGate, outputHasNoResolvableFeed } from './DCAPanel'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)

/**
 * [L-2] Base cbETH — the token the whole Low is about. Address is the literal
 * COMPOSED_FEEDS_BY_CHAIN[8453] registry key, so this fixture cannot drift from the registry it is
 * asserting against. It has NO direct cbETH/USD feed on Base (deliberately — a cbETH/ETH feed
 * dropped into the USD-keyed map would read ~1.08 as "$1.08") and DOES have a verified composed one.
 */
const CBETH_BASE = {
  address: '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22',
  symbol: 'cbETH',
  decimals: 18,
  name: 'Coinbase Wrapped Staked ETH',
  chainId: 8453,
}
/** Base WETH — a DIRECT-feed token, the control for the L-2 predicate. */
const WETH_BASE_ADDRESS = '0x4200000000000000000000000000000000000006'
/**
 * A token with no price source of ANY shape. Deliberately synthetic rather than a real feedless Base
 * asset (USDbC): the property under test is "absent from every feed registry", and a synthetic
 * address holds that property permanently — a real token could acquire a feed later and silently
 * turn both tests below vacuous.
 */
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
function startDcaButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Start DCA/i }) as HTMLButtonElement
}
function openAdvanced() {
  fireEvent.click(screen.getByText(/Advanced settings/i))
}
/** Buy Base cbETH — a token whose only price source is a COMPOSED feed. */
function pickComposedOutput() {
  fireEvent.click(screen.getByTestId('pick-composed-out'))
}
/** Buy a token with no price source of any shape. */
function pickFeedlessOutput() {
  fireEvent.click(screen.getByTestId('pick-feedless-out'))
}

/**
 * React refuses to dispatch a click-type synthetic event to a component it rendered as `disabled`,
 * checking its own fiber-cached props rather than the DOM attribute — so `fireEvent.click` on the
 * disabled button proves only that the button is disabled, never that the production handler's own
 * guard is what blocks. This reads React's per-fiber props off the node and invokes the real
 * `onClick` closure for that render. Test-only reflection; same helper as DCAPanel.test.tsx's
 * depeg L-1 test, and used here for the same reason: to pin `handleCreate`'s in-handler guard
 * independently of the button's disabled state.
 */
function clickBypassingDisabled(el: HTMLElement): unknown {
  const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'))
  if (!propsKey) throw new Error('React props key not found on element')
  const onClick = (el as unknown as Record<string, { onClick?: (e: unknown) => unknown }>)[propsKey]?.onClick
  if (!onClick) throw new Error('Element has no onClick prop')
  return onClick({})
}

// ── Feed states, each produced through the REAL useChainlinkPrice ladder ──

/** Healthy: answer > 0, answeredInRound === roundId, fresh inside the 20-min Base heartbeat. */
function healthyRound() {
  const now = BigInt(Math.floor(Date.now() / 1000))
  return [1n, 2000_00000000n, now - 60n, now - 60n, 1n]
}

/** Healthy cbETH/ETH round: ~1.08 ETH at the feed's real 18 decimals. */
function healthyCbethEthRound() {
  const now = BigInt(Math.floor(Date.now() / 1000))
  return [1n, 1_080000000000000000n, now - 60n, now - 60n, 1n]
}

/**
 * The default read table, keyed BY FEED ADDRESS. Each feed answers with its own genuine ADR-018
 * identity, so a composed token's two legs verify independently exactly as they do in production —
 * the quote leg as 'ETH / USD' at 8 dp, the base leg as 'CBETH / ETH' at 18 dp. `override` replaces
 * the answer for whichever feed a test wants to put into a failure state, leaving the others healthy.
 */
function feedReads(override?: (addr: string, fn: string) => { data: unknown; isError?: boolean } | undefined) {
  return ({ address, functionName }: { address?: string; functionName: string }) => {
    if (functionName === 'nonces') return { data: 5n, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'invalidatedNonces') return { data: 0n, isLoading: false, refetch: mockRefetchNonce }
    const addr = (address ?? '').toLowerCase()
    const forced = override?.(addr, functionName)
    if (forced) return { ...forced, isLoading: false, refetch: mockRefetchNonce }
    if (addr === BASE_CBETH_ETH_FEED.toLowerCase()) {
      if (functionName === 'latestRoundData') return { data: healthyCbethEthRound(), isLoading: false, refetch: mockRefetchNonce }
      if (functionName === 'decimals') return { data: 18, isLoading: false, refetch: mockRefetchNonce }
      if (functionName === 'description') return { data: 'CBETH / ETH', isLoading: false, refetch: mockRefetchNonce }
    }
    if (functionName === 'latestRoundData') return { data: healthyRound(), isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'decimals') return { data: 8, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'description') return { data: 'ETH / USD', isLoading: false, refetch: mockRefetchNonce }
    return { data: undefined, isLoading: false, refetch: mockRefetchNonce }
  }
}

/**
 * Reads that never yield a usable round → UNREADABLE → oracleReadFailed (and, by design,
 * oracleUnavailable + oracleIntegrityFailed with it). `isError` is what separates this from a
 * genuine first render, which must stay neutral and frictionless.
 */
function mockReadFailure() {
  mockReadContractImpl.mockImplementation(feedReads(() => ({ data: undefined, isError: true })))
}

/**
 * The ADR-018 case, and the sharpest one: every read SUCCEEDS, the round is genuinely fresh and
 * valid, decimals match — but the feed's own description() says it is a different pair than the
 * config claims. This is exactly how WBTC/USD silently read the BTC/USD index feed and passed every
 * other guard. Integrity failed, read did NOT fail: the two flags are distinct states here, not one
 * state asserted twice.
 */
function mockIdentityMismatch() {
  // Scoped to the ETH/USD feed — the one both DEFAULT legs resolve to, and the SPEND leg's feed under
  // every pair used here. Everything else stays healthy, so a block can only come from this feed.
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
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: 8453 } })
  useChainIdMock.mockReturnValue(8453)
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockWriteContractAsync.mockResolvedValue('0x' + 'ff'.repeat(32))
  mockRefetchNonce.mockResolvedValue({ data: 5n })
  // Default: every feed healthy and self-identifying correctly — so any block below is caused by the
  // state the test sets up, never by the baseline.
  mockReadContractImpl.mockImplementation(feedReads())
  mockFetchUserOrders.mockResolvedValue([])
  mockFetchActiveOrders.mockResolvedValue([])
  mockCreateOrderInSupabase.mockResolvedValue({ order_hash: '0x' + 'aa'.repeat(32) })
  mockSubscribeToOrders.mockReturnValue(vi.fn())
  mockFetchDefiLlamaPrice.mockResolvedValue({ price: 2000, symbol: 'X', timestamp: 0, confidence: 1 })
})

describe('DCAPanel — oracle fail-closed: creation is blocked on an unverified feed', () => {
  it('a healthy verified feed is the control: creation still reaches signing', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    expect(screen.queryByTestId('dca-oracle-block')).toBeNull()
    fireEvent.click(startDcaButton())
    fireEvent.click(await screen.findByTestId('confirm-review'))

    await waitFor(() => expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1))
  })

  it('oracleIntegrityFailed (feed identity mismatch) blocks creation — no review, no signature', async () => {
    mockIdentityMismatch()
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    await waitFor(() => expect(screen.getByTestId('dca-oracle-block')).toBeInTheDocument())
    expect(startDcaButton()).toBeDisabled()

    fireEvent.click(startDcaButton())
    await waitFor(() => expect(mockSignTypedDataAsync).not.toHaveBeenCalled())
    expect(screen.queryByTestId('confirm-review')).toBeNull()
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()

    // The feed's own reason is surfaced, not a generic one.
    expect(screen.getByTestId('dca-oracle-block').textContent)
      .toMatch(/Chainlink feed identity does not match the configured pair/i)
  })

  it('oracleReadFailed (feed configured but unreadable) blocks creation — no review, no signature', async () => {
    mockReadFailure()
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    await waitFor(() => expect(screen.getByTestId('dca-oracle-block')).toBeInTheDocument())
    expect(startDcaButton()).toBeDisabled()

    fireEvent.click(startDcaButton())
    await waitFor(() => expect(mockSignTypedDataAsync).not.toHaveBeenCalled())
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()

    // Says the feed could not be READ — never that the token has no feed, which would be false.
    expect(screen.getByTestId('dca-oracle-block').textContent)
      .toMatch(/could not be read/i)
  })

  // Deliberately asserts NOTHING about `disabled` — the two tests above already pin that, and
  // asserting it here would short-circuit this test before the forced click ever ran (it did: the
  // first draft passed under a `canCreate` mutation for that exact reason). What this pins is that
  // the production handler itself refuses over a blocked render.
  it('a forced click cannot sign — the handler refuses over a blocked render, not just the button', async () => {
    mockIdentityMismatch()
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    await waitFor(() => expect(screen.getByTestId('dca-oracle-block')).toBeInTheDocument())

    // Invokes the real onClick closure over the blocked render's state, bypassing React's
    // disabled-suppression — the only surface a script or a `canCreate` regression can reach.
    await act(async () => { await clickBypassingDisabled(startDcaButton()) })

    expect(mockSignTypedDataAsync).not.toHaveBeenCalled()
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-review')).toBeNull()
  })
})

describe('DCAPanel — oracle fail-closed: no non-oracle source may rescue an integrity failure', () => {
  it('THE TRAP — DefiLlama is never consulted after a Chainlink integrity failure', async () => {
    // The identity-mismatch verdict returns chainlinkPrice: null, so the fallback's own trigger
    // condition (`chainlinkPriceIn == null`) IS satisfied. Before the fix this fetched DefiLlama and
    // derived a signed floor from it — a fail-closed oracle verdict laundered into a fail-open one.
    mockIdentityMismatch()
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    await waitFor(() => expect(screen.getByTestId('dca-oracle-block')).toBeInTheDocument())
    // Settle any effect that would have fired, then assert it did not.
    await act(async () => { await Promise.resolve() })
    expect(mockFetchDefiLlamaPrice).not.toHaveBeenCalled()
  })

  it('and no floor is even PREVIEWED from the APPROX_PRICES tier while the oracle is unverified', async () => {
    // APPROX_PRICES sits behind DefiLlama inside deriveSigningMinAmountOut and needs no live source
    // at all, so blocking the fetch alone would still have let the panel display a confident
    // "Signed floor per order: ≥ X" resting on a price the oracle had refused to vouch for.
    mockIdentityMismatch()
    renderWithProviders(<DCAPanel />)
    enterAmount('100')
    openAdvanced()

    await waitFor(() => expect(screen.getByTestId('dca-oracle-block')).toBeInTheDocument())
    expect(screen.queryByText(/Signed floor per order/i)).toBeNull()
  })

  it('CONTRAST — a token with NO feed at all is not blocked, and DOES still price via DefiLlama', async () => {
    // oracleUnavailable without oracleIntegrityFailed ⇒ evaluatePriceGate 'ok'. This is the ordinary
    // DCA case for imported/thin assets and must keep working; a gate that blocked it would be a
    // serious availability regression dressed up as a safety fix.
    //
    // The feedless state is produced by BUYING a token that is genuinely absent from every feed
    // registry, not by stubbing a resolver: post-#370 `useChainlinkPrice` resolves through
    // `resolveFeed`, so the old `mockGetChainlinkFeed.mockReturnValue(null)` no longer reached the
    // hook's resolution at all and this test had gone red on the rebase. Same assertions, real
    // registry deciding. This is also what keeps THE TRAP's `not.toHaveBeenCalled()` non-vacuous:
    // the very same mock demonstrably fires here.
    renderWithProviders(<DCAPanel />)
    pickFeedlessOutput()
    enterAmount('100')

    await waitFor(() => expect(mockFetchDefiLlamaPrice).toHaveBeenCalled())
    expect(screen.queryByTestId('dca-oracle-block')).toBeNull()
    expect(startDcaButton()).not.toBeDisabled()
  })
})

// ── [L-2] A composed feed IS a feed ──

describe('DCAPanel — L-2: a COMPOSED-feed output token is not treated as feedless', () => {
  it('outputHasNoResolvableFeed is false for Base cbETH, whose only source is composed', () => {
    // The regression this pins, stated as the predicate: `getChainlinkFeed(cbETH, 8453)` is null
    // (there is no direct cbETH/USD entry, by design), so the old direct-only check answered "no
    // feed" — while the hook was pricing cbETH from a verified cbETH/ETH × ETH/USD pair and the
    // signing floor was being derived from it. Real registry, no stubs.
    expect(outputHasNoResolvableFeed(CBETH_BASE as never, 8453)).toBe(false)
  })

  it('stays TRUE for a token with no source of any shape — the safe direction is not inverted', () => {
    expect(outputHasNoResolvableFeed(FEEDLESS_TOKEN as never, 8453)).toBe(true)
  })

  it('is false for a DIRECT-feed token (control) and false for no token at all', () => {
    expect(outputHasNoResolvableFeed({ address: WETH_BASE_ADDRESS } as never, 8453)).toBe(false)
    expect(outputHasNoResolvableFeed(null, 8453)).toBe(false)
  })

  it('so buying cbETH goes straight to review — no "no price feed" consent modal', async () => {
    // End-to-end counterpart to the predicate test: with both composed legs verifying against their
    // own genuine ADR-018 identities, creation must reach the review modal directly. Before the fix
    // `noFeedOutput` was true here, so the click was intercepted by the consent modal and
    // `confirm-review` never rendered — this test times out on the pre-fix component.
    renderWithProviders(<DCAPanel />)
    pickComposedOutput()
    enterAmount('100')

    await waitFor(() => expect(screen.getByTestId('token-selector-out').textContent).toMatch(/cbETH/))
    expect(screen.queryByTestId('dca-oracle-block')).toBeNull()

    fireEvent.click(startDcaButton())
    expect(await screen.findByTestId('confirm-review')).toBeInTheDocument()
    expect(screen.queryByTestId('nofeed-modal')).toBeNull()
  })
})

// ── [L-1] The in-handler guard, reached through the one caller that can reach it ──

describe('DCAPanel — L-1: the consent-accept path cannot sign over a blocked oracle', () => {
  /**
   * `handleNoFeedAccept` calls `handleCreate()` directly — it is the ONLY caller that does not go
   * through the Start-DCA button's own handler, and therefore the only surface from which
   * `handleCreate`'s in-handler guards are reachable at all. The scenario is a real one rather than a
   * contrivance: a feedless output token opens the consent modal while the SPEND feed is healthy, the
   * spend feed then degrades mid-session (these reads re-poll), and the user accepts a modal that was
   * opened under the earlier, healthy verdict. Nothing about the modal tells them the oracle moved.
   */
  async function openConsentThenDegrade() {
    renderWithProviders(<DCAPanel />)
    pickFeedlessOutput()
    enterAmount('100')
    await waitFor(() => expect(screen.getByTestId('token-selector-out').textContent).toMatch(/NOFEED/))
    // Healthy so far: not blocked, and the button is live.
    expect(screen.queryByTestId('dca-oracle-block')).toBeNull()
    fireEvent.click(startDcaButton())
    expect(await screen.findByTestId('nofeed-modal')).toBeInTheDocument()

    // Mid-session degradation of the SPEND feed, then a re-render so the hooks re-read it.
    mockIdentityMismatch()
    enterAmount('100.5')
    await waitFor(() => expect(screen.getByTestId('dca-oracle-block')).toBeInTheDocument())
    // The modal is still open over a now-blocked render — this is the exact window the guard covers.
    expect(screen.getByTestId('nofeed-modal')).toBeInTheDocument()
  }

  it('accepting the consent modal after the spend feed degrades signs nothing', async () => {
    await openConsentThenDegrade()

    await act(async () => { fireEvent.click(screen.getByTestId('nofeed-accept')) })

    expect(mockSignTypedDataAsync).not.toHaveBeenCalled()
    expect(mockCreateOrderInSupabase).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-review')).toBeNull()
  })

  it('NON-VACUITY — the same accept path DOES sign while the oracle stays verified', async () => {
    // Without this, the test above would pass just as well if `handleNoFeedAccept` were broken, or if
    // the accept button were never wired at all.
    renderWithProviders(<DCAPanel />)
    pickFeedlessOutput()
    enterAmount('100')
    await waitFor(() => expect(screen.getByTestId('token-selector-out').textContent).toMatch(/NOFEED/))

    fireEvent.click(startDcaButton())
    expect(await screen.findByTestId('nofeed-modal')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('nofeed-accept'))

    fireEvent.click(await screen.findByTestId('confirm-review'))
    await waitFor(() => expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1))
  })
})

describe('DCAPanel — oracle fail-closed: the surfaced reason is the oracle one', () => {
  it('says the price could not be VERIFIED, and never blames price movement or manipulation', async () => {
    mockIdentityMismatch()
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    const banner = await screen.findByTestId('dca-oracle-block')
    expect(banner.textContent).toMatch(/could not be verified/i)

    // A feed we could not verify is OUR misconfiguration/outage. Borrowing the deviation gate's or
    // the depeg gate's manipulation language for it would be a false accusation against the asset.
    expect(banner.textContent).not.toMatch(/moved too far/i)
    expect(banner.textContent).not.toMatch(/manipulation/i)
    expect(banner.textContent).not.toMatch(/depeg/i)
    // …and it explicitly disclaims both alternative readings.
    expect(banner.textContent).toMatch(/not a finding about/i)
    expect(banner.textContent).toMatch(/not a sign the price moved/i)

    // The separate depeg circuit-breaker's banners are NOT what fired.
    expect(screen.queryByTestId('dca-depeg-block')).toBeNull()
    expect(screen.queryByTestId('dca-depeg-unverified')).toBeNull()
  })
})

// ── The gate decision itself, unit-level ──

const LEG_BASE: PriceCheck = {
  chainlinkPrice: 2000,
  executionPrice: null,
  deviation: 0,
  level: 'none',
  message: null,
  oracleUnavailable: false,
}
const HEALTHY: PriceCheck = LEG_BASE
const INTEGRITY_FAILED: PriceCheck = {
  ...LEG_BASE, chainlinkPrice: null, level: 'warn',
  message: 'Chainlink feed identity does not match the configured pair. Price not verified.',
  oracleIntegrityFailed: true,
}
const READ_FAILED: PriceCheck = {
  ...LEG_BASE, chainlinkPrice: null, level: 'warn',
  message: 'Chainlink price feed could not be read. Price not verified.',
  oracleUnavailable: true, oracleIntegrityFailed: true, oracleReadFailed: true,
}
const NO_FEED: PriceCheck = {
  ...LEG_BASE, chainlinkPrice: null, level: 'warn',
  message: 'No Chainlink oracle available — price cannot be independently verified. Proceed with caution.',
  oracleUnavailable: true,
}

describe('evaluateDcaOracleGate — delegates every decision to evaluatePriceGate', () => {
  it('passes two healthy legs', () => {
    expect(evaluateDcaOracleGate(HEALTHY, HEALTHY)).toEqual({ blocked: false, reason: 'none', detail: null })
  })

  it('blocks on an integrity failure and carries that leg\'s own message', () => {
    expect(evaluateDcaOracleGate(INTEGRITY_FAILED, HEALTHY)).toEqual({
      blocked: true, reason: 'oracle-integrity', detail: INTEGRITY_FAILED.message,
    })
  })

  it('blocks on a read failure', () => {
    expect(evaluateDcaOracleGate(HEALTHY, READ_FAILED)).toEqual({
      blocked: true, reason: 'oracle-integrity', detail: READ_FAILED.message,
    })
  })

  it('checks BOTH legs — a reference price is the ratio, so either leg poisons it', () => {
    expect(evaluateDcaOracleGate(HEALTHY, INTEGRITY_FAILED).blocked).toBe(true)
    expect(evaluateDcaOracleGate(INTEGRITY_FAILED, HEALTHY).blocked).toBe(true)
  })

  it('does NOT block a no-feed leg — that is oracleUnavailable, which evaluatePriceGate calls ok', () => {
    expect(evaluateDcaOracleGate(NO_FEED, NO_FEED).blocked).toBe(false)
  })

  it('routes an extreme deviation under its OWN reason, so the UI cannot say "unverified" for it', () => {
    const runaway: PriceCheck = {
      ...LEG_BASE, executionPrice: 4000, level: 'danger',
      deviation: PRICE_IMPACT_CONSENT_CEILING + 0.1,
      message: 'Execution price is far from the Chainlink reference price.',
    }
    expect(evaluateDcaOracleGate(runaway, HEALTHY)).toEqual({
      blocked: true, reason: 'extreme-deviation', detail: runaway.message,
    })
  })

  it('does not harden informed consent (deviation within the ceiling) into a block', () => {
    const impact: PriceCheck = {
      ...LEG_BASE, executionPrice: 2050, level: 'warn',
      deviation: PRICE_IMPACT_CONSENT_CEILING / 2,
      message: 'Execution price differs from the Chainlink reference price.',
    }
    expect(evaluateDcaOracleGate(impact, HEALTHY).blocked).toBe(false)
  })
})
