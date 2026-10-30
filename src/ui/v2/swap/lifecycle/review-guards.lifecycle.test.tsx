// @vitest-environment jsdom
/**
 * [A69 L-1 / L-2 / L-3] Three edges of the review sheet's lifecycle, each against the real `useSwapLifecycle` with v1's hooks mocked:
 *   L-1  Confirm is gated like the CTA behind it — a price-gate block or a vanished quote disables it with v1's block copy; no press can
 *        silently do nothing, and the waiting-sound loop never starts for a press that cannot execute.
 *   L-2  Cancel on the CoW order sheet clears the review request: the single-route review does not reopen behind it.
 *   L-3  The Permit2 explainer opens INSTEAD of the review (v1 order), not stacked under it.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_ORACLE, ETH, USDC, fixtureMeta, taggedFixture } from '../test-fixtures'
import { blockCopy } from './gates'

const h = vi.hoisted(() => ({
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  oracle: {} as Record<string, unknown>,
  approval: {} as Record<string, unknown>,
  depeg: {} as Record<string, unknown>,
  swap: {} as Record<string, unknown>,
  startWaiting: vi.fn(),
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
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => h.depeg }))
vi.mock('@/hooks/useSwap', () => ({ useSwap: () => h.swap }))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => ({ splitResult: null, analyzing: false, useSplit: false, toggleSplit: () => {} }) }))
vi.mock('@/hooks/useSplitSwap', () => ({ useSplitSwap: () => ({ status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: vi.fn(), confirmPlan: vi.fn(), reset: vi.fn() }) }))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: () => {} }) }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('../../shell/toasts', () => ({ useV2Toast: () => ({ toast: () => 'toast-id', dismiss: () => {}, update: () => {} }) }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/sounds', () => ({ playQuoteReceived: () => {}, playTouchMP3: () => {}, playSwapConfirmMP3: () => {}, playCancelOrderMP3: () => {}, startWaitingSound: h.startWaiting, stopWaitingSound: () => {} }))

import { SwapCard } from '../SwapCard'
import { useSwapLifecycle } from './use-swap-lifecycle'

const noop = () => {}
const ADDR = '0xd44d00000000000000000000000000000000962d'
const READY = { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 }, status: 'ready', error: null, isReady: true, needsPermit2Education: false }
const swapHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', txHash: undefined, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null,
  simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn(), ...over,
})
const execute = () => h.swap.execute as ReturnType<typeof vi.fn>
const flush = () => new Promise((r) => setTimeout(r, 0))
const REVIEW = 'Review Transaction'
const PERMIT2 = 'About to sign a Permit2 approval'

let view: ReturnType<typeof render>
const rerender = () => view.rerender(<SwapCard />)
const dialogNames = () => screen.queryAllByRole('dialog').map((d) => d.querySelector('h2')?.textContent)
const confirm = () => within(screen.getByRole('dialog')).getByTestId('review-confirm') as HTMLButtonElement
function openReview() {
  view = render(<SwapCard />)
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review swap' }))
}

beforeEach(() => {
  h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
  h.depeg = { mode: 'ok', divergence: 0, symbol: '', message: null }
  h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
  h.approval = { ...READY, approve: vi.fn(async () => {}), confirmPermit2Education: vi.fn(), cancelPermit2Education: vi.fn() }
  h.swap = swapHook()
  h.startWaiting.mockClear()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('L-1 — Confirm is gated like the CTA, never a silent no-op', () => {
  it('a hard block lands while the review is open: Confirm is disabled with v1\'s block copy, and pressing it starts nothing', async () => {
    openReview()
    expect(confirm().disabled).toBe(false)
    h.depeg = { mode: 'block', divergence: 0.12, symbol: 'cbETH', message: 'x' }
    rerender()
    expect(confirm().disabled).toBe(true)
    expect(confirm().textContent).toBe(blockCopy('depeg-block').text)
    fireEvent.click(confirm())
    await flush()
    expect(execute()).not.toHaveBeenCalled()
    expect(h.startWaiting).not.toHaveBeenCalled()
  })

  it('a recoverable block (price impact) reads v1\'s consent copy too', () => {
    openReview()
    h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490, level: 'warn', deviation: 0.05 }
    rerender()
    expect(confirm().disabled).toBe(true)
    expect(confirm().textContent).toBe(blockCopy('price-impact').text)
  })

  it('the quote vanishes while an (approving) review is open: Confirm is disabled with the CTA\'s words; the waiting loop never starts', async () => {
    h.approval = { ...h.approval, isReady: false, status: 'idle' }
    openReview()
    fireEvent.click(confirm()) // press 1 (approve) freezes the sheet's model; the sheet outlives the quote
    await flush()
    h.startWaiting.mockClear()
    h.quote = { ...h.quote, meta: null }
    rerender()
    expect(screen.getByRole('dialog', { name: REVIEW })).toBeTruthy()
    expect(confirm().disabled).toBe(true)
    expect(confirm().textContent).toBe('No quotes available')
    fireEvent.click(confirm())
    await flush()
    expect(h.startWaiting).not.toHaveBeenCalled()
    expect(execute()).not.toHaveBeenCalled()
  })

  it('a hook that is already working keeps its in-flight words (the gate does not overwrite them)', () => {
    openReview()
    h.swap = swapHook({ status: 'fetching_swap' })
    h.depeg = { mode: 'block', divergence: 0.12, symbol: 'cbETH', message: 'x' }
    rerender()
    expect(confirm().textContent).toBe('Preparing swap...')
  })

  it('useSwapLifecycle.confirm itself: no quote → returns before the waiting loop and before any hook call', async () => {
    const approval = { status: 'ready' as const, error: null, approve: vi.fn(async () => {}), isReady: true }
    const args = (meta: ReturnType<typeof fixtureMeta> | null) => ({
      tokenIn: ETH, tokenOut: USDC, amountIn: '1', slippage: 0.3, meta, activeChainId: 1, isChainOkForQuote: true, chainActive: true, unpricedPair: false, gates: { anyBlocked: false }, approval, tokenOutUsdPrice: null,
    })
    const { result, rerender: again } = renderHook((p: ReturnType<typeof args>) => useSwapLifecycle(p), { initialProps: args(null) })
    await act(async () => {
      await result.current.confirm()
    })
    expect(h.startWaiting).not.toHaveBeenCalled()
    expect(execute()).not.toHaveBeenCalled()
    again(args(fixtureMeta())) // control: with a quote the same call does start the loop and execute
    await act(async () => {
      await result.current.confirm()
    })
    expect(h.startWaiting).toHaveBeenCalledTimes(1)
    expect(execute()).toHaveBeenCalledTimes(1)
  })
})

describe('L-2 — Cancel on the CoW order sheet does not bring the single-route review back', () => {
  it('review → Confirm → CoW order sheet → Cancel → nothing is open (v1: onCancel={resetSwap} ends the flow)', async () => {
    const m = fixtureMeta()
    const cow = { ...m.all[0], source: 'cowswap' as const, gasUsd: 0 }
    h.quote = { ...h.quote, meta: taggedFixture({ ...m, best: cow, all: [cow, ...m.all.slice(1)] }, '1') }
    openReview()
    fireEvent.click(confirm())
    await flush()
    expect(execute().mock.calls[0][0]).toBe('cowswap')

    const order = { domain: {}, types: {}, message: { sellToken: ETH.address, buyToken: USDC.address, receiver: ADDR, sellAmount: 10n ** 18n, buyAmount: 2480000000n, validTo: Math.floor(Date.now() / 1000) + 1800, appData: '0x' + '11'.repeat(32), feeAmount: 0n, kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' }, orderParams: {}, tokenIn: { symbol: 'ETH', decimals: 18 }, tokenOut: { symbol: 'USDC', decimals: 6 }, rawAmount: '1', settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', chainId: 1, account: ADDR, startTime: 0 }
    const reset = vi.fn()
    h.swap = swapHook({ status: 'cow_awaiting_review', pendingCowOrder: order, reset })
    rerender()
    expect(dialogNames()).toEqual(['Review MEV-Protected Order'])

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(reset).toHaveBeenCalledTimes(1)
    h.swap = swapHook({ reset }) // the hook went back to idle, as useSwap.reset() does
    rerender()
    expect(dialogNames()).toEqual([])
  })
})

describe('L-3 — the Permit2 explainer is reachable: it opens instead of the review, in v1\'s order', () => {
  it('Confirm → approve → explainer (alone) → Continue → the review returns, working; Cancel → the review returns, ready', async () => {
    const confirmEdu = vi.fn()
    const cancelEdu = vi.fn()
    h.approval = { ...h.approval, isReady: false, status: 'idle', approve: vi.fn(async () => {}), confirmPermit2Education: confirmEdu, cancelPermit2Education: cancelEdu }
    openReview()
    expect(dialogNames()).toEqual([REVIEW])
    fireEvent.click(confirm())
    await flush()

    h.approval = { ...h.approval, needsPermit2Education: true } // useApproval: the first Permit2 signature needs the explainer
    rerender()
    expect(dialogNames()).toEqual([PERMIT2]) // one dialog, the explainer — not two stacked
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continue to signature' }))
    expect(confirmEdu).toHaveBeenCalledTimes(1)

    h.approval = { ...h.approval, needsPermit2Education: false, status: 'signing' }
    rerender()
    expect(dialogNames()).toEqual([REVIEW])
    expect(confirm().textContent).toBe('Signing...')

    // Cancel path: the explainer closes and the review is back with its approve button
    h.approval = { ...h.approval, status: 'idle', needsPermit2Education: true }
    rerender()
    expect(dialogNames()).toEqual([PERMIT2])
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(cancelEdu).toHaveBeenCalledTimes(1)
    h.approval = { ...h.approval, needsPermit2Education: false }
    rerender()
    expect(dialogNames()).toEqual([REVIEW])
    expect(confirm().textContent).toBe('Approve & Swap')
  })
})
