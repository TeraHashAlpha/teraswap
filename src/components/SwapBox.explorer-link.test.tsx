// @vitest-environment jsdom
/**
 * [fix/tx-links-remaining] SwapBox's tx-explorer links (pending + success) and its success-toast
 * must point at the chain the tx was actually SENT on (`useSwap`'s `txChainId`) — never the wallet's
 * CURRENT chain at render time. The old `ETHERSCAN_TX` constant always pointed at etherscan.io, so a
 * Base/Arbitrum tx linked to a page where it doesn't exist; `txChainId` fixes that, and this file
 * pins the harder case: the wallet switches chains AFTER the tx was sent, while it's still pending
 * or showing success, and the link must not repaint to the new chain.
 *
 * Mock boilerplate duplicated from SwapBox.test.tsx (established convention for a
 * concern-specific SwapBox test file — see SwapBox.price-tiers.test.tsx), with one addition:
 * @/components/ToastProvider is mocked with a spy (not the real provider) so the success toast's
 * `chainId` argument can be asserted directly.
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

// ─── Toast — spy, not the real provider, so the success toast's `chainId` arg is assertable ───
const toastSpy = vi.fn(() => 'toast-id')
vi.mock('@/components/ToastProvider', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), update: vi.fn() }),
}))

// ─── Child components ───
vi.mock('./TokenSelector', () => ({
  default: ({ selected, onSelect }: { selected: { symbol?: string } | null; onSelect: (t: unknown) => void }) => (
    <button data-testid="token-selector" onClick={() => onSelect({ symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 })}>
      {selected?.symbol ?? 'Select'}
    </button>
  ),
}))
vi.mock('./QuoteBreakdown', () => ({ default: () => <div data-testid="quote-breakdown" /> }))
vi.mock('./SwapButton', () => ({
  default: (p: { priceBlocked?: boolean; blockReason?: string }) => (
    <button data-testid="swap-button" data-blocked={String(!!p.priceBlocked)} data-reason={p.blockReason ?? ''}>Swap</button>
  ),
}))
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
vi.mock('@/components/TokenAddressBadge', () => ({ default: () => null }))
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

import { renderWithProviders, screen, act } from '@/test-utils/render'
import SwapBox from './SwapBox'
import { findToken } from '@/lib/tokens'

function testIdentity(chainId = 1) {
  const tin = findToken('ETH')!
  const tout = findToken('USDC')!
  return {
    chainId,
    tokenIn: tin.address.toLowerCase(),
    tokenOut: tout.address.toLowerCase(),
    amountRaw: '1000000000000000000',
    decimalsIn: tin.decimals,
    decimalsOut: tout.decimals,
    fetchedAt: Date.now(),
  }
}

function setHookDefaults() {
  useQuoteMock.mockReturnValue({ meta: null, loading: false, error: null, countdown: 0, refetch: vi.fn(), refresh: vi.fn() })
  useSwapMock.mockReturnValue({
    status: 'idle', txHash: null, txChainId: undefined, errorMessage: null, cowOrderUid: null,
    priceGuardBlocked: false, priceGuardDeviation: 0, simulationPassed: true,
    pendingSwap: null, mevSurplusActualWei: null,
    execute: vi.fn(), confirmSwap: vi.fn(), reset: vi.fn(),
  })
  useApprovalMock.mockReturnValue({
    plan: null, status: 'idle', error: null, approve: vi.fn(), isReady: true,
    needsPermit2Education: false, confirmPermit2Education: vi.fn(), cancelPermit2Education: vi.fn(),
  })
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
  mockIsConnected = true
  mockChainId = 1
  setHookDefaults()
})

const EXPLORER_HOST: Record<number, string> = { 1: 'etherscan.io', 8453: 'basescan.org', 42161: 'arbiscan.io' }

describe('SwapBox: [fix/tx-links-remaining] pending tx link is chain-aware, not etherscan-only', () => {
  it.each([1, 8453, 42161])('a tx sent on chain %i links to its own explorer while swapping', (sentChainId) => {
    useSwapMock.mockReturnValue({
      status: 'swapping', txHash: '0xabc', txChainId: sentChainId, errorMessage: null, cowOrderUid: null,
      priceGuardBlocked: false, priceGuardDeviation: 0, simulationPassed: true,
      pendingSwap: null, mevSurplusActualWei: null,
      execute: vi.fn(), confirmSwap: vi.fn(), reset: vi.fn(),
    })
    renderWithProviders(<SwapBox />, { toast: false })
    const link = screen.getByText(/track on explorer/i).closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe(EXPLORER_HOST[sentChainId])
  })

  it.each([
    [1, 8453], [8453, 42161], [42161, 1],
  ])('sent on chain %i, wallet switched to %i afterward → link stays on the SENT chain, not the new one', (sentChainId, switchedToChainId) => {
    useSwapMock.mockReturnValue({
      status: 'swapping', txHash: '0xabc', txChainId: sentChainId, errorMessage: null, cowOrderUid: null,
      priceGuardBlocked: false, priceGuardDeviation: 0, simulationPassed: true,
      pendingSwap: null, mevSurplusActualWei: null,
      execute: vi.fn(), confirmSwap: vi.fn(), reset: vi.fn(),
    })
    mockChainId = switchedToChainId // wallet's current/active chain — must NOT drive the link
    renderWithProviders(<SwapBox />, { toast: false })
    const link = screen.getByText(/track on explorer/i).closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe(EXPLORER_HOST[sentChainId])
    expect(new URL(link.href).hostname).not.toBe(EXPLORER_HOST[switchedToChainId])
  })
})

describe('SwapBox: [fix/tx-links-remaining] success tx link is chain-aware, not etherscan-only', () => {
  it.each([1, 8453, 42161])('a tx sent on chain %i links to its own explorer on success', (sentChainId) => {
    useSwapMock.mockReturnValue({
      status: 'success', txHash: '0xdef', txChainId: sentChainId, errorMessage: null, cowOrderUid: null,
      priceGuardBlocked: false, priceGuardDeviation: 0, simulationPassed: true,
      pendingSwap: null, mevSurplusActualWei: null,
      execute: vi.fn(), confirmSwap: vi.fn(), reset: vi.fn(),
    })
    renderWithProviders(<SwapBox />, { toast: false })
    const link = screen.getByText(/view on explorer/i).closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe(EXPLORER_HOST[sentChainId])
  })

  it('sent on Base (8453), wallet switched to Arbitrum (42161) afterward → success link stays on basescan.org', () => {
    useSwapMock.mockReturnValue({
      status: 'success', txHash: '0xdef', txChainId: 8453, errorMessage: null, cowOrderUid: null,
      priceGuardBlocked: false, priceGuardDeviation: 0, simulationPassed: true,
      pendingSwap: null, mevSurplusActualWei: null,
      execute: vi.fn(), confirmSwap: vi.fn(), reset: vi.fn(),
    })
    mockChainId = 42161
    renderWithProviders(<SwapBox />, { toast: false })
    const link = screen.getByText(/view on explorer/i).closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe('basescan.org')
  })
})

describe('SwapBox: [fix/tx-links-remaining] success toast carries the SENT chain, not the live wallet chain', () => {
  function quoteMetaWithBest(identityChainId: number) {
    return {
      meta: { best: { source: '1inch', toAmount: '2950000000', estimatedGas: 200_000, gasUsd: 10, routes: [], tx: { to: '0x0', data: '0x', value: '0', gas: 200000 } }, all: [], fetchedAt: Date.now(), identity: testIdentity(identityChainId) },
      loading: false, error: null, countdown: 0, refetch: vi.fn(), refresh: vi.fn(),
    }
  }

  it('swap sent on Base (8453), wallet switched to Arbitrum (42161) by the time success renders → toast chainId is 8453', async () => {
    // The quote identity must match the CURRENT active chain (42161, post-switch) for SwapBox's
    // own quote/selection scoping to accept it — that scoping is unrelated to this test, which only
    // pins txChainId (the SEND-time chain, from useSwap) flowing into the toast untouched by it.
    useQuoteMock.mockReturnValue(quoteMetaWithBest(42161))
    useSwapMock.mockReturnValue({
      status: 'success', txHash: '0xdef', txChainId: 8453, errorMessage: null, cowOrderUid: null,
      priceGuardBlocked: false, priceGuardDeviation: 0, simulationPassed: true,
      pendingSwap: null, mevSurplusActualWei: null,
      execute: vi.fn(), confirmSwap: vi.fn(), reset: vi.fn(),
    })
    mockChainId = 42161 // the LIVE wallet chain at render time — must not leak into the toast
    await act(async () => { renderWithProviders(<SwapBox />, { toast: false }) })
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ txHash: '0xdef', chainId: 8453 }))
  })
})
