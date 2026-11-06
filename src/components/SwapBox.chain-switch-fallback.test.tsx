// @vitest-environment jsdom
/**
 * [fix/chain-switch-token-fallback] SwapBox — a chain switch never leaves a foreign-chain token on screen.
 *
 * SwapBox wires together ~10 hooks + 7 child components. We mock the
 * entire dependency boundary so the tests pin orchestration behavior
 * (initial render, flip arrow, amount input, slippage modal toggle,
 * disconnect state, error surface) without coupling to internals
 * already exercised by the per-hook tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Wagmi ───
let mockIsConnected = true
let mockChainId = 1
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({
    address: mockIsConnected ? '0x1111111111111111111111111111111111111111' : undefined,
    isConnected: mockIsConnected,
    chain: { id: mockChainId, name: 'chain' },
  })),
  useBalance: vi.fn(() => ({
    data: { value: 10n ** 18n, decimals: 18, symbol: 'ETH', formatted: '1.0' },
    isLoading: false,
    isError: false,
  })),
}))

// ─── Hooks ───
const useQuoteMock = vi.fn()
const useSwapMock = vi.fn()
const useApprovalMock = vi.fn()
const useChainlinkPriceMock = vi.fn()
const useDepegCheckMock = vi.fn()
const useSplitRouteMock = vi.fn()
const useSplitSwapMock = vi.fn()
const useSwapHistoryMock = vi.fn()
const useActiveApprovalsMock = vi.fn()
const useEthGasCostMock = vi.fn()

vi.mock('@/hooks/useQuote', () => ({ useQuote: (...a: unknown[]) => useQuoteMock(...a) }))
vi.mock('@/hooks/useSwap', () => ({ useSwap: (...a: unknown[]) => useSwapMock(...a) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: (...a: unknown[]) => useApprovalMock(...a) }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: (...a: unknown[]) => useChainlinkPriceMock(...a) }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: (...a: unknown[]) => useDepegCheckMock(...a) }))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: (...a: unknown[]) => useSplitRouteMock(...a) }))
vi.mock('@/hooks/useSplitSwap', () => ({ useSplitSwap: (...a: unknown[]) => useSplitSwapMock(...a) }))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => useSwapHistoryMock() }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => useActiveApprovalsMock() }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => useEthGasCostMock() }))

// ─── Child components ───
// Each selector exposes the token it currently shows; a click "picks" whatever `pick` currently holds.
const pick: { token: unknown } = { token: null }
vi.mock('./TokenSelector', () => ({
  default: ({ selected, onSelect }: { selected: { symbol?: string; address?: string } | null; onSelect: (t: unknown) => void }) => (
    <button data-testid="token-selector" data-address={selected?.address ?? ''} data-symbol={selected?.symbol ?? ''} onClick={() => onSelect(pick.token)}>
      {selected?.symbol ?? 'Select'}
    </button>
  ),
}))
vi.mock('./QuoteBreakdown', () => ({ default: () => <div data-testid="quote-breakdown" /> }))
// [SPRINT-9J J1] Expose the gate props so tests can assert the wiring
// (priceBlocked + blockReason) without rendering the real button's wagmi deps.
vi.mock('./SwapButton', () => ({
  default: (p: { priceBlocked?: boolean; blockReason?: string }) => (
    <button data-testid="swap-button" data-blocked={String(!!p.priceBlocked)} data-reason={p.blockReason ?? ''}>Swap</button>
  ),
}))
// [SPRINT-9R R2] Echo the value props so a test can assert the modal renders the FROZEN
// pendingSwap snapshot (calldata/source/send/receive), independent of live quote state.
vi.mock('./TransactionPreview', () => ({ default: (p: { calldata?: string; source?: string; amountInDisplay?: string; expectedOutput?: string }) => (
  <div data-testid="tx-preview" data-calldata={p.calldata ?? ''} data-source={p.source ?? ''} data-amount-in={p.amountInDisplay ?? ''} data-expected-out={p.expectedOutput ?? ''} />
) }))
vi.mock('./SlippageModal', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="slippage-modal">
      <button onClick={onClose}>Close</button>
    </div>
  ),
  calculateAutoSlippage: () => 0.3,
}))
vi.mock('./SourceToggle', () => ({ default: () => <div data-testid="source-toggle" /> }))
vi.mock('./ActiveApprovals', () => ({ default: () => <div data-testid="active-approvals" /> }))
vi.mock('@/components/Permit2EducationModal', () => ({
  default: () => null,
  isPermit2Educated: () => true,
}))
vi.mock('./SplitRouteVisualizer', () => ({ default: () => <div data-testid="split-visualizer" /> }))
vi.mock('./BetaDisclaimer', () => ({ default: () => null }))
vi.mock('./ParticleNetwork', () => ({ setParticleTurbo: vi.fn() }))

// ─── Sounds + analytics + wallet-activity ───
vi.mock('@/lib/sounds', () => ({
  playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(),
  playSwapInitiated: vi.fn(),
  playApproval: vi.fn(),
  playError: vi.fn(),
  playQuoteReceived: vi.fn(),
  startWaitingSound: vi.fn(),
  stopWaitingSound: vi.fn(),
}))
vi.mock('@/lib/analytics', () => ({
  updateSwapStatus: vi.fn(),
}))
vi.mock('@/lib/wallet-activity-tracker', () => ({
  trackWalletActivity: vi.fn(),
}))
vi.mock('@/lib/mev-savings', () => ({
  estimateMevSavings: () => 0,
}))
vi.mock('@/lib/mev-preference', () => ({
  selectBestWithMevPreference: (rawMeta: unknown) => ({
    meta: rawMeta ?? null,
    smartMevApplied: false,
    mevExposedBest: false,
  }),
}))

import { renderWithProviders, screen, fireEvent } from '@/test-utils/render'
import SwapBox from './SwapBox'
import { findToken } from '@/lib/tokens'
import { getDefaultPair, findChainToken } from '@/lib/chains/tokens'
import { useDisconnectedChainSelection } from '@/hooks/useChainId'

const ARB = 42161
const BASE = 8453
const IMPORTED_WARNING = 'Imported token — verify the address before trading'

function setHookDefaults() {
  useQuoteMock.mockReturnValue({ meta: null, loading: false, error: null, countdown: 0, refetch: vi.fn(), refresh: vi.fn() })
  useSwapMock.mockReturnValue({ status: 'idle', txHash: null, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: 0, simulationPassed: true, pendingSwap: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), reset: vi.fn() })
  useApprovalMock.mockReturnValue({ plan: null, status: 'idle', error: null, approve: vi.fn(), isReady: true, needsPermit2Education: false, confirmPermit2Education: vi.fn(), cancelPermit2Education: vi.fn() })
  useChainlinkPriceMock.mockReturnValue({ chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false })
  useDepegCheckMock.mockReturnValue({ mode: 'ok', divergence: 0, symbol: '', message: null })
  useSplitRouteMock.mockReturnValue({ splitResult: null, analyzing: false, splitRecommended: false, useSplit: false, toggleSplit: vi.fn() })
  useSplitSwapMock.mockReturnValue({ status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, execute: vi.fn(), reset: vi.fn() })
  useSwapHistoryMock.mockReturnValue({ addRecord: vi.fn(), history: [] })
  useActiveApprovalsMock.mockReturnValue({ addApproval: vi.fn(), activeApprovals: [], removeApproval: vi.fn() })
  useEthGasCostMock.mockReturnValue({ ethPrice: 3000, gasPriceGwei: 20, estimate: () => ({ eth: 0.004, usd: 12 }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  // A visitor without a wallet browsing the chain they picked in ChainSelector (quote-before-wallet): the chain comes
  // from the disconnected-selection store, and quoting is enabled on any chain (no wallet to be on the wrong one).
  mockIsConnected = false
  mockChainId = 1
  useDisconnectedChainSelection.getState().setChainId(null)
  pick.token = null
  setHookDefaults()
})

/** What the selectors (sell, receive) currently show. */
const shown = () => {
  const [sell, receive] = screen.getAllByTestId('token-selector')
  return { sell: sell.getAttribute('data-address')!.toLowerCase(), receive: receive.getAttribute('data-address')!.toLowerCase() }
}
/** The (tokenIn, tokenOut) useQuote was handed on its most recent render. */
const lastQuotePair = () => {
  const [tin, tout] = useQuoteMock.mock.calls[useQuoteMock.mock.calls.length - 1] as [{ address: string } | null, { address: string } | null]
  return { tin: tin?.address.toLowerCase() ?? null, tout: tout?.address.toLowerCase() ?? null }
}

describe('SwapBox — chain switch with a token that has no home on the target chain [fix/chain-switch-token-fallback]', () => {
  const SNX = findToken('SNX')!
  const SNX_MAINNET = SNX.address.toLowerCase()

  it('switch 1 → 42161 with SNX/USDC selected → Arbitrum default pair, no ⚠ badge, a quote is requested for the default pair', () => {
    pick.token = SNX
    const { rerender } = renderWithProviders(<SwapBox />)
    fireEvent.click(screen.getAllByTestId('token-selector')[0]) // sell SNX
    expect(shown().sell).toBe(SNX_MAINNET)

    useDisconnectedChainSelection.getState().setChainId(ARB)
    rerender(<SwapBox />)

    const dflt = getDefaultPair(ARB)
    expect(shown()).toEqual({ sell: dflt.tokenIn!.address.toLowerCase(), receive: dflt.tokenOut!.address.toLowerCase() })
    expect(shown().receive).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831')
    expect(screen.queryByTitle(IMPORTED_WARNING)).toBeNull() // no ⚠
    expect(lastQuotePair()).toEqual({ tin: shown().sell, tout: shown().receive }) // quote for the default pair…
    expect(useQuoteMock.mock.calls[useQuoteMock.mock.calls.length - 1][3]).toBe(true) // …and enabled
    expect(document.body.textContent).not.toContain('c011')
  })

  it('a stale {SNX mainnet, DAI mainnet} pair arriving on Base ends as the Base default pair', () => {
    const DAI = findToken('DAI')!
    pick.token = SNX
    const { rerender } = renderWithProviders(<SwapBox />)
    fireEvent.click(screen.getAllByTestId('token-selector')[0])
    pick.token = DAI
    fireEvent.click(screen.getAllByTestId('token-selector')[1])
    expect(shown()).toEqual({ sell: SNX_MAINNET, receive: DAI.address.toLowerCase() })

    useDisconnectedChainSelection.getState().setChainId(BASE)
    rerender(<SwapBox />)

    const dflt = getDefaultPair(BASE)
    expect(shown()).toEqual({ sell: dflt.tokenIn!.address.toLowerCase(), receive: dflt.tokenOut!.address.toLowerCase() })
    for (const a of Object.values(shown())) expect(findChainToken(a, BASE)).not.toBeNull()
    expect(screen.queryByTitle(IMPORTED_WARNING)).toBeNull()
  })

  it('mainnet is untouched: the SNX/USDC selection survives when the chain does not change', () => {
    pick.token = SNX
    const { rerender } = renderWithProviders(<SwapBox />)
    fireEvent.click(screen.getAllByTestId('token-selector')[0])
    rerender(<SwapBox />)
    expect(shown().sell).toBe(SNX_MAINNET)
  })
})
