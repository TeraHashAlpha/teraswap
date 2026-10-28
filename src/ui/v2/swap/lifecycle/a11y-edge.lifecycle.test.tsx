// @vitest-environment jsdom
/**
 * [ADR-025 / B5 C3] Accessibility and edge states of the swap lifecycle, one test per state:
 *  focus stays in the sheet while the hooks move · Esc is dead while a wallet step is in flight (v1 offers no way out of that state)
 *  and live everywhere else · the stale-quote guard is v1's (owner: auto-close — the trade changed, the review goes, the hooks reset)
 *  · the timeline's motion is decoration (reduced-motion) · focus is handed to the running swap when the sheet leaves.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../test-fixtures'

const h = vi.hoisted(() => ({
  account: { address: '0xd44d00000000000000000000000000000000962d' as string | undefined, isConnected: true, chain: { id: 1 } as { id: number } | undefined },
  chainId: 1,
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  approval: {} as Record<string, unknown>,
  swap: {} as Record<string, unknown>,
  split: {} as Record<string, unknown>,
  tier: { data: null as unknown, loading: false },
}))
vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: { value: 3n * 10n ** 18n, decimals: 18 } }),
  useChains: () => [{ id: 1, name: 'Ethereum' }],
  useSwitchChain: () => ({ switchChain: () => {} }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: () => {} }) }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => h.chainId, useActiveChainId: () => h.chainId }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => ({ ...NO_ORACLE, chainlinkPrice: 2490 }) }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => h.approval }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => h.tier }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }) }))
vi.mock('@/hooks/useSwap', () => ({ useSwap: () => h.swap }))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => ({ splitResult: null, analyzing: false, useSplit: false, toggleSplit: () => {} }) }))
vi.mock('@/hooks/useSplitSwap', () => ({ useSplitSwap: () => h.split }))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: () => {} }) }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('../../shell/toasts', () => ({ useV2Toast: () => ({ toast: () => 'toast-id', dismiss: () => {}, update: () => {} }) }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/sounds', () => ({ playQuoteReceived: () => {}, playTouchMP3: () => {}, playSwapConfirmMP3: () => {}, playCancelOrderMP3: () => {}, startWaitingSound: () => {}, stopWaitingSound: () => {} }))

import { SwapCard } from '../SwapCard'

const noop = () => {}
const READY = { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 }, status: 'ready', error: null, isReady: true, needsPermit2Education: false, approve: async () => {}, confirmPermit2Education: noop, cancelPermit2Education: noop }
const swapHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', txHash: undefined, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null,
  simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn(), ...over,
})
const splitHook = () => ({ status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: vi.fn(), confirmPlan: vi.fn(), reset: vi.fn() })
const PENDING = { source: 'velora', txTo: '0x1', txData: '0x12345678', txValue: 0n, routerAddress: '0x6a000f20005980200259b80c5102003040001068', routerCalldata: '0x12345678', routeViaFeeCollector: true, routeType: 'fee_collector_eth', swapToAmount: '2487684200', rawAmountBn: 10n ** 18n, tokenIn: { symbol: 'ETH', decimals: 18, address: '0x', name: 'Ether' }, tokenOut: { symbol: 'USDC', decimals: 6, address: '0x', name: 'USDC' }, minimumOutput: 1n, swapStartTime: 0 }

let view: ReturnType<typeof render>
const render2 = () => view.rerender(<SwapCard />)
const setSwap = (over: Record<string, unknown> = {}) => {
  h.swap = swapHook(over)
  render2()
}
const dialog = () => screen.getByRole('dialog')
const esc = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

beforeEach(() => {
  h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
  h.chainId = 1
  h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
  h.approval = { ...READY }
  h.swap = swapHook()
  h.split = splitHook()
  h.tier = { data: null, loading: false }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
  view = render(<SwapCard />)
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const openReview = () => fireEvent.click(screen.getByRole('button', { name: 'Review swap' }))

describe('focus stays in the sheet while the hooks move', () => {
  it('Confirm pressed → approving → ready → preparing → simulating → frozen review: the SAME dialog, focus never leaves it', () => {
    h.approval = { ...READY, isReady: false, status: 'idle' }
    render2()
    openReview()
    const dlg = dialog()
    const confirm = within(dlg).getByRole('button', { name: 'Approve & Swap' })
    confirm.focus()
    expect(document.activeElement).toBe(confirm)
    const walk: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ isReady: false, status: 'approving_permit2' }, {}],
      [{ isReady: false, status: 'signing' }, {}],
      [{ isReady: true, status: 'ready' }, {}],
      [{ isReady: true, status: 'ready' }, { status: 'fetching_swap' }],
      [{ isReady: true, status: 'ready' }, { status: 'simulating' }],
      [{ isReady: true, status: 'ready' }, { status: 'confirming', pendingSwap: PENDING }],
    ]
    for (const [approval, swap] of walk) {
      h.approval = { ...READY, ...approval }
      h.swap = swapHook(swap)
      render2()
      expect(screen.getByRole('dialog')).toBe(dlg) // one instance: nothing remounted, so no focus restore to the page behind
      expect(dlg.contains(document.activeElement)).toBe(true)
    }
    // …and the busy states hold the button without disabling it (a disabled button drops focus to <body>)
    h.swap = swapHook({ status: 'simulating' })
    render2()
    const busy = within(dlg).getByRole('button', { name: 'Simulating transaction...' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    expect((busy as HTMLButtonElement).disabled).toBe(false)
    expect(busy.getAttribute('aria-busy')).toBe('true')
  })

  it('a busy Confirm does nothing when pressed (aria-disabled is not a click target)', () => {
    openReview()
    setSwap({ status: 'simulating' })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Simulating transaction...' }))
    expect(h.swap.execute).not.toHaveBeenCalled()
    expect(h.swap.confirmSwap).not.toHaveBeenCalled()
  })

  it('a 409 after Confirm: the consent returns unticked and takes focus (it would otherwise fall to the page behind)', () => {
    openReview()
    within(dialog()).getByRole('button', { name: 'Confirm & Sign' }).focus()
    setSwap({ unpricedAckRequired: true })
    expect(document.activeElement).toBe(screen.getByTestId('unpriced-consent-checkbox'))
    expect(dialog().contains(document.activeElement)).toBe(true)
  })

  it('Tab cycles inside the sheet (the trap is the shared Sheet\'s) — including the busy button, which stays in the tab order', () => {
    openReview()
    setSwap({ status: 'fetching_swap' })
    const items = [...dialog().querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input')]
    expect(items.some((el) => el.textContent === 'Preparing swap...')).toBe(true)
    items[items.length - 1].focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(dialog().contains(document.activeElement)).toBe(true)
  })
})

describe('Esc: dead while a wallet step is in flight, live everywhere else (v1: no way out of an in-flight state; every review cancels)', () => {
  it.each([
    ['approving', { isReady: false, status: 'approving_permit2' }, {}],
    ['signing the approval', { isReady: false, status: 'signing' }, {}],
    ['preparing the swap', {}, { status: 'fetching_swap' }],
    ['simulating', {}, { status: 'simulating' }],
  ])('%s: Esc and Cancel do nothing, the hooks are untouched', (_n, approval, swap) => {
    openReview()
    h.approval = { ...READY, ...approval }
    h.swap = swapHook(swap)
    render2()
    esc()
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(document.querySelector('[data-sheet-backdrop]')!)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(h.swap.reset).not.toHaveBeenCalled()
  })
  it('idle review: Esc cancels, returns focus to the CTA', () => {
    const cta = document.querySelector('[data-cta]') as HTMLElement
    cta.focus()
    openReview()
    esc()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(cta)
  })
  it('frozen review (confirming): Esc cancels → the hook is reset (v1: onCancel={resetSwap}) and nothing is signed', () => {
    openReview()
    setSwap({ status: 'confirming', pendingSwap: PENDING })
    esc()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.swap.reset).toHaveBeenCalledTimes(1)
    expect(h.swap.confirmSwap).not.toHaveBeenCalled()
  })
  it('error state: the sheet is dismissible again (the failure is on the Execution column)', () => {
    openReview()
    setSwap({ status: 'error', errorMessage: 'Transaction rejected in wallet.' })
    esc()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('stale-quote guard = v1 (owner): the trade changed → the review closes, the hooks reset, nothing is confirmable', () => {
  it('a new amount while the review is open', () => {
    openReview()
    expect(dialog()).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Sell amount', { selector: 'input' }), { target: { value: '2' } })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.swap.execute).not.toHaveBeenCalled()
  })
  it('a chain switch under an open review (the hooks reset themselves; the card drops the review it held)', () => {
    openReview()
    h.chainId = 8453
    h.account = { ...h.account, chain: { id: 8453 } }
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1', 8453) }
    render2()
    expect(screen.queryByRole('dialog')).toBeNull()
    // coming back to the first chain does not resurrect it
    h.chainId = 1
    h.account = { ...h.account, chain: { id: 1 } }
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1', 1) }
    render2()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('a frozen review (confirming) whose trade changed: the hook that holds it is reset (v1: handleAmountChange → resetSwap)', () => {
    openReview()
    setSwap({ status: 'confirming', pendingSwap: PENDING })
    fireEvent.change(screen.getByLabelText('Sell amount', { selector: 'input' }), { target: { value: '3' } })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.swap.reset).toHaveBeenCalled()
  })
  it('a quote refresh for the SAME trade does not close the review (the key is the trade, not the price)', () => {
    openReview()
    h.quote = { ...h.quote, meta: taggedFixture({ ...fixtureMeta(), fetchedAt: 1_700_000_999_999 }, '1') }
    render2()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('focus is handed to the running swap when the sheet leaves', () => {
  it('Confirm → signing: the review closes, focus lands on the Execution column (the CTA that opened it is disabled)', () => {
    openReview()
    setSwap({ status: 'confirming', pendingSwap: PENDING })
    expect(dialog()).toBeTruthy()
    expect(document.activeElement).not.toBe(screen.getByTestId('execution')) // the sheet owns focus while it is open
    setSwap({ status: 'swapping' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('execution'))
  })
  it('the timeline is announced politely and marks the current step', () => {
    openReview()
    setSwap({ status: 'swapping' })
    expect(screen.getByTestId('execution').querySelector('ol')!.getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('execution').querySelector('[aria-current="step"]')!.textContent).toContain('Executing swap...')
  })
})

describe('reduced motion: the timeline\'s only animation is wrapped in prefers-reduced-motion: no-preference', () => {
  it('swap.css: every `animation` declaration sits inside that media query', () => {
    const css = readFileSync(join(__dirname, '..', 'swap.css'), 'utf8')
    const guarded = [...css.matchAll(/@media \(prefers-reduced-motion: no-preference\)\s*\{([\s\S]*?\n\})/g)].map((m) => m[1]).join('\n')
    const decls = css.match(/animation\s*:/g) ?? []
    expect(decls.length).toBeGreaterThan(0)
    expect((guarded.match(/animation\s*:/g) ?? []).length).toBe(decls.length)
  })
  it('the timeline has no transition/animation utility classes of its own (the active node pulse is CSS-only)', () => {
    const src = readFileSync(join(__dirname, 'ExecutionPanel.tsx'), 'utf8')
    expect(src).not.toMatch(/animate-|transition-/)
  })
})
