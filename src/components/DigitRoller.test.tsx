// @vitest-environment jsdom
/**
 * [P192] DigitRoller — unit tests + SwapBox integration smoke tests.
 *
 * The roller renders 10 digits (0–9) per column and offsets the stack with
 * a transform, so every digit char is always present in the DOM regardless
 * of the active value. Assertions therefore target structure (column /
 * separator counts, ordering, fallbacks) rather than which digit is
 * "visible" — visibility is a transform, not a mount/unmount.
 *
 * `useReducedMotion` is mocked through a hoisted, mutable flag so individual
 * tests can flip it. Under reduced motion the columns carry no `exit` prop,
 * which makes AnimatePresence removals synchronous — used by the transition
 * tests for deterministic column counts.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

const { reducedMotionState } = vi.hoisted(() => ({ reducedMotionState: { value: false } }))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => reducedMotionState.value }
})

import { render, screen } from '@/test-utils/render'
import DigitRoller, { LINE_HEIGHT_PX } from '@/components/DigitRoller'

afterEach(() => {
  reducedMotionState.value = false
})

describe('DigitRoller — rendering', () => {
  it('renders every digit of the formatted value', () => {
    const { container } = render(<DigitRoller value="1 975.6553" />)
    for (const d of ['1', '9', '7', '5', '6', '3']) {
      expect(container.textContent).toContain(d)
    }
  })

  it('renders the prefix before the digit columns', () => {
    const { container } = render(<DigitRoller value="123" prefix="~" />)
    expect(container.textContent).toContain('~')
    // Prefix is the very first rendered glyph.
    expect(container.textContent?.startsWith('~')).toBe(true)
  })

  it('renders separators as static spans without a transform', () => {
    render(<DigitRoller value="1 975.65" />)
    const separators = screen.getAllByTestId('digit-separator')
    // Space + dot = 2 separators.
    expect(separators).toHaveLength(2)
    for (const sep of separators) {
      const style = sep.getAttribute('style')
      expect(style === null || !style.includes('transform')).toBe(true)
    }
  })

  it('renders the "—" fallback as static text with no roller columns', () => {
    const { container } = render(<DigitRoller value="—" />)
    expect(container.textContent).toContain('—')
    expect(screen.queryAllByTestId('digit-column')).toHaveLength(0)
  })

  it('renders an empty value without crashing and without columns/separators', () => {
    const { container } = render(<DigitRoller value="" />)
    expect(container).toBeInTheDocument()
    expect(screen.queryAllByTestId('digit-column')).toHaveLength(0)
    expect(screen.queryAllByTestId('digit-separator')).toHaveLength(0)
  })

  it('renders exactly one column per digit and none for separators', () => {
    render(<DigitRoller value="1 234.56" />)
    // 1,2,3,4,5,6 -> 6 columns; space + dot -> not columns.
    expect(screen.getAllByTestId('digit-column')).toHaveLength(6)
    expect(screen.getAllByTestId('digit-separator')).toHaveLength(2)
  })
})

describe('DigitRoller — accessibility [34-L-01]', () => {
  it('exposes the formatted value via aria-label so screen readers announce the number, not all 10 digits per column', () => {
    const { container } = render(<DigitRoller value="1 975.6553" prefix="~" />)
    const wrapper = container.querySelector('.tabular-nums')

    // The accessible name is the prefix + formatted value — not the
    // 0–9 stack inside every DigitColumn.
    const label = wrapper?.getAttribute('aria-label')
    expect(label).toContain('1 975.6553')
    expect(label).toBe('~1 975.6553')
    expect(wrapper).toHaveAttribute('role', 'text')

    // Each digit roller is removed from the a11y tree; the parent label
    // already carries the value, so columns must not be read out.
    for (const col of screen.getAllByTestId('digit-column')) {
      expect(col).toHaveAttribute('aria-hidden', 'true')
    }
  })
})

describe('DigitRoller — value transitions', () => {
  it('shrinks the column count when the value gets shorter', () => {
    // Reduced motion makes AnimatePresence removals synchronous.
    reducedMotionState.value = true
    const { rerender } = render(<DigitRoller value="1 975.6553" />)
    expect(screen.getAllByTestId('digit-column')).toHaveLength(8)

    rerender(<DigitRoller value="0.01" />)
    expect(screen.getAllByTestId('digit-column')).toHaveLength(3)
    expect(screen.queryByTestId('digit-separator')).toBeInTheDocument()
  })

  it('grows the column count when the value gets longer', () => {
    reducedMotionState.value = true
    const { rerender } = render(<DigitRoller value="0.5" />)
    expect(screen.getAllByTestId('digit-column')).toHaveLength(2)

    rerender(<DigitRoller value="12 345.6789" />)
    expect(screen.getAllByTestId('digit-column')).toHaveLength(9)
  })

  it('does not crash when re-rendered with an identical value', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(<DigitRoller value="1.23" />)
    rerender(<DigitRoller value="1.23" />)
    expect(screen.getAllByTestId('digit-column')).toHaveLength(3)
    // No React key warning on the stable re-render.
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('DigitRoller — reduced motion', () => {
  it('still renders all digits when prefers-reduced-motion is set', () => {
    reducedMotionState.value = true
    render(<DigitRoller value="1.23" />)
    // 1, 2, 3 -> 3 columns, dot -> 1 separator.
    expect(screen.getAllByTestId('digit-column')).toHaveLength(3)
    expect(screen.getAllByTestId('digit-separator')).toHaveLength(1)
  })
})

describe('DigitRoller — constants & snapshot', () => {
  it('exports LINE_HEIGHT_PX = 32', () => {
    expect(LINE_HEIGHT_PX).toBe(32)
  })

  it('matches the structural snapshot', () => {
    const { container } = render(<DigitRoller value="1 234.56" prefix="~" />)
    expect(container.firstChild).toMatchSnapshot()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// SwapBox integration smoke tests.
//
// SwapBox wires ~10 hooks + 7 child components; we mock that whole boundary
// (mirroring src/components/SwapBox.test.tsx) so we can verify the roller is
// actually rendered in the Receive field — but the REAL DigitRoller and the
// real Framer Motion `motion`/`AnimatePresence` are kept (only
// `useReducedMotion` is stubbed by the file-level mock above).
// ─────────────────────────────────────────────────────────────────────────

let mockIsConnected = true
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({
    address: mockIsConnected ? '0x1111111111111111111111111111111111111111' : undefined,
    isConnected: mockIsConnected,
    chain: { id: 1, name: 'mainnet' },
  })),
  useBalance: vi.fn(() => ({
    data: { value: 10n ** 18n, decimals: 18, symbol: 'ETH', formatted: '1.0' },
    isLoading: false,
    isError: false,
  })),
}))

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

vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected }: { selected: { symbol?: string } | null }) => (
    <button data-testid="token-selector">{selected?.symbol ?? 'Select'}</button>
  ),
}))
vi.mock('@/components/QuoteBreakdown', () => ({ default: () => <div data-testid="quote-breakdown" /> }))
vi.mock('@/components/SwapButton', () => ({ default: () => <button data-testid="swap-button">Swap</button> }))
vi.mock('@/components/TransactionPreview', () => ({ default: () => <div data-testid="tx-preview" /> }))
vi.mock('@/components/SlippageModal', () => ({
  default: () => <div data-testid="slippage-modal" />,
  calculateAutoSlippage: () => 0.3,
}))
vi.mock('@/components/SourceToggle', () => ({ default: () => <div data-testid="source-toggle" /> }))
vi.mock('@/components/ActiveApprovals', () => ({ default: () => <div data-testid="active-approvals" /> }))
vi.mock('@/components/Permit2EducationModal', () => ({ default: () => null, isPermit2Educated: () => true }))
vi.mock('@/components/TokenAddressBadge', () => ({ default: () => null }))
vi.mock('@/components/SplitRouteVisualizer', () => ({ default: () => <div data-testid="split-visualizer" /> }))
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => null }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: vi.fn() }))
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
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: vi.fn() }))
vi.mock('@/lib/wallet-activity-tracker', () => ({ trackWalletActivity: vi.fn() }))
vi.mock('@/lib/mev-savings', () => ({ estimateMevSavings: () => 0 }))
vi.mock('@/lib/mev-preference', () => ({
  selectBestWithMevPreference: (rawMeta: unknown) => ({
    meta: rawMeta ?? null,
    smartMevApplied: false,
    mevExposedBest: false,
  }),
}))

function setSwapHookDefaults() {
  useQuoteMock.mockReturnValue({ meta: null, loading: false, error: null, countdown: 0, refetch: vi.fn(), refresh: vi.fn() })
  useSwapMock.mockReturnValue({
    status: 'idle', txHash: null, errorMessage: null, cowOrderUid: null,
    priceGuardBlocked: false, priceGuardDeviation: 0, simulationPassed: true,
    pendingSwap: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), reset: vi.fn(),
  })
  useApprovalMock.mockReturnValue({
    plan: null, status: 'idle', error: null, approve: vi.fn(), isReady: true,
    needsPermit2Education: false, confirmPermit2Education: vi.fn(), cancelPermit2Education: vi.fn(),
  })
  useChainlinkPriceMock.mockReturnValue({
    chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false,
  })
  useDepegCheckMock.mockReturnValue({ mode: 'ok', divergence: 0, symbol: '', message: null }) // [SPRINT-9W-oracle]
  useSplitRouteMock.mockReturnValue({ splitResult: null, analyzing: false, splitRecommended: false, useSplit: false, toggleSplit: vi.fn() })
  useSplitSwapMock.mockReturnValue({ status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, execute: vi.fn(), reset: vi.fn() })
  useSwapHistoryMock.mockReturnValue({ addRecord: vi.fn(), history: [] })
  useActiveApprovalsMock.mockReturnValue({ addApproval: vi.fn(), activeApprovals: [], removeApproval: vi.fn() })
  useEthGasCostMock.mockReturnValue({ ethPrice: 3000, gasPriceGwei: 20, estimate: () => ({ eth: 0.004, usd: 12 }) })
}

import { renderWithProviders, fireEvent, act } from '@/test-utils/render'
import SwapBox from '@/components/SwapBox'

describe('SwapBox integration — DigitRoller wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockIsConnected = true
    reducedMotionState.value = false
    setSwapHookDefaults()
  })

  it('renders the DigitRoller (with ~ prefix and digits) when a quote is loaded', async () => {
    useQuoteMock.mockReturnValue({
      meta: {
        best: { source: '1inch', toAmount: '3000000000', estimatedGas: 200_000, gasUsd: 10, routes: [], tx: { to: '0x0', data: '0x', value: '0', gas: 200000 } },
        all: [],
        fetchedAt: Date.now(),
      },
      loading: false, error: null, countdown: 10, refetch: vi.fn(), refresh: vi.fn(),
    })
    const { container } = renderWithProviders(<SwapBox />)
    const input = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!
    await act(async () => {
      fireEvent.change(input, { target: { value: '1' } })
    })

    // The roller is mounted (digit columns present) with the static ~ prefix.
    expect(screen.getAllByTestId('digit-column').length).toBeGreaterThan(0)
    expect(container.querySelector('.tabular-nums')).toBeInTheDocument()
    expect(container.textContent).toContain('~')
  })

  it('shows the loading pulse and no DigitRoller while a quote is loading', () => {
    useQuoteMock.mockReturnValue({ meta: null, loading: true, error: null, countdown: 0, refetch: vi.fn(), refresh: vi.fn() })
    renderWithProviders(<SwapBox />)

    expect(screen.getByText('...')).toBeInTheDocument()
    expect(screen.queryAllByTestId('digit-column')).toHaveLength(0)
  })
})
