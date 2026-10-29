// @vitest-environment jsdom
/**
 * [ADR-025 / B5] What the user sees as EXECUTED is what they confirmed. A re-quote (or a price tick) that lands between the Confirm
 * press and the settle must not change the success sheet, the success toast, the history row or the "you saved" line. (v1 reads the
 * live quote at settle time — see the sounds/toasts parity table; v2 freezes it at Confirm.) No wallet, no RPC: the hooks are mocks.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../test-fixtures'

const h = vi.hoisted(() => ({
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  oracle: {} as Record<string, unknown>,
  swap: {} as Record<string, unknown>,
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
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => ({ plan: null, status: 'ready', error: null, isReady: true, approve: async () => {}, needsPermit2Education: false }) }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => ({ data: null, loading: false }) }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }) }))
vi.mock('@/hooks/useSwap', () => ({ useSwap: () => h.swap }))
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
const swapHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', txHash: undefined, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null,
  simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn(), ...over,
})
const norm = (t: string | null) => (t ?? '').replace(/[   ]/g, ' ')

/** The quote the user confirmed is 2 487.6842 USDC (the fixture); the one that lands afterwards is 2 399 USDC. */
function reQuoted(source?: 'cowswap') {
  const m = fixtureMeta()
  const best = { ...m.best, ...(source ? { source, gasUsd: 0 } : {}), toAmount: '2399000000' }
  return taggedFixture({ ...m, best, all: [best, ...m.all.slice(1)] }, '1')
}

let view: ReturnType<typeof render>
/** Type the amount, open the review, press Confirm: the card calls the (mock) hook's execute and freezes what was confirmed. */
function confirmTheQuote() {
  view = render(<SwapCard />)
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review swap' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm & Sign' }))
  expect((h.swap.execute as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
}
const moveHook = (over: Record<string, unknown>) => {
  h.swap = swapHook(over)
  view.rerender(<SwapCard />)
}

beforeEach(() => {
  h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
  h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
  h.swap = swapHook()
  h.toast.mockClear()
  h.addRecord.mockClear()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('a re-quote landing after Confirm never changes what is shown as executed', () => {
  it('standard swap: the success sheet, the toast and the history row carry the CONFIRMED amount', () => {
    confirmTheQuote()
    moveHook({ status: 'swapping' })
    h.quote = { ...h.quote, meta: reQuoted() } // the poll lands while the wallet prompt is open
    view.rerender(<SwapCard />)
    moveHook({ status: 'success', txHash: TX })

    expect(norm(screen.getByTestId('execution').textContent)).toContain('1 ETH → 2 487.6842 USDC')
    expect(norm(screen.getByTestId('execution').textContent)).not.toContain('2 399')
    const success = h.toast.mock.calls.map((c) => c[0]).find((t) => t.title === 'Swap confirmed!')!
    expect(norm(success.description!)).toBe('1 ETH → 2 487.6842 USDC')
    expect(h.addRecord).toHaveBeenCalledTimes(1)
    expect(h.addRecord.mock.calls[0][0]).toMatchObject({ txHash: TX, amountIn: '1', amountOut: '2487.6842', status: 'confirmed' })
  })

  it('the re-quote arriving AFTER the success does not rewrite the sheet either', () => {
    confirmTheQuote()
    moveHook({ status: 'success', txHash: TX })
    h.quote = { ...h.quote, meta: reQuoted() }
    view.rerender(<SwapCard />)
    expect(norm(screen.getByTestId('execution').textContent)).toContain('1 ETH → 2 487.6842 USDC')
    expect(h.addRecord).toHaveBeenCalledTimes(1) // the settle effect ran once, on the status flip — not per quote poll
  })

  it('CoW fill: the "you saved" line keeps the price it was valued at on Confirm when the Chainlink price ticks', () => {
    const m = fixtureMeta()
    const cow = { ...m.all[0], source: 'cowswap' as const, gasUsd: 0 }
    h.quote = { ...h.quote, meta: taggedFixture({ ...m, best: cow, all: [cow, ...m.all.slice(1)] }, '1') }
    confirmTheQuote()
    moveHook({ status: 'cow_pending' })
    h.oracle = { ...NO_ORACLE, chainlinkPrice: 1 } // the buy-token price moves 99.96 % before the order settles
    h.quote = { ...h.quote, meta: reQuoted('cowswap') }
    view.rerender(<SwapCard />)
    moveHook({ status: 'success', txHash: TX, mevSurplusActualWei: 5_000_000n }) // 5 USDC surplus, valued at the Confirm-time $2490
    const line = screen.getByTestId('exec-saved').textContent!
    expect(norm(line)).toMatch(/^You saved ~\$12 ?450(\.\d+)? vs public-mempool execution$/)
    const success = h.toast.mock.calls.map((c) => c[0]).find((t) => t.title === 'Swap confirmed!')!
    expect(norm(success.description!)).toContain('1 ETH → 2 487.6842 USDC')
    expect(norm(success.description!)).toContain(norm(line))
  })
})
