// @vitest-environment jsdom
/**
 * [feat/swap-price-tiers] SwapBox — the client side of the swap price tiers (owner D1–D4, 2026-10-26).
 *
 * Same mocked dependency boundary as SwapBox.test.tsx, plus: useSwapPriceTier is mocked per tier, the
 * TokenSelector mock picks an EXOTIC pair (no stable, no ETH, no Chainlink feed — the pair the old
 * `valueUnverifiable` block refused at any size), the SwapButton mock wires onSwap, QuoteBreakdown echoes
 * the tier it received, and the consent dialog renders for real.
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
const useSwapPriceTierMock = vi.fn()
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: (...a: unknown[]) => useSwapPriceTierMock(...a) }))

// ─── Child components ───
let nextPick: { symbol: string; address: string; decimals: number; name?: string; logoURI?: string; category?: string } = { symbol: 'XIN', address: '0x0000000000000000000000000000000000001234', decimals: 18 }
vi.mock('./TokenSelector', () => ({
  default: ({ selected, onSelect }: { selected: { symbol?: string } | null; onSelect: (t: unknown) => void }) => (
    <button data-testid="token-selector" onClick={() => onSelect({ name: nextPick.symbol, logoURI: '', category: 'Other', ...nextPick })}>
      {selected?.symbol ?? 'Select'}
    </button>
  ),
}))
// [chore/copy-leftovers] Echo stub by default; `useRealQuoteBreakdown` swaps in the real component so the
// notice matrix below sees SwapBox's and QuoteBreakdown's notices together, exactly as production renders them.
let useRealQuoteBreakdown = false
vi.mock('./QuoteBreakdown', async () => {
  const actual = await vi.importActual<typeof import('./QuoteBreakdown')>('./QuoteBreakdown')
  const Real = actual.default
  return {
    default: (p: React.ComponentProps<typeof Real>) =>
      useRealQuoteBreakdown ? <Real {...p} /> : <div data-testid="quote-breakdown" data-tier={p.priceTier?.tier ?? ''} />,
  }
})
// [SPRINT-9J J1] Expose the gate props so tests can assert the wiring
// (priceBlocked + blockReason) without rendering the real button's wagmi deps.
vi.mock('./SwapButton', () => ({
  default: (p: { priceBlocked?: boolean; blockReason?: string; onSwap?: () => void }) => (
    <button data-testid="swap-button" data-blocked={String(!!p.priceBlocked)} data-reason={p.blockReason ?? ''} onClick={p.onSwap}>Swap</button>
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

import { renderWithProviders, fireEvent, screen, act } from '@/test-utils/render'
import SwapBox from './SwapBox'
import { parseUnits } from 'viem'

function setHookDefaults() {
  useQuoteMock.mockReturnValue({
    meta: null,
    loading: false,
    error: null,
    countdown: 0,
    refetch: vi.fn(),
    refresh: vi.fn(),
  })
  useSwapMock.mockReturnValue({
    status: 'idle',
    txHash: null,
    errorMessage: null,
    cowOrderUid: null,
    priceGuardBlocked: false,
    priceGuardDeviation: 0,
    simulationPassed: true,
    pendingSwap: null,
    mevSurplusActualWei: null,
    unpricedAckRequired: false,
    execute: vi.fn(),
    confirmSwap: vi.fn(),
    reset: vi.fn(),
  })
  useApprovalMock.mockReturnValue({
    plan: null,
    status: 'idle',
    error: null,
    approve: vi.fn(),
    isReady: true,
    needsPermit2Education: false,
    confirmPermit2Education: vi.fn(),
    cancelPermit2Education: vi.fn(),
  })
  useChainlinkPriceMock.mockReturnValue({
    chainlinkPrice: null,
    executionPrice: null,
    deviation: 0,
    level: 'none',
    message: null,
    oracleUnavailable: false,
  })
  // [SPRINT-9W-oracle] default: no depeg verdict (non-cbETH / fail-open) → no friction.
  useDepegCheckMock.mockReturnValue({ mode: 'ok', divergence: 0, symbol: '', message: null })
  useSplitRouteMock.mockReturnValue({
    splitResult: null,
    analyzing: false,
    splitRecommended: false,
    useSplit: false,
    toggleSplit: vi.fn(),
  })
  useSplitSwapMock.mockReturnValue({
    status: 'idle',
    legs: [],
    completedLegs: 0,
    totalLegs: 0,
    errorMessage: null,
    execute: vi.fn(),
    reset: vi.fn(),
  })
  useSwapHistoryMock.mockReturnValue({ addRecord: vi.fn(), history: [] })
  useActiveApprovalsMock.mockReturnValue({ addApproval: vi.fn(), activeApprovals: [], removeApproval: vi.fn() })
  useEthGasCostMock.mockReturnValue({
    ethPrice: 3000,
    gasPriceGwei: 20,
    estimate: () => ({ eth: 0.004, usd: 12 }),
  })
  useSwapPriceTierMock.mockReturnValue({ data: null, loading: false })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockIsConnected = true
  mockChainId = 1
  useRealQuoteBreakdown = false
  setHookDefaults()
})


// ─── Fixtures: an EXOTIC pair (no stable, no ETH, no Chainlink feed) ───
const XIN = { symbol: 'XIN', address: '0x0000000000000000000000000000000000001234', decimals: 18 }
const XOUT = { symbol: 'XOUT', address: '0x0000000000000000000000000000000000005678', decimals: 18 }
const NO_FEED = { chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'warn' as const, message: null, oracleUnavailable: true, oracleIntegrityFailed: false, oracleMissingSymbols: ['XIN', 'XOUT'] }
const leg = (tier: 'priced' | 'single-source' | 'unpriced', usd?: number) =>
  tier === 'unpriced' ? { tier, sources: [] } : { tier, sources: tier === 'priced' ? ['defillama', 'coingecko'] : ['defillama'], usd, ...(tier === 'priced' ? { agreementBps: 2 } : {}) }
const TIER = {
  priced: { tier: 'priced', legs: { in: leg('priced', 1), out: leg('priced', 1) }, agreementBps: 2 },
  single: { tier: 'single-source', legs: { in: leg('single-source', 1), out: leg('unpriced') } },
  unpriced: { tier: 'unpriced', legs: { in: leg('unpriced'), out: leg('unpriced') } },
}
const q = (source: string, toAmount: string) => ({ source, toAmount, estimatedGas: 200_000, gasUsd: 10, routes: [], tx: { to: '0x0', data: '0x', value: '0', gas: 200000 } })
/** A quote for the exotic pair; identity matches what SwapBox will hold after pickExoticPair + amount. */
function exoticQuote(amount: string, toAmounts: string[] = ['1000000000000000000000']) {
  const all = toAmounts.map((t, i) => q(i === 0 ? '1inch' : i === 1 ? '0x' : 'kyberswap', t))
  return {
    meta: {
      best: all[0], all, fetchedAt: Date.now(),
      identity: { chainId: 1, tokenIn: XIN.address.toLowerCase(), tokenOut: XOUT.address.toLowerCase(), amountRaw: parseUnits(amount, 18).toString(), decimalsIn: 18, decimalsOut: 18, fetchedAt: Date.now() },
    },
    loading: false, error: null, countdown: 10, refetch: vi.fn(), refresh: vi.fn(),
  }
}
async function pickExoticPair(container: HTMLElement, amount: string) {
  const [selIn, selOut] = screen.getAllByTestId('token-selector')
  nextPick = XIN
  await act(async () => { fireEvent.click(selIn) })
  nextPick = XOUT
  await act(async () => { fireEvent.click(selOut) })
  const input = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!
  await act(async () => { fireEvent.change(input, { target: { value: amount } }) })
}
const swapBtn = () => screen.getByTestId('swap-button')

describe('SwapBox — [feat/swap-price-tiers] the local "value cannot be verified" block is gone (D1)', () => {
  it('an exotic pair with NO Chainlink feed and an UNKNOWN tier is not blocked at any size — the server decides', async () => {
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useQuoteMock.mockReturnValue(exoticQuote('5'))
    const { container } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5')
    expect(swapBtn().getAttribute('data-blocked')).toBe('false')
    expect(screen.queryByText(/value cannot be verified/i)).toBeNull()
    expect(screen.queryByText(/Unpriceable trades are blocked/i)).toBeNull()
  })
})

describe('SwapBox — [feat/swap-price-tiers] tier matrix', () => {
  it('priced → no notice, no dialog; Swap executes without any ack; QuoteBreakdown receives the tier', async () => {
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useSwapPriceTierMock.mockReturnValue({ data: TIER.priced, loading: false })
    useQuoteMock.mockReturnValue(exoticQuote('5'))
    const execute = vi.fn()
    useSwapMock.mockReturnValue({ ...useSwapMock(), execute })
    const { container } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5')
    expect(screen.getByTestId('quote-breakdown').getAttribute('data-tier')).toBe('priced')
    expect(swapBtn().getAttribute('data-blocked')).toBe('false')
    await act(async () => { fireEvent.click(swapBtn()) })
    expect(screen.queryByTestId('unpriced-consent-dialog')).toBeNull()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toBe('1inch')
    expect(execute.mock.calls[0][2]).toBeUndefined()
  })

  it('single-source → allowed, and value-based limits use THAT price: 20 000 × $1 → the >$10k no-oracle block; 100 × $1 → free', async () => {
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useSwapPriceTierMock.mockReturnValue({ data: TIER.single, loading: false })
    useQuoteMock.mockReturnValue(exoticQuote('20000'))
    const { container, rerender } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '20000')
    expect(screen.getByTestId('quote-breakdown').getAttribute('data-tier')).toBe('single-source')
    expect(swapBtn().getAttribute('data-blocked')).toBe('true')
    expect(swapBtn().getAttribute('data-reason')).toBe('oracle')
    useQuoteMock.mockReturnValue(exoticQuote('100'))
    const input = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!
    await act(async () => { fireEvent.change(input, { target: { value: '100' } }) })
    await act(async () => { rerender(<SwapBox />) })
    expect(swapBtn().getAttribute('data-blocked')).toBe('false')
    expect(screen.queryByTestId('unpriced-consent-dialog')).toBeNull()
  })

  it('unpriced → Swap opens the consent dialog (nothing executes); tick + Continue → execute with { unpricedAck: true }', async () => {
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useSwapPriceTierMock.mockReturnValue({ data: TIER.unpriced, loading: false })
    useQuoteMock.mockReturnValue(exoticQuote('5'))
    const execute = vi.fn()
    useSwapMock.mockReturnValue({ ...useSwapMock(), execute })
    const { container } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5')
    expect(swapBtn().getAttribute('data-blocked')).toBe('false') // consent, not a block
    await act(async () => { fireEvent.click(swapBtn()) })
    expect(execute).not.toHaveBeenCalled()
    expect(screen.getByTestId('unpriced-consent-dialog')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByTestId('unpriced-consent-checkbox')) })
    await act(async () => { fireEvent.click(screen.getByTestId('unpriced-consent-confirm')) })
    expect(screen.queryByTestId('unpriced-consent-dialog')).toBeNull()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toBe('1inch')
    expect(execute.mock.calls[0][2]).toEqual({ unpricedAck: true })
  })

  it('unpriced → Cancel closes the dialog and nothing executes', async () => {
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useSwapPriceTierMock.mockReturnValue({ data: TIER.unpriced, loading: false })
    useQuoteMock.mockReturnValue(exoticQuote('5'))
    const execute = vi.fn()
    useSwapMock.mockReturnValue({ ...useSwapMock(), execute })
    const { container } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5')
    await act(async () => { fireEvent.click(swapBtn()) })
    await act(async () => { fireEvent.click(screen.getByTestId('unpriced-consent-cancel')) })
    expect(screen.queryByTestId('unpriced-consent-dialog')).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })

  it('dialog placeholders are REAL values: {N} = quotes that answered, {d} = their spread, {minOut} = best × (1 − slippage) in {B}', async () => {
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useSwapPriceTierMock.mockReturnValue({ data: TIER.unpriced, loading: false })
    // 3 quotes: 1000 / 996 / 1004 XOUT → spread (1004 − 996) / 996 = 0.803…% ; auto-slippage mock = 0.3% → minOut 997.0000
    useQuoteMock.mockReturnValue(exoticQuote('5', ['1000000000000000000000', '996000000000000000000', '1004000000000000000000']))
    const { container } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5')
    await act(async () => { fireEvent.click(swapBtn()) })
    const body = screen.getByTestId('unpriced-consent-body').textContent ?? ''
    expect(body).toContain("We couldn't find a Chainlink, DefiLlama or CoinGecko price for XIN or XOUT")
    expect(body).toContain('3 sources quoted within 0.8% of each other')
    expect(body).toContain('on-chain minimum output of 997.0000 XOUT')
  })

  it('server 409 (useSwap.unpricedAckRequired) reopens the dialog even when the client thought the pair was priced; Cancel resets the hook', async () => {
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useSwapPriceTierMock.mockReturnValue({ data: TIER.priced, loading: false })
    useQuoteMock.mockReturnValue(exoticQuote('5'))
    const execute = vi.fn(); const reset = vi.fn()
    useSwapMock.mockReturnValue({ ...useSwapMock(), unpricedAckRequired: true, execute, reset })
    const { container } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5')
    expect(screen.getByTestId('unpriced-consent-dialog')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByTestId('unpriced-consent-checkbox')) })
    await act(async () => { fireEvent.click(screen.getByTestId('unpriced-consent-confirm')) })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][2]).toEqual({ unpricedAck: true })
  })

  it('server 409 → Cancel calls reset(); once the hook drops the flag the dialog is gone', async () => {
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useQuoteMock.mockReturnValue(exoticQuote('5'))
    // A stateful stand-in for the real hook: reset() clears unpricedAckRequired (pinned in useSwap.test.ts).
    const defaults = useSwapMock()
    let ackRequired = false
    const reset = vi.fn(() => { ackRequired = false })
    useSwapMock.mockImplementation(() => ({ ...defaults, unpricedAckRequired: ackRequired, reset }))
    const { container, rerender } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5') // (token picks call reset() too — the real hook does the same)
    ackRequired = true // the server answered 409 on the swap attempt
    await act(async () => { rerender(<SwapBox />) })
    reset.mockClear()
    expect(screen.getByTestId('unpriced-consent-dialog')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByTestId('unpriced-consent-cancel')) })
    expect(reset).toHaveBeenCalled()
    await act(async () => { rerender(<SwapBox />) })
    expect(screen.queryByTestId('unpriced-consent-dialog')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// [fix/unpriced-ack-paths L-3 / Auditor 64] The ack decided in the dialog is ONE source of truth: on a
// split route Continue hands it to useSplitSwap (every leg posts it), and the split hook's own 409 flag
// opens the same dialog; Cancel resets THAT hook.
// ─────────────────────────────────────────────────────────────
describe('SwapBox — [fix/unpriced-ack-paths] split route: the ack reaches useSplitSwap; a split 409 opens the dialog', () => {
  const bestSplit = {
    isSplit: true, totalOutput: '1000000000000000000000', totalGasUsd: 10, improvementBps: 25,
    legs: [
      { source: '1inch', percent: 60, inputAmount: '3000000000000000000', outputAmount: '600000000000000000000', gasUsd: 5 },
      { source: '0x', percent: 40, inputAmount: '2000000000000000000', outputAmount: '400000000000000000000', gasUsd: 5 },
    ],
  }
  function splitActive() {
    useSplitRouteMock.mockReturnValue({ splitResult: { bestSplit, splitRecommended: true }, analyzing: false, splitRecommended: true, useSplit: true, toggleSplit: vi.fn() })
  }

  it('unpriced + split active → Continue calls executeSplitSwap(bestSplit, { unpricedAck: true }); the single execute is never called', async () => {
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useSwapPriceTierMock.mockReturnValue({ data: TIER.unpriced, loading: false })
    useQuoteMock.mockReturnValue(exoticQuote('5'))
    splitActive()
    const executeSplit = vi.fn()
    useSplitSwapMock.mockReturnValue({ ...useSplitSwapMock(), unpricedAckRequired: false, execute: executeSplit })
    const executeSingle = vi.fn()
    useSwapMock.mockReturnValue({ ...useSwapMock(), execute: executeSingle })
    const { container } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5')
    await act(async () => { fireEvent.click(swapBtn()) })
    expect(executeSplit).not.toHaveBeenCalled()
    expect(screen.getByTestId('unpriced-consent-dialog')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByTestId('unpriced-consent-checkbox')) })
    await act(async () => { fireEvent.click(screen.getByTestId('unpriced-consent-confirm')) })
    expect(screen.queryByTestId('unpriced-consent-dialog')).toBeNull()
    expect(executeSplit).toHaveBeenCalledTimes(1)
    expect(executeSplit.mock.calls[0][0]).toBe(bestSplit)
    expect(executeSplit.mock.calls[0][1]).toEqual({ unpricedAck: true })
    expect(executeSingle).not.toHaveBeenCalled()
  })

  it('a split 409 (useSplitSwap.unpricedAckRequired) opens the dialog even when the client thought the pair was priced; Cancel resets the SPLIT hook', async () => {
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useSwapPriceTierMock.mockReturnValue({ data: TIER.priced, loading: false })
    useQuoteMock.mockReturnValue(exoticQuote('5'))
    splitActive()
    const resetSplit = vi.fn(); const resetSingle = vi.fn()
    useSplitSwapMock.mockReturnValue({ ...useSplitSwapMock(), unpricedAckRequired: true, reset: resetSplit })
    useSwapMock.mockReturnValue({ ...useSwapMock(), reset: resetSingle })
    const { container } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5')
    expect(screen.getByTestId('unpriced-consent-dialog')).toBeInTheDocument()
    resetSplit.mockClear(); resetSingle.mockClear() // token picks reset both hooks — only the Cancel click matters below
    await act(async () => { fireEvent.click(screen.getByTestId('unpriced-consent-cancel')) })
    expect(resetSplit).toHaveBeenCalledTimes(1)
    expect(resetSingle).not.toHaveBeenCalled() // the single hook's flag is down — nothing to reset there
  })
})

/** The three price notices a user could see for an unverified price. Exactly one tier-driven notice, or none. */
function priceNotices() {
  const text = document.body.textContent ?? ''
  return {
    legacyBlue: /No oracle available/.test(text),
    singleSource: !!screen.queryByTestId('price-tier-single-source'),
    unpriced: !!screen.queryByTestId('price-tier-unpriced'),
  }
}

describe('SwapBox — [chore/copy-leftovers] one price notice, from the tier', () => {
  const cases: Array<[string, typeof TIER[keyof typeof TIER] | null, { singleSource: boolean; unpriced: boolean }]> = [
    ['priced → none', TIER.priced, { singleSource: false, unpriced: false }],
    ['single-source → the amber notice only', TIER.single, { singleSource: true, unpriced: false }],
    ['unpriced → the "No reference price" notice only', TIER.unpriced, { singleSource: false, unpriced: true }],
    ['unknown (null) → none — the client never guesses', null, { singleSource: false, unpriced: false }],
  ]
  it.each(cases)('%s (pair with no Chainlink feed, small swap)', async (_name, tier, expected) => {
    useRealQuoteBreakdown = true
    useChainlinkPriceMock.mockReturnValue(NO_FEED)
    useSwapPriceTierMock.mockReturnValue({ data: tier, loading: false })
    useQuoteMock.mockReturnValue(exoticQuote('5'))
    const { container } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5')
    expect(screen.getByText(/Rate/)).toBeInTheDocument() // the real QuoteBreakdown is on screen
    expect(priceNotices()).toEqual({ legacyBlue: false, ...expected })
  })
})

describe('SwapBox — [chore/copy-leftovers] source counts', () => {
  it('"N sources queried" counts the quotes that came back (the toggle says "enabled", not "x/y")', async () => {
    useQuoteMock.mockReturnValue(exoticQuote('5', ['1000000000000000000000', '996000000000000000000', '1004000000000000000000']))
    const { container } = renderWithProviders(<SwapBox />)
    await pickExoticPair(container, '5')
    expect(screen.getByText('3 sources queried')).toBeInTheDocument()
  })
})
