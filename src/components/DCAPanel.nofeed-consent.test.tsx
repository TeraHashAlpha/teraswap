// @vitest-environment jsdom
/**
 * [FIX-DCA-NOFEED-CONSENT → FIX-DCA-NOFEED-FAIL-CLOSED] DCAPanel — the no-price-feed output path.
 *
 * SUPERSEDED, and kept here as the record of what replaced what. The original suite pinned a
 * CONSENT gate: ETHFI (an output token the browser could not price) showed a modal before signing,
 * Accept proceeded to createOrder, Reject cancelled. Owner decision 2026-09-09 reversed the
 * premise — the modal told the user "you're not unprotected" while, with no feed registered in the
 * executor, the on-chain floor was the ADR-013 dust fallback and that sentence was false.
 *
 * The golden ETHFI case is therefore inverted here rather than dropped: it must now be REFUSED, and
 * the consent modal must be unreachable from the DCA flow. The feed-covered control (USDC on Base)
 * is unchanged and still proves the ordinary path was not collateral damage. The modal's own
 * plain-language copy tests moved, intact, to NoFeedConsentModal.test.tsx — the component is
 * retained (rule #4) even though the DCA flow no longer routes to it.
 *
 * The deep behaviour proof — that no approval tx and no signature are requested — lives in
 * DCAPanel.nofeed-fail-closed.test.tsx, which drives the real OrderReviewModal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 8453)
const createOrderMock = vi.fn()
const checkRouteMock = vi.fn()
const checkOracleMock = vi.fn()

/** The Base (8453) OrderExecutorV3 — docs/DEPLOYMENTS.md. */
const V3_ADDRESS = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'
const BASE_REGISTERED: Record<string, readonly unknown[]> = {
  // WETH — the DCA spend leg on Base.
  '0x4200000000000000000000000000000000000006': ['0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 8, 18, 3600n, true],
  // USDC — the feed-covered control output.
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': ['0x458138Fc0D67027E9A6778ef40a6ffC318c69061', 8, 6, 90000n, true],
}

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
}))
vi.mock('@/hooks/useChainlinkPrice', () => ({
  useChainlinkPrice: () => ({ chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false }),
}))
// [FEAT-DEPEG-GATE-ORDER-CREATION] Same precedent as useChainlinkPrice above — stub directly
// rather than expanding this file's minimal wagmi mock with useReadContract. This suite doesn't
// exercise depeg behaviour, so a static 'ok' (no exchange-rate pair) keeps every test unaffected.
vi.mock('@/hooks/useDepegCheck', () => ({
  useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }),
}))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: new Map(), isLoading: false, isError: false }) }))
vi.mock('@/hooks/useTokenBalance', () => ({
  useTokenBalance: () => ({ raw: 1_000000000000000000000n, hasValue: true, formatted: '1000', isLoading: false, isError: false }),
}))
vi.mock('@/lib/order-engine/check-route', () => ({
  checkRoute: (...args: unknown[]) => checkRouteMock(...args),
  NO_ROUTE_REASON: 'No swap route found for this pair on this network.',
}))
vi.mock('@/lib/order-engine/check-oracle', () => ({
  checkOracleCoverage: (...args: unknown[]) => checkOracleMock(...args),
}))
vi.mock('@/lib/defillama', () => ({ fetchDefiLlamaPrice: vi.fn(async () => null) }))
// [FIX-DCA-NOFEED-FAIL-CLOSED] v3 live on Base — the shape of any chain a user can reach this panel
// on, and the condition the new gate is armed under.
vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return {
    ...actual,
    getOrderExecutorV3: (chainId: number) => (chainId === 8453 ? V3_ADDRESS : null),
  }
})
// The executor's own `tokenUsdFeeds` registry, answering with the REAL Base rows read 2026-09-09:
// WETH and USDC registered, everything else the zero struct (registered: false).
vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: () => ({
    readContract: async ({ args }: { args: readonly unknown[] }) =>
      BASE_REGISTERED[String(args[0]).toLowerCase()] ?? ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false],
  }),
  _clearClientCache: vi.fn(),
}))
vi.mock('@/hooks/useOrderEngine', () => ({
  useOrderEngine: () => ({
    dcaOrders: [], activeOrders: [], historyOrders: [], latestEvent: null, isSubmitting: false,
    createOrder: createOrderMock,
    pendingOrder: null, confirmOrder: vi.fn(), clearPendingOrder: vi.fn(),
    pendingCancel: null, confirmCancel: vi.fn(), clearPendingCancel: vi.fn(),
    cancelOrder: vi.fn(), cancelAllOrders: vi.fn(), removeOrder: vi.fn(),
  }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => <button>Connect</button> }))
vi.mock('@/lib/sounds', () => ({
  playClick: vi.fn(), playTouchMP3: vi.fn(), playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(), startWaitingSound: vi.fn(), stopWaitingSound: vi.fn(),
}))
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: vi.fn() }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: vi.fn() }))
// Output-picker mock: NOT marked "Imported" (category is orthogonal to feed coverage), so the
// separate routability gate (hasImported) never engages — this test is only about the consent gate.
vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected, onSelect, hideNativeInput }: { selected: { symbol?: string } | null; onSelect: (t: unknown) => void; hideNativeInput?: boolean }) => (
    <div data-testid={hideNativeInput ? 'token-selector-in' : 'token-selector-out'}>
      <span>{selected?.symbol ?? 'Select'}</span>
      {!hideNativeInput && (
        <>
          <button
            data-testid="pick-nofeed-output"
            onClick={() => onSelect({
              address: '0x6c240ca4a1a3d8c4c2c7e6b8d6f6e8a4b4c2a2a2', // no Chainlink feed on Base
              symbol: 'ETHFI', name: 'Ether.fi', decimals: 18, logoURI: '', category: 'DeFi', chainId: 8453,
            })}
          >pick-nofeed-output</button>
          <button
            data-testid="pick-feed-output"
            onClick={() => onSelect({
              address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC — feed-covered on Base
              symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '', category: 'Stablecoin', chainId: 8453,
            })}
          >pick-feed-output</button>
        </>
      )}
    </div>
  ),
}))
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div /> }))
vi.mock('./OrderReviewModal', () => ({ default: () => null }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))

import { renderWithProviders, screen, fireEvent, waitFor } from '@/test-utils/render'
import DCAPanel from './DCAPanel'

const ADDRESS = '0x1111111111111111111111111111111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useChainIdMock.mockReturnValue(8453)
  checkOracleMock.mockResolvedValue({ hasOracle: true })
  checkRouteMock.mockResolvedValue({ routable: true })
})

const enterAmount = (v: string) => fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: v } })
const startDca = () => fireEvent.click(screen.getByRole('button', { name: /Start DCA/i }))

describe('DCAPanel [FIX-DCA-NOFEED-FAIL-CLOSED] — the golden ETHFI case, inverted', () => {
  it('an output the executor cannot price is REFUSED — no consent modal, no order', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    enterAmount('1')
    startDca()

    await waitFor(() => expect(screen.getByTestId('dca-submit-block')).toBeInTheDocument())
    expect(createOrderMock).not.toHaveBeenCalled()
    // The consent modal has no DCA path any more — this is the assertion that inverts.
    expect(screen.queryByTestId('nofeed-consent-modal')).not.toBeInTheDocument()
  })

  it('the refusal names the leg and makes no protection claim of its own', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    enterAmount('1')
    startDca()

    const block = await screen.findByTestId('dca-submit-block')
    expect(block.textContent).toMatch(/ETHFI/)
    // The sentence this whole change exists to remove.
    expect(block.textContent).not.toMatch(/not unprotected/i)
    expect(block.textContent).not.toMatch(/referee/i)
  })

  it('a second attempt is refused again — nothing about the first click banks consent', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    enterAmount('1')
    startDca()
    await screen.findByTestId('dca-submit-block')

    enterAmount('2')
    startDca()
    await waitFor(() => expect(screen.getByTestId('dca-submit-block')).toBeInTheDocument())
    expect(createOrderMock).not.toHaveBeenCalled()
  })
})

describe('DCAPanel [FIX-DCA-NOFEED-FAIL-CLOSED] — feed-covered tokens are unaffected', () => {
  it('a registered output still creates the order, and never sees a modal', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-feed-output'))
    enterAmount('1')
    startDca()

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('nofeed-consent-modal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dca-submit-block')).not.toBeInTheDocument()
  })

  it('the DEFAULT output (native ETH) is no longer refused — it resolves to a registered token', async () => {
    // [fix/dca-native-out-signs-weth] PREMISE CHANGED — this test previously read "the DEFAULT
    // output (native ETH) is refused — the 0xEeee… sentinel is what gets SIGNED" and asserted the
    // block. That was correct while `order.tokenOut` really was the sentinel: unregistered on Base
    // (`tokenUsdFeeds(0xEeee…)` → registered:false, re-read 2026-09-09), so the gate refused it.
    //
    // The sentinel is no longer what gets signed. DCAPanel resolves a native buy leg to the chain's
    // WRAPPED native BEFORE the struct is built (its `tokenOut` memo → resolveSignableToken), and
    // that address IS registered (`tokenUsdFeeds(0x4200…0006)` → registered:true). So the gate now
    // asks about a token the executor can price and correctly lets it through.
    //
    // This is NOT the gate going fail-open: the fail-closed behaviour it exists for is pinned
    // unchanged by the `pick-nofeed-output` cases above, which still refuse ETHFI. What changed is
    // the address being asked about, and it changed because the SIGNED address changed with it —
    // which is exactly the address fidelity `executor-feed-registry.ts` requires.
    renderWithProviders(<DCAPanel />)
    enterAmount('1')
    startDca()

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('dca-submit-block')).not.toBeInTheDocument()
  })
})
