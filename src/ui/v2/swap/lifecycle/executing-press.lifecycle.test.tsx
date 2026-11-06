// @vitest-environment jsdom
/**
 * [A69 M-1] The model the review sheet describes is re-frozen on the press that actually EXECUTES, not only on the first press.
 * v1 freezes its preview where `execute` is reached (useSwap.ts:733 `setPendingSwap`), never at a click that only approves. Two ways
 * a later press differs from the first: an approval round-trip, and a 409 `unpriced_ack_required` round-trip. In both the quote moves
 * (and the best source changes) in between; the sheet, the hook's arguments and the success toast / history row must describe ONE quote.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGGREGATOR_META } from '@/lib/constants'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../test-fixtures'

const h = vi.hoisted(() => ({
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  oracle: {} as Record<string, unknown>,
  approval: {} as Record<string, unknown>,
  swap: {} as Record<string, unknown>,
  swapArgs: [] as unknown[][],
  toast: vi.fn((_t: { title: string; description?: string }) => 'toast-id'),
  addRecord: vi.fn(),
}))
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }),
  useBalance: () => ({ data: { value: 3n * 10n ** 18n, decimals: 18 } }),
  useChains: () => [{ id: 1, name: 'Ethereum' }],
  useSwitchChain: () => ({ switchChain: () => {} }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: () => {} }) }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1, useActiveChainId: () => 1 }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => h.oracle }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => h.approval }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => ({ data: null, loading: false }) }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }) }))
vi.mock('@/hooks/useSwap', () => ({
  useSwap: (...a: unknown[]) => {
    h.swapArgs.push(a)
    return h.swap
  },
}))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => ({ splitResult: null, analyzing: false, useSplit: false, toggleSplit: () => {} }) }))
vi.mock('@/hooks/useSplitSwap', () => ({ useSplitSwap: () => ({ status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: vi.fn(), confirmPlan: vi.fn(), reset: vi.fn() }) }))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: h.addRecord }) }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('../../shell/toasts', () => ({ useV2Toast: () => ({ toast: h.toast, dismiss: () => {}, update: () => {} }) }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/sounds', () => ({ playQuoteReceived: () => {}, playTouchMP3: () => {}, playSwapConfirmMP3: () => {}, playCancelOrderMP3: () => {}, startWaitingSound: () => {}, stopWaitingSound: () => {} }))

import { SwapCard } from '../SwapCard'

const noop = () => {}
const TX = '0x8c1f000000000000000000000000000000000000000000000000000000c44b0'
const READY = { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 }, status: 'ready', error: null, isReady: true, needsPermit2Education: false }
const swapHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', txHash: undefined, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null,
  simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn(), ...over,
})
const norm = (t: string | null) => (t ?? '').replace(/[   ]/g, ' ')
const execute = () => h.swap.execute as ReturnType<typeof vi.fn>
const flush = () => new Promise((r) => setTimeout(r, 0))

/** First press: velora is best at 2 487.6842. The quote that lands later: kyberswap is best at 2 399. */
const quoteA = () => taggedFixture(fixtureMeta(), '1')
function quoteB() {
  const m = fixtureMeta()
  const amounts: Record<string, string> = { kyberswap: '2399000000', velora: '2398500000', sushiswap: '2390000000', uniswapv3: '2385000000', '0x': '2380000000' }
  const order = ['kyberswap', 'velora', 'sushiswap', 'uniswapv3', '0x']
  const all = order.map((s) => ({ ...m.all.find((q) => q.source === s)!, toAmount: amounts[s] }))
  return taggedFixture({ ...m, best: all[0], all }, '1')
}

let view: ReturnType<typeof render>
const dlg = () => within(screen.getByRole('dialog'))
const pressConfirm = () => fireEvent.click(dlg().getByTestId('review-confirm'))
const requote = (meta: ReturnType<typeof quoteA>) => {
  h.quote = { ...h.quote, meta }
  view.rerender(<SwapCard />)
}
const moveHook = (over: Record<string, unknown>) => {
  h.swap = swapHook(over)
  view.rerender(<SwapCard />)
}
function openReview() {
  view = render(<SwapCard />)
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review swap' }))
}
/** What the open sheet says, and what the card handed useSwap on its latest render. */
const row = (id: string, label: string) => norm(dlg().getByTestId(id).textContent).replace(label, '')
const sheet = () => ({ receive: row('review-receive', 'Receive (est.)'), source: row('review-source', 'Source'), rate: row('review-rate', 'Rate') })
const lastSwapCtorBySource = () => (h.swapArgs[h.swapArgs.length - 1][4] as Record<string, string>)

beforeEach(() => {
  h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
  h.quote = { meta: quoteA(), loading: false, error: null, countdown: 12, refresh: noop }
  h.approval = { ...READY, approve: vi.fn(async () => {}), confirmPermit2Education: noop, cancelPermit2Education: noop }
  h.swap = swapHook()
  h.swapArgs.length = 0
  h.toast.mockClear()
  h.addRecord.mockClear()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('approval-first: press 1 approves, the quote moves, press 2 executes', () => {
  it('the sheet, the hook arguments, the toast and the history row all carry the EXECUTING press\'s quote', async () => {
    h.approval = { ...h.approval, isReady: false, status: 'idle' }
    openReview()
    expect(sheet().receive).toBe('2 487.6842 USDC')
    pressConfirm() // press 1: approve only
    await flush()
    expect(execute()).not.toHaveBeenCalled()
    expect(sheet().receive).toBe('2 487.6842 USDC') // the first press froze the sheet while the approval runs

    h.approval = { ...h.approval, isReady: true, status: 'ready' }
    requote(quoteB()) // approval mined; meanwhile the poll moved the market
    pressConfirm() // press 2: this one executes
    await flush()
    expect(execute()).toHaveBeenCalledTimes(1)
    expect(execute().mock.calls[0][0]).toBe('kyberswap') // the hook got the executing press's winner…
    moveHook({ status: 'fetching_swap' }) // …and the sheet, still open while the hook builds the transaction, says the same
    expect(sheet().receive).toBe('2 399.0000 USDC')
    expect(sheet().source).toContain(AGGREGATOR_META.kyberswap.label)
    expect(sheet().rate).toContain('2 399.0000')
    expect(lastSwapCtorBySource().kyberswap).toBe('2399000000') // useSwap's per-source floor reference is that same quote

    moveHook({ status: 'success', txHash: TX })
    const success = h.toast.mock.calls.map((c) => c[0]).find((t) => t.title === 'Swap confirmed!')!
    expect(norm(success.description!)).toBe('1 ETH → 2 399.0000 USDC')
    expect(h.addRecord.mock.calls[0][0]).toMatchObject({ txHash: TX, amountIn: '1', amountOut: '2399.0000' })
  })
})

describe('409 unpriced_ack_required: press 1 executes, the server asks, the quote moves, press 2 executes with the ack', () => {
  it('the sheet is re-frozen from the quote the second execute received', async () => {
    openReview()
    pressConfirm()
    await flush()
    expect(execute().mock.calls[0][0]).toBe('velora')
    const first = execute()
    moveHook({ unpricedAckRequired: true }) // the hook answered 409 and went back to idle: the consent returns, unticked
    expect(sheet().receive).toBe('2 487.6842 USDC')

    requote(quoteB())
    fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
    pressConfirm()
    await flush()
    const second = execute()
    expect(second).not.toBe(first) // moveHook replaced the mock; this is the 409 round-trip's own execute
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0][0]).toBe('kyberswap')
    expect(second.mock.calls[0][2]).toEqual({ unpricedAck: true })
    moveHook({ status: 'fetching_swap' })
    expect(sheet().receive).toBe('2 399.0000 USDC')
    expect(sheet().source).toContain(AGGREGATOR_META.kyberswap.label)
  })
})
