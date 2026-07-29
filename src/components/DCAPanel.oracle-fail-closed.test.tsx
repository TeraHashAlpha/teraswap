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
  (opts: { functionName: string }) => {
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
const mockGetChainlinkFeed = vi.fn<() => string | null>()

const V3_ADDRESS = '0x3333333333333333333333333333333333333333'
// The real Base ETH/USD feed. Both DCA legs resolve here on Base: tokenIn defaults to Base WETH,
// and native ETH (the tokenOut default) is mapped to the chain's wrapped-native by getChainlinkFeed.
// Its genuine FEED_EXPECTATIONS entry is { description: 'ETH / USD', decimals: 8 } (ADR-018).
const BASE_ETH_USD_FEED = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
  useSignTypedData: () => ({ signTypedDataAsync: mockSignTypedDataAsync }),
  useWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
  useReadContract: (opts: { functionName: string }) => mockReadContractImpl(opts),
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

// Only feed RESOLUTION is stubbed. getFeedExpectation and getFeedStalenessSec stay REAL, so the
// round data below is judged against the genuine ADR-018 expectation for this address and the
// genuine 20-minute Base heartbeat — the integrity failures asserted here are produced by the real
// ladder in useChainlinkPrice, not by a hand-written verdict.
vi.mock('@/lib/chainlink', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chainlink')>('@/lib/chainlink')
  return { ...actual, getChainlinkFeed: () => mockGetChainlinkFeed() }
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

import { renderWithProviders, screen, fireEvent, waitFor, act } from '@/test-utils/render'
import { PRICE_IMPACT_CONSENT_CEILING } from '@/lib/constants'
import type { PriceCheck } from '@/lib/chainlink'
import DCAPanel, { evaluateDcaOracleGate } from './DCAPanel'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)

function enterAmount(value: string) {
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value } })
}
function startDcaButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Start DCA/i }) as HTMLButtonElement
}
function openAdvanced() {
  fireEvent.click(screen.getByText(/Advanced settings/i))
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

/**
 * Reads that never yield a usable round → UNREADABLE → oracleReadFailed (and, by design,
 * oracleUnavailable + oracleIntegrityFailed with it). `isError` is what separates this from a
 * genuine first render, which must stay neutral and frictionless.
 */
function mockReadFailure() {
  mockReadContractImpl.mockImplementation(({ functionName }) => {
    if (functionName === 'nonces') return { data: 5n, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'invalidatedNonces') return { data: 0n, isLoading: false, refetch: mockRefetchNonce }
    return { data: undefined, isLoading: false, isError: true, refetch: mockRefetchNonce }
  })
}

/**
 * The ADR-018 case, and the sharpest one: every read SUCCEEDS, the round is genuinely fresh and
 * valid, decimals match — but the feed's own description() says it is a different pair than the
 * config claims. This is exactly how WBTC/USD silently read the BTC/USD index feed and passed every
 * other guard. Integrity failed, read did NOT fail: the two flags are distinct states here, not one
 * state asserted twice.
 */
function mockIdentityMismatch() {
  mockReadContractImpl.mockImplementation(({ functionName }) => {
    if (functionName === 'nonces') return { data: 5n, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'invalidatedNonces') return { data: 0n, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'latestRoundData') return { data: healthyRound(), isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'decimals') return { data: 8, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'description') return { data: 'BTC / USD', isLoading: false, refetch: mockRefetchNonce }
    return { data: undefined, isLoading: false, refetch: mockRefetchNonce }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true, chain: { id: 8453 } })
  useChainIdMock.mockReturnValue(8453)
  mockGetChainlinkFeed.mockReturnValue(BASE_ETH_USD_FEED)
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockWriteContractAsync.mockResolvedValue('0x' + 'ff'.repeat(32))
  mockRefetchNonce.mockResolvedValue({ data: 5n })
  // Default: a healthy, verified feed — so any block below is caused by the state the test sets up.
  mockReadContractImpl.mockImplementation(({ functionName }) => {
    if (functionName === 'nonces') return { data: 5n, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'invalidatedNonces') return { data: 0n, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'latestRoundData') return { data: healthyRound(), isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'decimals') return { data: 8, isLoading: false, refetch: mockRefetchNonce }
    if (functionName === 'description') return { data: 'ETH / USD', isLoading: false, refetch: mockRefetchNonce }
    return { data: undefined, isLoading: false, refetch: mockRefetchNonce }
  })
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
    mockGetChainlinkFeed.mockReturnValue(null)
    renderWithProviders(<DCAPanel />)
    enterAmount('100')

    await waitFor(() => expect(mockFetchDefiLlamaPrice).toHaveBeenCalled())
    expect(screen.queryByTestId('dca-oracle-block')).toBeNull()
    expect(startDcaButton()).not.toBeDisabled()
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
