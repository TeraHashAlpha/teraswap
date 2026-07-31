// @vitest-environment jsdom
/**
 * [FIX-DCA-NOFEED-CONSENT] DCAPanel + NoFeedConsentModal — the no-price-feed output consent gate.
 *
 * Golden case: ETHFI (or any output token absent from CHAINLINK_FEEDS_BY_CHAIN) must show the
 * consent modal BEFORE signing; Accept proceeds to createOrder, Reject cancels with nothing
 * signed. A feed-covered output (WETH/USDC/DAI on Base) must NEVER see the modal — byte-identical
 * to the pre-existing submit path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 8453)
const createOrderMock = vi.fn()
const checkRouteMock = vi.fn()
const checkOracleMock = vi.fn()

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

describe('DCAPanel [FIX-DCA-NOFEED-CONSENT] — the golden ETHFI case', () => {
  it('shows the consent modal for a no-feed output, and Accept proceeds to sign', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    enterAmount('1')

    expect(screen.queryByTestId('nofeed-consent-modal')).not.toBeInTheDocument()
    startDca()

    const modal = await screen.findByTestId('nofeed-consent-modal')
    expect(modal).toBeInTheDocument()
    expect(createOrderMock).not.toHaveBeenCalled() // nothing signed while the modal is up

    fireEvent.click(screen.getByTestId('nofeed-consent-accept'))
    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('nofeed-consent-modal')).not.toBeInTheDocument()
  })

  it('Reject cancels — nothing signed, modal closes, back on the panel', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    enterAmount('1')
    startDca()

    await screen.findByTestId('nofeed-consent-modal')
    fireEvent.click(screen.getByTestId('nofeed-consent-reject'))

    expect(screen.queryByTestId('nofeed-consent-modal')).not.toBeInTheDocument()
    expect(createOrderMock).not.toHaveBeenCalled()
  })
})

describe('DCAPanel [FIX-DCA-NOFEED-CONSENT] — feed-covered tokens are byte-identical', () => {
  it('a feed-covered output NEVER shows the modal — signs immediately like before this fix', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-feed-output'))
    enterAmount('1')
    startDca()

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('nofeed-consent-modal')).not.toBeInTheDocument()
  })

  it('the default output token (native ETH, feed-covered) never shows the modal', async () => {
    renderWithProviders(<DCAPanel />)
    enterAmount('1')
    startDca()

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('nofeed-consent-modal')).not.toBeInTheDocument()
  })
})

describe('DCAPanel [FIX-DCA-NOFEED-CONSENT] — consent is required per-creation, not persisted', () => {
  it('a second order to the SAME no-feed token asks for consent again after a successful submit', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    enterAmount('1')
    startDca()
    await screen.findByTestId('nofeed-consent-modal')
    fireEvent.click(screen.getByTestId('nofeed-consent-accept'))
    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))

    // Same token still selected; place another order — must ask again (no "don't show again").
    enterAmount('2')
    startDca()
    expect(await screen.findByTestId('nofeed-consent-modal')).toBeInTheDocument()
  })
})

describe('NoFeedConsentModal [FIX-DCA-NOFEED-CONSENT] — plain-language copy, zero jargon', () => {
  const JARGON_DENYLIST = [/\boracle\b/i, /\bfeed\b/i, /\bslippage\b/i, /\bminamountout\b/i, /\bminimumoutput\b/i]

  it('title + body contain none of the technical terms on the denylist', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    enterAmount('1')
    startDca()

    const title = await screen.findByTestId('nofeed-consent-title')
    const body = screen.getByTestId('nofeed-consent-body')
    const text = `${title.textContent} ${body.textContent}`
    for (const term of JARGON_DENYLIST) {
      expect(text).not.toMatch(term)
    }
  })

  it('names the token symbol in the title', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    enterAmount('1')
    startDca()
    const title = await screen.findByTestId('nofeed-consent-title')
    expect(title.textContent).toMatch(/ETHFI/)
  })
})
