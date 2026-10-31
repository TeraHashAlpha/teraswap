// @vitest-environment jsdom
/**
 * [ADR-025 / B6b C3] Accessibility and edge states of the DCA create path, one test per state:
 *  focus stays in ONE dialog from the frozen review through signing to the outcome · Esc / Cancel / backdrop are dead while a step is in
 *  flight (creating, signing — v1 offers no way out of `isSubmitting`) and live everywhere else · the draft changing under an open sheet
 *  closes the review and drops a frozen order (B5's trade-key rule, owner: auto-close) · a double press reaches the engine once · an
 *  attempt the engine abandons silently disarms (a later, unrelated event is not read as this attempt's) · motion is decoration.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE, h, offchainInfo, resetHarness } from './dca-harness'
import { deferred, fake, resetFake, type SignOutcome } from './dca-engine-fake'

vi.mock('wagmi', async () => {
  const { h } = await import('./dca-harness')
  const actual = await vi.importActual<typeof import('wagmi')>('wagmi')
  return { ...actual, useAccount: () => h.account, useChainId: () => 8453, useSwitchChain: () => ({ switchChain: h.switchChain, switchChainAsync: vi.fn() }) }
})
vi.mock('@rainbow-me/rainbowkit', async () => {
  const { h } = await import('./dca-harness')
  return { ConnectButton: () => <button data-testid="rk-connect">Connect</button>, useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }
})
vi.mock('@/hooks/useOrderEngine', async () => {
  const { useFakeOrderEngine } = await import('./dca-engine-fake')
  return { useOrderEngine: useFakeOrderEngine }
})
vi.mock('@/hooks/useOrderApproval', async () => {
  const { h } = await import('./dca-harness')
  return { useOrderApproval: () => h.approval }
})
vi.mock('@/hooks/useTokenBalances', async () => {
  const { h } = await import('./dca-harness')
  return { useTokenBalances: () => ({ balances: h.balances }) }
})
vi.mock('@/hooks/useTokenBalance', async () => {
  const { h } = await import('./dca-harness')
  return { useTokenBalance: () => h.direct }
})
vi.mock('@/hooks/useChainlinkPrice', async () => {
  const { h } = await import('./dca-harness')
  const { getCanonicalUsdc } = await import('@/lib/chains/tokens')
  return { useChainlinkPrice: (a?: string) => (a && a.toLowerCase() === getCanonicalUsdc(8453)?.address.toLowerCase() ? h.oracleOut : h.oracle) }
})
vi.mock('@/hooks/useDepegCheck', async () => {
  const { h } = await import('./dca-harness')
  return { useDepegCheck: () => h.depeg }
})
vi.mock('@/hooks/useOrderExecutions', () => ({ useOrderExecutions: () => ({ executions: [], lastFillAtMs: null, orderMeta: null, loading: false }) }))
vi.mock('@/components/dca/pair-floor-info', async () => {
  const { h } = await import('./dca-harness')
  const actual = await vi.importActual<typeof import('@/components/dca/pair-floor-info')>('@/components/dca/pair-floor-info')
  return { ...actual, fetchPairFloorInfo: async () => h.floor }
})
vi.mock('@/lib/order-engine', async () => {
  const { h } = await import('./dca-harness')
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return { ...actual, getOrderExecutorV3: (c: number) => (h.v3Chains.includes(c) ? '0x3333333333333333333333333333333333333333' : null) }
})
vi.mock('@/lib/order-engine/check-route', () => ({ checkRoute: async () => ({ routable: true }) }))
vi.mock('@/lib/defillama-client', () => ({ fetchDefiLlamaPriceViaApi: async () => null }))
vi.mock('@/lib/sounds', async () => {
  const { h } = await import('./dca-harness')
  return { ...h.sounds }
})
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: () => {} }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: () => {} }))
vi.mock('../shell/toasts', async () => {
  const { h } = await import('./dca-harness')
  return { useV2Toast: () => ({ toast: h.toast, dismiss: () => {}, update: () => {} }) }
})
vi.mock('../modals/TokenSheet', () => ({ TokenSheet: () => null }))

import type { PendingOrderReview } from '@/hooks/useOrderEngine'
import type { OrderEngineEvent } from '@/lib/order-engine'
import { findChainToken } from '@/lib/chains/tokens'
import { getWrappedNative } from '@/lib/chains/registry'
import { DcaCard } from './DcaCard'
import { useDcaLifecycle, type DcaEngineSlice } from './use-dca-lifecycle'
import { buildDcaDraft } from './dca-model'
import type { PrepareFn, PreparedReview } from './use-dca-form'

const weth = () => findChainToken(getWrappedNative(BASE), BASE)!
const WETH_BALANCE = { raw: 2_000_000_000_000_000_000n, formatted: '2.0' }
const CREATED: SignOutcome = { event: { type: 'order_created', orderId: 'o1', orderHash: '0xhash' }, posted: true }

beforeEach(() => {
  resetHarness()
  resetFake()
  h.balances = new Map([[weth().address.toLowerCase(), WETH_BALANCE]])
})
afterEach(cleanup)

const amountInput = () => document.querySelector('input[inputmode="decimal"]') as HTMLInputElement
const typeAmount = (v: string) => fireEvent.change(amountInput(), { target: { value: v } })
const dialog = () => screen.getByRole('dialog')
const esc = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
const names = () => fake.seq.map((c) => c[0])

async function openReview() {
  const view = render(<DcaCard chainId={BASE} />)
  await act(async () => {})
  typeAmount('0.5')
  const cta = await screen.findByRole('button', { name: 'Review DCA' })
  await waitFor(() => expect(cta).toHaveProperty('disabled', false))
  cta.focus()
  fireEvent.click(cta)
  await screen.findByTestId('dca-review-create')
  return view
}
async function freeze() {
  const view = await openReview()
  fireEvent.click(screen.getByTestId('dca-review-create'))
  await screen.findByTestId('dca-sign-body')
  return view
}

describe('focus stays in the sheet while the engine moves', () => {
  it('frozen → signing → created: the SAME dialog, focus never leaves it, the busy button holds focus without being disabled', async () => {
    const d = deferred<SignOutcome>()
    fake.sign = () => d.promise
    await freeze()
    const dlg = dialog()
    expect(dlg.getAttribute('data-sheet')).toBe('dca-sign')
    expect(document.activeElement).toBe(within(dlg).getByTestId('dca-sign-secondary')) // Cancel: the safe default
    const confirm = within(dlg).getByTestId('dca-sign-confirm')
    confirm.focus()
    fireEvent.click(confirm)
    const busy = await within(dlg).findByRole('button', { name: 'Signing order...' })
    expect(screen.getByRole('dialog')).toBe(dlg)
    expect(busy).toBe(confirm) // one node across the two phases
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect((busy as HTMLButtonElement).disabled).toBe(false)
    expect(dlg.contains(document.activeElement)).toBe(true)
    await act(async () => { d.resolve(CREATED) })
    expect(screen.getByRole('dialog')).toBe(dlg)
    expect(document.activeElement).toBe(within(dlg).getByTestId('dca-sign-view-positions'))
  })

  it('Tab cycles inside the sign sheet (the shared Sheet\'s trap), the busy button included', async () => {
    const d = deferred<SignOutcome>()
    fake.sign = () => d.promise
    await freeze()
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    await within(dialog()).findByRole('button', { name: 'Signing order...' })
    const items = [...dialog().querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input')]
    expect(items.some((el) => el.textContent === 'Signing order...')).toBe(true)
    items[items.length - 1].focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(dialog().contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(dialog().contains(document.activeElement)).toBe(true)
  })

  it('the timeline is announced politely and marks the current step; the created outcome marks every step done', async () => {
    const d = deferred<SignOutcome>()
    fake.sign = () => d.promise
    await freeze()
    const ol = screen.getByTestId('dca-sign-steps')
    expect(ol.getAttribute('aria-live')).toBe('polite')
    expect(ol.querySelector('[aria-current="step"]')?.textContent).toContain('Signing order...') // the one thing left to do
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    await act(async () => { d.resolve(CREATED) })
    expect([...ol.querySelectorAll('li')].map((li) => li.getAttribute('data-step'))).toEqual(['done', 'done'])
  })

  it('review → frozen: the review sheet hands over to the sign sheet; Cancel on the sign sheet is the default focus', async () => {
    await freeze()
    expect(screen.getAllByRole('dialog').length).toBe(1)
    expect(document.activeElement).toBe(screen.getByTestId('dca-sign-secondary'))
  })
})

describe('Esc / Cancel / backdrop: dead while a step is in flight, live everywhere else', () => {
  it('creating: two presses on Create in one tick reach createOrder once (the engine\'s freeze is synchronous, so the busy window is one microtask)', async () => {
    await openReview()
    const create = screen.getByTestId('dca-review-create')
    fireEvent.click(create)
    fireEvent.click(create)
    await screen.findByTestId('dca-sign-body')
    expect(names()).toEqual(['createOrder'])
  })

  it('idle review: Esc closes it, the loop stops, focus returns to the CTA; nothing reached the engine', async () => {
    await openReview()
    const cta = screen.getByRole('button', { name: 'Review DCA' })
    h.soundLog.length = 0
    esc()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.soundLog).toEqual(['stopWaitingSound'])
    expect(document.activeElement).toBe(cta)
    expect(fake.seq).toEqual([])
  })

  it('frozen: Esc = v1\'s modal Cancel → clearPendingOrder(), nothing signed, the loop stops (v2), the form is back with its amount cleared (v1 :994)', async () => {
    await freeze()
    h.soundLog.length = 0
    esc()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(names()).toEqual(['createOrder', 'clearPendingOrder'])
    expect(h.soundLog).toEqual(['stopWaitingSound'])
    expect(amountInput().value).toBe('')
  })

  it('signing: Esc, Cancel and the backdrop do nothing; the engine is untouched (v1: no way out of isSubmitting)', async () => {
    const d = deferred<SignOutcome>()
    fake.sign = () => d.promise
    await freeze()
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    await within(dialog()).findByRole('button', { name: 'Signing order...' })
    esc()
    fireEvent.click(within(dialog()).getByTestId('dca-sign-secondary'))
    fireEvent.click(document.querySelector('[data-sheet-backdrop]') as HTMLElement)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(names()).toEqual(['createOrder', 'confirmOrder'])
    await act(async () => { d.resolve(CREATED) })
  })

  it.each([
    ['created', CREATED, 'dca-sign-view-positions'],
    ['failed', { event: { type: 'order_error', orderId: 'o1', error: 'Signature rejected in wallet.' } as OrderEngineEvent, posted: false }, 'dca-sign-retry'],
  ] as const)('%s: Esc dismisses the sheet (back to the form) — the engine is not asked anything more', async (_n, outcome, primary) => {
    fake.sign = async () => outcome
    await freeze()
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    await screen.findByTestId(primary)
    esc()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(names()).toEqual(['createOrder', 'confirmOrder'])
    expect(amountInput().value).toBe('')
  })
})

describe('the draft changes under an open sheet (B5 rule, owner: auto-close)', () => {
  it('review open, a new amount: the review closes, nothing was created', async () => {
    await openReview()
    typeAmount('0.7')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fake.seq).toEqual([])
    expect(amountInput().value).toBe('0.7') // the typed value stays; only the stale review went
  })

  it('review open, a different number of buys / interval: same — the key covers the whole schedule', async () => {
    await openReview()
    fireEvent.click(screen.getByRole('button', { name: '5' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review DCA' }))
    await screen.findByTestId('dca-review-create')
    fireEvent.click(screen.getByRole('button', { name: '4h' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fake.seq).toEqual([])
  })

  it('frozen (the engine holds a review), a new amount: the frozen order is dropped (clearPendingOrder — the engine\'s own reset) and the sheet closes, nothing signed', async () => {
    await freeze()
    h.soundLog.length = 0
    typeAmount('0.7')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(names()).toEqual(['createOrder', 'clearPendingOrder'])
    expect(h.soundLog).toEqual(['stopWaitingSound'])
  })

  it('a consent given for one draft does not carry to another: the reopened review asks again', async () => {
    h.floor = offchainInfo()
    await openReview()
    fireEvent.click(screen.getByTestId('dca-consent-checkbox'))
    typeAmount('0.7')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review DCA' }))
    await screen.findByTestId('dca-review-create')
    expect((screen.getByTestId('dca-consent-checkbox') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('dca-review-create')).toHaveProperty('disabled', true)
  })
})

// ── the lifecycle hook alone: double press, silent abandon, event attribution ──

const draft = buildDcaDraft({
  tokenIn: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }, tokenOut: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
  amountIn: '500000000000000000', minAmountOut: '1200000000', maxSlippageBps: 300, expirySeconds: 2_592_000, router: '0x1111111111111111111111111111111111111111', priceInUsd: 2500, dcaInterval: 86_400, dcaTotal: 10,
})
const REVIEW: PreparedReview = { draft, info: { tier: 'onchain-feed', legs: { in: { registered: true, priced: true }, out: { registered: true, priced: true } }, registeredFeedCount: 2, effectiveCap: 250 }, symbols: [], minAmountOut: '1200000000' }
const PREPARE_OK: PrepareFn = async () => ({ ok: true, review: REVIEW })
const FROZEN = { order: {}, config: draft, computedHash: '0xab', chainId: BASE, account: '0xd44d00000000000000000000000000000000962d' } as unknown as PendingOrderReview

function engineStub(over: Partial<DcaEngineSlice> = {}): DcaEngineSlice {
  return { createOrder: vi.fn(async () => {}), pendingOrder: null, confirmOrder: vi.fn(async () => {}), clearPendingOrder: vi.fn(), isSubmitting: false, latestEvent: null, ...over }
}

describe('use-dca-lifecycle: guards', () => {
  it('double press on Create: createOrder once while the first call is in flight', async () => {
    const gate = deferred<void>()
    const engine = engineStub({ createOrder: vi.fn(() => gate.promise) })
    const { result } = renderHook(() => useDcaLifecycle(engine))
    act(() => { result.current.open(REVIEW) })
    let p1!: Promise<void>
    act(() => { p1 = result.current.create(PREPARE_OK) })
    expect(result.current.phase).toBe('creating')
    await act(async () => { await result.current.create(PREPARE_OK) }) // the second press: ignored
    expect(engine.createOrder).toHaveBeenCalledTimes(1)
    await act(async () => { gate.resolve(); await p1 })
  })

  it('double press on Sign: confirmOrder once (the engine consumes its review; the second press finds nothing frozen / a submitting engine)', () => {
    let engine = engineStub({ pendingOrder: FROZEN })
    const { result, rerender } = renderHook(() => useDcaLifecycle(engine))
    act(() => { result.current.sign() })
    engine = engineStub({ pendingOrder: null, isSubmitting: true, confirmOrder: engine.confirmOrder })
    rerender()
    expect(result.current.phase).toBe('signing')
    act(() => { result.current.sign() })
    expect(engine.confirmOrder).toHaveBeenCalledTimes(1)
  })

  it('the engine abandons the attempt silently (its chain / account reset, a guard in confirmOrder): back to the review, disarmed — a later unrelated event is NOT this attempt\'s', () => {
    let engine = engineStub({ pendingOrder: FROZEN })
    const { result, rerender } = renderHook(() => useDcaLifecycle(engine))
    act(() => { result.current.open(REVIEW) })
    act(() => { result.current.sign() })
    engine = engineStub({ pendingOrder: null, isSubmitting: false }) // dropped, no event
    rerender()
    expect(result.current.phase).toBe('review')
    engine = engineStub({ latestEvent: { type: 'order_created', orderId: 'someone-else', orderHash: '0x1' } }) // e.g. the poll, another tab
    rerender()
    expect(result.current.phase).toBe('review')
    expect(result.current.outcome).toBeNull()
  })

  it('an event that predates the press is not read as the outcome; only the one after it is', async () => {
    let engine = engineStub({ latestEvent: { type: 'order_error', orderId: 'old', error: 'old failure' } })
    const { result, rerender } = renderHook(() => useDcaLifecycle(engine))
    act(() => { result.current.open(REVIEW) })
    await act(async () => { await result.current.create(PREPARE_OK) })
    engine = engineStub({ pendingOrder: FROZEN, latestEvent: engine.latestEvent })
    rerender()
    expect(result.current.phase).toBe('frozen')
    act(() => { result.current.sign() })
    engine = engineStub({ isSubmitting: true, latestEvent: engine.latestEvent })
    rerender()
    expect(result.current.phase).toBe('signing')
    engine = engineStub({ latestEvent: { type: 'order_error', orderId: 'o1', error: 'Signature rejected in wallet.' } })
    rerender()
    expect(result.current.phase).toBe('failed')
    expect(result.current.outcome).toEqual({ kind: 'failed', error: 'Signature rejected in wallet.' })
  })
})

describe('reduced motion: the sheets add no motion of their own', () => {
  it('dca.css and modals.css declare no animation; swap.css (whose timeline classes the sign sheet reuses) keeps every `animation` inside prefers-reduced-motion: no-preference', () => {
    const dir = __dirname
    expect(readFileSync(join(dir, 'dca.css'), 'utf8')).not.toMatch(/animation\s*:/)
    expect(readFileSync(join(dir, '..', 'modals', 'modals.css'), 'utf8')).not.toMatch(/animation\s*:/)
    const css = readFileSync(join(dir, '..', 'swap', 'swap.css'), 'utf8')
    const guarded = [...css.matchAll(/@media \(prefers-reduced-motion: no-preference\)\s*\{([\s\S]*?\n\})/g)].map((m) => m[1]).join('\n')
    const decls = css.match(/animation\s*:/g) ?? []
    expect((guarded.match(/animation\s*:/g) ?? []).length).toBe(decls.length)
  })
  it('the three DCA sheets carry no animate-/transition- utility classes', () => {
    for (const f of ['DcaReviewSheet.tsx', 'DcaSignSheet.tsx', 'DcaCancelSheet.tsx']) {
      expect(readFileSync(join(__dirname, f), 'utf8'), f).not.toMatch(/animate-|transition-/)
    }
  })
})
