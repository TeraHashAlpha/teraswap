// @vitest-environment jsdom
/**
 * [ADR-025 / B6b C1] Create DCA → v1's path. v1's DCAPanel and the v2 card run on the SAME fake engine (`dca-engine-fake`: v1's
 * two-phase contract — createOrder freezes, confirmOrder signs + POSTs, one event settles) and the same mocked hooks; each tree is driven
 * the way its user drives it, and what each handed the engine — the `createOrder` config, the `confirmOrder` call, the approval hook's
 * arguments, their order and count — must be equal. Then the states: signing · created · failed (rejection, API error) · 409 reopen ·
 * approval first · wrong network · consent not ticked. No wallet, no RPC, no request: every outcome is scripted.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE, h, offchainInfo, onchainInfo, resetHarness, unpricedInfo } from './dca-harness'
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
  return { useOrderApproval: (...a: unknown[]) => (h.approvalArgs.push(a), h.approval) }
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
vi.mock('@/components/ToastProvider', async () => {
  const { h } = await import('./dca-harness')
  return { useToast: () => ({ toast: h.toast, dismiss: () => {} }) }
})
vi.mock('../shell/toasts', async () => {
  const { h } = await import('./dca-harness')
  return { useV2Toast: () => ({ toast: h.toast, dismiss: () => {}, update: () => {} }) }
})
vi.mock('@/components/TokenSelector', () => ({ default: ({ selected }: { selected: { symbol: string } | null }) => <button type="button">{selected?.symbol ?? 'Select'}</button> }))
vi.mock('../modals/TokenSheet', () => ({ TokenSheet: () => null }))

import DCAPanel from '@/components/DCAPanel'
import type { CreateOrderConfig } from '@/lib/order-engine'
import { findChainToken } from '@/lib/chains/tokens'
import { getWrappedNative } from '@/lib/chains/registry'
import { DEFAULT_MAX_SLIPPAGE_BPS, deriveSigningMinAmountOut } from '@/lib/order-engine'
import { DcaCard } from './DcaCard'
import { failureCopy, reopenTierFromError, requiredTierFromError, signSteps } from './dca-model'

const weth = () => findChainToken(getWrappedNative(BASE), BASE)!
const WETH_BALANCE = { raw: 2_000_000_000_000_000_000n, formatted: '2.0' }
const REJECTED: SignOutcome = { event: { type: 'order_error', orderId: 'o1', error: 'Signature rejected in wallet.' }, posted: false }
const SERVER_409 = (tier: string): SignOutcome => ({ event: { type: 'order_error', orderId: 'o1', error: `Acknowledgement required: this pair is "${tier}". Resubmit with floorAck.tier = "${tier}".` }, posted: true })

beforeEach(() => {
  resetHarness()
  resetFake()
  h.balances = new Map([[weth().address.toLowerCase(), WETH_BALANCE]])
})
afterEach(cleanup)

const typeAmount = (container: HTMLElement, v: string) => fireEvent.change(container.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value: v } })
const config = (i: number) => fake.seq[i][1] as CreateOrderConfig
/** `floorAck.acknowledgedAt` is `new Date()` at the click in each tree: compared as present, not equal. */
function norm(seq: typeof fake.seq) {
  return seq.map(([name, arg]) => {
    if (name !== 'createOrder') return [name]
    const c = arg as CreateOrderConfig
    return [name, c.floorAck ? { ...c, floorAck: { tier: c.floorAck.tier, acknowledgedAt: 'ISO' } } : c]
  })
}

/** v1: type → Start DCA → (consent dialog) → the EIP-712 modal is up. */
async function v1ToModal(consent: boolean) {
  const view = render(<DCAPanel chainId={BASE} />)
  await act(async () => {})
  typeAmount(view.container, '0.5')
  fireEvent.click(screen.getByRole('button', { name: /^Start DCA/ }))
  if (consent) {
    await screen.findByTestId('floor-consent-dialog')
    fireEvent.click(screen.getByTestId('floor-consent-checkbox'))
    fireEvent.click(screen.getByTestId('floor-consent-confirm'))
  }
  await screen.findByTestId('order-review-body')
  return view
}
/** v2: type → Review DCA → (consent block) → Create DCA → the sign sheet is up. */
async function v2ToReview() {
  const view = render(<DcaCard chainId={BASE} />)
  await act(async () => {})
  typeAmount(view.container, '0.5')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review DCA' })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: 'Review DCA' }))
  await screen.findByTestId('dca-review-create')
  return view
}
async function v2ToSheet(consent: boolean) {
  const view = await v2ToReview()
  if (consent) fireEvent.click(screen.getByTestId('dca-consent-checkbox'))
  fireEvent.click(screen.getByTestId('dca-review-create'))
  await screen.findByTestId('dca-sign-body')
  return view
}
const dialog = () => screen.getByRole('dialog')

// ── (1)+(2) v1 and v2 hand the engine the same calls ──────────────────────────

describe('arg equality: v1 DCAPanel and the v2 card on one engine', () => {
  it.each([
    ['standard (on-chain feed)', onchainInfo(), false],
    ['offchain-price + consent', offchainInfo(), true],
    ['unpriced + consent', unpricedInfo(), true],
  ] as const)('%s: createOrder(config) once, then confirmOrder() once — same config, same order, same sounds, one POST', async (_n, info, consent) => {
    h.floor = info
    await v1ToModal(consent)
    const v1Approval = h.approvalArgs.at(-1) // what v1's modal asked while it was up
    fireEvent.click(screen.getByTestId('order-confirm'))
    await waitFor(() => expect(h.soundLog).toContain('playSwapConfirmMP3'))
    const v1Seq = norm(fake.seq)
    const v1Sounds = [...h.soundLog]
    const v1Toasts = h.toast.mock.calls.map((c) => c[0])
    const v1Posts = fake.posts.length
    cleanup()
    resetFake()
    h.soundLog.length = 0
    h.toast.mockClear()
    h.approvalArgs = []

    await v2ToSheet(consent)
    const v2Approval = h.approvalArgs.at(-1) // what the v2 sheet asked while the order was frozen
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    await screen.findByTestId('dca-sign-view-positions')

    expect(norm(fake.seq)).toEqual(v1Seq)
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder', 'confirmOrder'])
    expect(config(0).floorAck?.tier).toBe(consent ? info.tier : undefined)
    expect(fake.posts.length).toBe(v1Posts)
    expect(fake.posts.length).toBe(1)
    expect(h.soundLog).toEqual(v1Sounds)
    expect(h.toast.mock.calls.map((c) => c[0])).toEqual(v1Toasts)
    // the approve-then-sign gate asked v1's question: the FROZEN token, the FULL total, the frozen chain, the v3 predicate —
    // and once the order left the review the v2 sheet idles the read (v1 unmounts its modal there)
    expect(v2Approval).toEqual(v1Approval)
    expect(v1Approval).toEqual([weth().address, 500000000000000000n, BASE, true])
    expect(h.approvalArgs.at(-1)).toEqual([undefined, 500000000000000000n, BASE, true])
  })

  it('approval first: Approve {sym} (v1 OrderReviewModal) is the one press, then Confirm & Sign Order — both trees, same calls', async () => {
    h.approval = { ...h.approval, needsApproval: true, isApproved: false }
    const ready = () => { h.approval = { ...h.approval, needsApproval: false, isApproved: true, status: 'ready' } }

    const v1 = await v1ToModal(false)
    expect(screen.queryByTestId('order-confirm')).toBeNull()
    fireEvent.click(screen.getByTestId('order-approve'))
    expect(h.approval.approve).toHaveBeenCalledTimes(1)
    ready()
    v1.rerender(<DCAPanel chainId={BASE} />)
    fireEvent.click(await screen.findByTestId('order-confirm'))
    await waitFor(() => expect(fake.seq.map((c) => c[0])).toEqual(['createOrder', 'confirmOrder']))
    const v1Seq = norm(fake.seq)
    cleanup()
    resetFake()
    h.approval = { ...h.approval, needsApproval: true, isApproved: false, status: 'idle', approve: vi.fn(async () => {}) }

    const v2 = await v2ToSheet(false)
    expect(screen.queryByTestId('dca-sign-confirm')).toBeNull()
    expect(screen.getByTestId('dca-sign-approve').textContent).toBe('Approve WETH')
    expect(screen.getByTestId('dca-sign-note').textContent).toMatch(/^Two steps: first approve the exact 0.5 WETH on-chain/)
    fireEvent.click(screen.getByTestId('dca-sign-approve'))
    expect(h.approval.approve).toHaveBeenCalledTimes(1)
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder'])
    ready()
    v2.rerender(<DcaCard chainId={BASE} />)
    const confirm = await screen.findByTestId('dca-sign-confirm')
    expect(confirm.textContent).toBe('Confirm & Sign Order')
    expect(screen.getByTestId('dca-sign-note').textContent).toMatch(/^Approved on-chain — now sign the order/)
    fireEvent.click(confirm)
    await screen.findByTestId('dca-sign-view-positions')
    expect(norm(fake.seq)).toEqual(v1Seq)
  })
})

// ── consent ───────────────────────────────────────────────────────────────────

describe('consent gates the call', () => {
  it('unpriced, box not ticked: Create DCA is disabled and a press reaches no hook', async () => {
    h.floor = unpricedInfo()
    await v2ToReview()
    const cta = screen.getByTestId('dca-review-create')
    expect(cta).toHaveProperty('disabled', true)
    fireEvent.click(cta)
    expect(fake.seq).toEqual([])
    expect(screen.queryByTestId('dca-sign-body')).toBeNull()
  })
})

// ── states ────────────────────────────────────────────────────────────────────

describe('signing → created', () => {
  it('Confirm & Sign Order: the SAME sheet turns busy ("Signing order...", aria-disabled, not disabled), then says what v1\'s toast says', async () => {
    const d = deferred<SignOutcome>()
    fake.sign = () => d.promise
    await v2ToSheet(false)
    const dlg = dialog()
    const confirm = within(dlg).getByTestId('dca-sign-confirm')
    confirm.focus()
    fireEvent.click(confirm)
    const busy = await within(dlg).findByRole('button', { name: 'Signing order...' })
    expect(screen.getByRole('dialog')).toBe(dlg)
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    expect((busy as HTMLButtonElement).disabled).toBe(false)
    expect(document.activeElement).toBe(busy)
    expect(screen.getByTestId('dca-sign-body').getAttribute('data-phase')).toBe('signing')
    expect(dlg.querySelector('[aria-current="step"]')?.textContent).toContain('Signing order...')
    // nothing settled yet: no sound, no toast beyond the press
    expect(h.soundLog).not.toContain('playSwapConfirmMP3')

    await act(async () => { d.resolve({ event: { type: 'order_created', orderId: 'o1', orderHash: '0xhash' }, posted: true }) })
    expect(screen.getByRole('dialog')).toBe(dlg)
    expect(within(dlg).getByRole('heading', { level: 2 }).textContent).toBe('DCA order placed')
    expect(dlg.textContent).toContain('Your DCA is live — it will execute automatically on schedule.')
    expect(within(dlg).getByTestId('dca-sign-amountin').textContent).toBe('Total to spend0.5 WETH')
    expect(within(dlg).getByTestId('dca-sign-perbuy').textContent).toBe('Per buy0.05 WETH')
    expect(within(dlg).getByTestId('dca-sign-dca').textContent).toBe('Schedule86400s × 10 buys')
    expect(within(dlg).queryByTestId('dca-sign-nonce')).toBeNull()
    expect(h.soundLog.slice(-2)).toEqual(['stopWaitingSound', 'playSwapConfirmMP3'])
    expect(h.toast.mock.calls.map((c) => (c[0] as { title: string }).title)).toEqual(['DCA order placed'])
    expect(document.activeElement).toBe(within(dlg).getByTestId('dca-sign-view-positions'))

    fireEvent.click(screen.getByTestId('dca-sign-view-positions'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('dca-empty')).toBeTruthy() // the Positions tab (the fake stores nothing)
    fireEvent.click(screen.getByRole('tab', { name: 'New DCA' }))
    expect((document.querySelector('input[inputmode="decimal"]') as HTMLInputElement).value).toBe('') // v1: setTotalDisplay('') after onSubmit
  })

  it('the waiting loop: starts at the form press, is NOT restarted by Create on the on-chain tier, IS restarted after a consent (v1 :825), ends with the event', async () => {
    h.floor = offchainInfo()
    await v2ToReview()
    expect(h.soundLog).toEqual(['playTouchMP3', 'startWaitingSound', 'stopWaitingSound'])
    fireEvent.click(screen.getByTestId('dca-consent-checkbox'))
    fireEvent.click(screen.getByTestId('dca-review-create'))
    await screen.findByTestId('dca-sign-body')
    expect(h.soundLog).toEqual(['playTouchMP3', 'startWaitingSound', 'stopWaitingSound', 'startWaitingSound'])
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    await screen.findByTestId('dca-sign-view-positions')
    expect(h.soundLog).toEqual(['playTouchMP3', 'startWaitingSound', 'stopWaitingSound', 'startWaitingSound', 'stopWaitingSound', 'playSwapConfirmMP3'])
  })
})

describe('failure', () => {
  it('the wallet rejects: no POST, v1\'s text verbatim, v1\'s sounds (stop + cancel), Retry re-runs the create step and sends a FRESH config (equal in value, never the same object — A70 M-1)', async () => {
    fake.sign = async () => REJECTED
    await v2ToSheet(false)
    const dlg = dialog()
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    const retry = await within(dlg).findByTestId('dca-sign-retry')
    expect(screen.getByRole('dialog')).toBe(dlg)
    expect(fake.posts).toEqual([])
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder', 'confirmOrder'])
    expect(within(dlg).getByRole('heading', { level: 2 }).textContent).toBe('DCA order failed')
    expect(within(dlg).getByTestId('dca-sign-error').textContent).toContain('Signature rejected in wallet.')
    expect(h.soundLog.slice(-2)).toEqual(['stopWaitingSound', 'playCancelOrderMP3'])
    expect(h.toast.mock.calls.map((c) => c[0])).toEqual([{ type: 'error', title: 'DCA order failed', description: 'Signature rejected in wallet.' }])
    expect(dlg.querySelector('[data-step="failed"]')?.textContent).toContain('Signing order...')
    expect(document.activeElement).toBe(retry)
    expect(retry.textContent).toBe('Start DCA — 10 buys over 10.0 days') // owner 2026-10-30: v1's form CTA wording, from the frozen struct

    fake.sign = async () => ({ event: { type: 'order_created', orderId: 'o2', orderHash: '0xhash2' }, posted: true })
    fireEvent.click(retry)
    await screen.findByTestId('dca-sign-confirm')
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder', 'confirmOrder', 'createOrder'])
    expect(fake.seq[2][1]).not.toBe(fake.seq[0][1]) // A70 M-1: built again by prepare(), not the draft the review opened on
    expect(fake.seq[2][1]).toEqual(fake.seq[0][1]) // nothing moved: v1's handleCreate would build the same values
    expect(h.soundLog.at(-1)).toBe('startWaitingSound') // v1: Start pressed again → the loop starts again
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    await screen.findByTestId('dca-sign-view-positions')
    expect(fake.posts.length).toBe(1)
  })

  it('API error after the signature: one confirmOrder for any number of presses / Esc / Cancel while signing; the server\'s text verbatim', async () => {
    const d = deferred<SignOutcome>()
    fake.sign = () => d.promise
    await v2ToSheet(false)
    const dlg = dialog()
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    const busy = await within(dlg).findByRole('button', { name: 'Signing order...' })
    fireEvent.click(busy)
    fireEvent.click(busy)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(within(dlg).getByTestId('dca-sign-secondary'))
    fireEvent.click(document.querySelector('[data-sheet-backdrop]') as HTMLElement)
    expect(screen.getByRole('dialog')).toBe(dlg)
    expect(fake.seq.filter((c) => c[0] === 'confirmOrder').length).toBe(1)
    expect(fake.seq.filter((c) => c[0] === 'clearPendingOrder').length).toBe(0)

    await act(async () => { d.resolve({ event: { type: 'order_error', orderId: 'o1', error: 'Order could not be stored (503)' }, posted: true }) })
    expect(within(dlg).getByTestId('dca-sign-error').textContent).toContain('Order could not be stored (503)')
    expect(fake.posts.length).toBe(1)
    expect(fake.seq.filter((c) => c[0] === 'confirmOrder').length).toBe(1)
  })

  it('the freeze-403 reads as v1\'s pause, not a failure', () => {
    expect(failureCopy('New DCA orders are temporarily paused while…')).toEqual({ title: 'DCA temporarily paused', description: 'Only new DCA orders are paused — your existing ones keep running.' })
    expect(failureCopy('boom')).toEqual({ title: 'DCA order failed', description: 'boom' })
    expect(failureCopy(null)).toEqual({ title: 'DCA order failed', description: 'Order could not be submitted.' })
  })
})

// ── A70 M-1: Create and Retry re-run v1's whole create step ───────────────────

const oracle = (chainlinkPrice: number | null, over: Record<string, unknown> = {}) => ({ ...h.oracle, chainlinkPrice, ...over })
/** The floor v1's `handleCreate` derives for 0.5 WETH → USDC at the given Chainlink WETH price (USDC = 1): the same lib call, the same inputs. */
const v1Floor = (priceIn: number) =>
  deriveSigningMinAmountOut({
    amountIn: 500_000_000_000_000_000n, srcDecimals: 18, dstDecimals: 6, maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
    chainlinkPriceIn: priceIn, chainlinkPriceOut: 1, defiLlamaPriceIn: null, defiLlamaPriceOut: null,
  }).minAmountOut

describe('A70 M-1 · Retry and Create build the draft afresh', () => {
  it('Retry, a gate closed since the failure (depeg): v1 would stop before the wallet — no second createOrder, the sheets give way to the form and its banner', async () => {
    fake.sign = async () => REJECTED
    const view = await v2ToSheet(false)
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    const retry = await screen.findByTestId('dca-sign-retry')
    h.depeg = { mode: 'block', divergence: 12, symbol: 'WETH', message: 'WETH trades 12% off its exchange rate.' }
    view.rerender(<DcaCard chainId={BASE} />)
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder', 'confirmOrder']) // no #2
    expect(screen.getByTestId('dca-depeg-block').textContent).toContain('DCA blocked — WETH depeg.')
    expect(h.soundLog.at(-1)).not.toBe('startWaitingSound') // nothing left running
  })

  it('Create, a gate closed since the review opened (oracle): nothing reaches the engine, the review closes onto the form\'s banner', async () => {
    const view = await v2ToReview()
    h.oracle = oracle(null, { oracleUnavailable: true, oracleIntegrityFailed: true, message: 'Chainlink answer failed integrity checks.' })
    view.rerender(<DcaCard chainId={BASE} />)
    // the draft key does not hold the price-FEED STATUS: the review may still be up — the press is what must stop
    const create = screen.queryByTestId('dca-review-create')
    if (create) fireEvent.click(create)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fake.seq).toEqual([])
    expect(screen.getByTestId('dca-oracle-block')).toBeTruthy()
  })

  it('Create, the pair\'s tier moved since the review opened (on-chain → unpriced): no createOrder; the review asks for the consent, box unticked', async () => {
    await v2ToReview()
    expect(screen.queryByTestId('dca-consent')).toBeNull()
    h.floor = unpricedInfo()
    fireEvent.click(screen.getByTestId('dca-review-create'))
    const consent = await screen.findByTestId('dca-consent')
    expect(consent.getAttribute('data-tier')).toBe('unpriced')
    expect((screen.getByTestId('dca-consent-checkbox') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('dca-review-create')).toHaveProperty('disabled', true)
    expect(fake.seq).toEqual([])
    fireEvent.click(screen.getByTestId('dca-consent-checkbox'))
    fireEvent.click(screen.getByTestId('dca-review-create'))
    await screen.findByTestId('dca-sign-body')
    expect(config(0).floorAck?.tier).toBe('unpriced')
  })

  it('a price moves while the review is open: the review closes (the draft key holds the prices prepare() reads)', async () => {
    const view = await v2ToReview()
    h.oracle = oracle(2600)
    view.rerender(<DcaCard chainId={BASE} />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fake.seq).toEqual([])
  })

  it('a price moves while the order is FROZEN: the sign sheet stays (it prints the exact struct); only the review is price-keyed', async () => {
    const view = await v2ToSheet(false)
    h.oracle = oracle(2600)
    view.rerender(<DcaCard chainId={BASE} />)
    expect(screen.getByTestId('dca-sign-body').getAttribute('data-phase')).toBe('frozen')
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder'])
  })

  it('Retry, the price moved: signs the NEW floor — bigint-equal to what v1\'s handleCreate derives for the same inputs (and to v1\'s own createOrder config)', async () => {
    fake.sign = async () => REJECTED
    const view = await v2ToSheet(false)
    const oldFloor = BigInt(config(0).minAmountOut)
    expect(oldFloor).toBe(v1Floor(2500))
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    const retry = await screen.findByTestId('dca-sign-retry')
    h.oracle = oracle(2600)
    view.rerender(<DcaCard chainId={BASE} />)
    fireEvent.click(retry)
    await screen.findByTestId('dca-sign-confirm')
    const v2Floor = BigInt(config(2).minAmountOut)
    expect(v2Floor).toBe(v1Floor(2600))
    expect(v2Floor).not.toBe(oldFloor)
    expect(config(2).priceInUsd).toBe(2600) // the spend-leg price travels with it (v1: livePriceIn)
    // …and v1's own panel, same mocked answers, hands createOrder the same floor
    cleanup()
    resetFake()
    await v1ToModal(false)
    expect(BigInt(config(0).minAmountOut)).toBe(v2Floor)
  })

  it('consent is asked again after a failure: Retry returns to the review with the box UNTICKED, no createOrder until it is ticked, and the new call carries a fresh acknowledgement', async () => {
    h.floor = unpricedInfo()
    fake.sign = async () => REJECTED
    await v2ToSheet(true)
    const firstAck = config(0).floorAck
    expect(firstAck?.tier).toBe('unpriced')
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    fireEvent.click(await screen.findByTestId('dca-sign-retry'))
    const box = (await screen.findByTestId('dca-consent-checkbox')) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(screen.getByTestId('dca-review-create')).toHaveProperty('disabled', true)
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder', 'confirmOrder']) // the old ack was NOT reused
    fireEvent.click(box)
    fireEvent.click(screen.getByTestId('dca-review-create'))
    await screen.findByTestId('dca-sign-body')
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder', 'confirmOrder', 'createOrder'])
    expect(config(2).floorAck?.tier).toBe('unpriced')
    expect(config(2).floorAck).not.toBe(firstAck)
  })
})

describe('409: the server names a stronger tier → the review reopens for it, the next Create carries that ack', () => {
  it('on-chain client tier, server says "unpriced": consent block (unpriced, focused, unticked) → tick → Create → createOrder #2 = #1 + floorAck.unpriced → signed', async () => {
    h.floor = onchainInfo()
    let signs = 0
    fake.sign = async () => (++signs === 1 ? SERVER_409('unpriced') : { event: { type: 'order_created', orderId: 'o1', orderHash: '0xhash' }, posted: true })
    await v2ToSheet(false)
    expect(config(0).floorAck).toBeUndefined()
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))

    const consent = await screen.findByTestId('dca-consent')
    expect(consent.getAttribute('data-tier')).toBe('unpriced')
    expect(screen.queryByTestId('dca-sign-body')).toBeNull()
    const box = screen.getByTestId('dca-consent-checkbox') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(document.activeElement).toBe(box)
    expect(screen.getByTestId('dca-review-create')).toHaveProperty('disabled', true)
    // v1 toasts the server's sentence (its effect); so does v2, then goes further
    expect(h.toast.mock.calls.map((c) => (c[0] as { title: string }).title)).toEqual(['DCA order failed'])
    expect(h.soundLog.slice(-2)).toEqual(['stopWaitingSound', 'playCancelOrderMP3'])

    fireEvent.click(box)
    fireEvent.click(screen.getByTestId('dca-review-create'))
    await screen.findByTestId('dca-sign-body')
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder', 'confirmOrder', 'createOrder'])
    const { floorAck, ...rest } = config(2)
    expect(floorAck?.tier).toBe('unpriced')
    expect(rest).toEqual(config(0))
    expect(h.soundLog.at(-1)).toBe('startWaitingSound') // v1 :825 after a consent
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    await screen.findByTestId('dca-sign-view-positions')
    expect(fake.posts.map((p) => (p as { floorAck?: { tier: string } }).floorAck?.tier)).toEqual([undefined, 'unpriced'])
  })

  it('pure: the tier is read from the server\'s own sentence; anything else is a plain failure', () => {
    expect(requiredTierFromError('Acknowledgement required: this pair is "unpriced". Resubmit with floorAck.tier = "unpriced".')).toBe('unpriced')
    expect(requiredTierFromError('Acknowledgement required: this pair is "offchain-price". Resubmit with floorAck.tier = "offchain-price".')).toBe('offchain-price')
    expect(requiredTierFromError('Signature rejected in wallet.')).toBeNull()
    expect(requiredTierFromError('this pair is "unpriced"')).toBeNull()
    expect(requiredTierFromError(null)).toBeNull()
  })
})

describe('A70 L-1 · a 409 that asks for an acknowledgement but does not parse reopens consent at the strictest tier', () => {
  const UNPARSED = 'Acknowledgement required: tier could not be determined. Resubmit with a floorAck.'
  const errorOutcome = (error: string): SignOutcome => ({ event: { type: 'order_error', orderId: 'o1', error }, posted: true })

  it('pure: parsed → its tier · starts "Acknowledgement required" but unparsed → unpriced · everything else → null', () => {
    expect(reopenTierFromError('Acknowledgement required: this pair is "offchain-price". Resubmit with floorAck.tier = "offchain-price".')).toBe('offchain-price')
    expect(reopenTierFromError('Acknowledgement required: this pair is "unpriced". Resubmit with floorAck.tier = "unpriced".')).toBe('unpriced')
    expect(reopenTierFromError(UNPARSED)).toBe('unpriced')
    expect(reopenTierFromError('Acknowledgement required')).toBe('unpriced')
    expect(reopenTierFromError('Acknowledgement required: this pair is "mystery". Resubmit')).toBe('unpriced')
    for (const other of ['Order already exists (409)', 'Signature rejected in wallet.', 'acknowledgement required', 'Your acknowledgement required this', '', null, undefined]) {
      expect(reopenTierFromError(other)).toBeNull()
    }
    expect(requiredTierFromError(UNPARSED)).toBeNull() // the strict parser is unchanged
  })

  it('offchain-price ack refused with an unparsed sentence: consent reopens at UNPRICED (unticked, focused), no failure sheet, no Retry; the next call carries a fresh unpriced ack — the refused one is never resent', async () => {
    h.floor = offchainInfo()
    let signs = 0
    fake.sign = async () => (++signs === 1 ? errorOutcome(UNPARSED) : { event: { type: 'order_created', orderId: 'o1', orderHash: '0xhash' }, posted: true })
    await v2ToSheet(true)
    expect(config(0).floorAck?.tier).toBe('offchain-price')
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    const consent = await screen.findByTestId('dca-consent')
    expect(consent.getAttribute('data-tier')).toBe('unpriced')
    expect(screen.queryByTestId('dca-sign-retry')).toBeNull()
    expect(screen.queryByTestId('dca-sign-body')).toBeNull()
    const box = screen.getByTestId('dca-consent-checkbox') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(screen.getByTestId('dca-review-create')).toHaveProperty('disabled', true)
    fireEvent.click(box)
    fireEvent.click(screen.getByTestId('dca-review-create'))
    await screen.findByTestId('dca-sign-body')
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder', 'confirmOrder', 'createOrder'])
    expect(config(2).floorAck?.tier).toBe('unpriced')
    expect(config(2).floorAck).not.toBe(config(0).floorAck)
  })

  it('a random 409 (not an acknowledgement) stays a plain failure with Retry; Retry then re-asks consent on a weaker tier — never resends the old ack', async () => {
    h.floor = offchainInfo()
    fake.sign = async () => errorOutcome('Order already exists (409)')
    await v2ToSheet(true)
    fireEvent.click(screen.getByTestId('dca-sign-confirm'))
    const retry = await screen.findByTestId('dca-sign-retry')
    expect(screen.getByTestId('dca-sign-error').textContent).toContain('Order already exists (409)')
    expect(screen.queryByTestId('dca-consent')).toBeNull()
    fireEvent.click(retry)
    const box = (await screen.findByTestId('dca-consent-checkbox')) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(fake.seq.map((c) => c[0])).toEqual(['createOrder', 'confirmOrder'])
  })
})

describe('wrong network under the review', () => {
  it('the wallet moves to another chain: Create becomes v1\'s switch action (Switch to Base → switchChain), nothing is created', async () => {
    const view = await v2ToReview()
    h.account = { ...h.account, chain: { id: 1 } }
    view.rerender(<DcaCard chainId={BASE} />)
    expect(screen.queryByTestId('dca-review-create')).toBeNull()
    const sw = screen.getByTestId('dca-review-switch')
    expect(sw.textContent).toBe('Switch to Base')
    fireEvent.click(sw)
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: BASE })
    expect(fake.seq).toEqual([])
    h.account = { ...h.account, chain: { id: BASE } }
    view.rerender(<DcaCard chainId={BASE} />)
    expect(screen.getByTestId('dca-review-create')).toBeTruthy()
  })
})

describe('the sign sheet is v1\'s OrderReviewModal, word for word', () => {
  it('timeline: v1\'s words only, in v1\'s order', () => {
    expect(signSteps({ phase: 'frozen', approvalListed: true, approvalReady: false, symbolIn: 'WETH' })).toEqual([
      { label: 'Approve WETH', state: 'active' }, { label: 'Signing order...', state: 'todo' }, { label: 'DCA order placed', state: 'todo' },
    ])
    expect(signSteps({ phase: 'frozen', approvalListed: true, approvalReady: true, symbolIn: 'WETH' }).map((s) => s.state)).toEqual(['done', 'active', 'todo'])
    expect(signSteps({ phase: 'signing', approvalListed: false, approvalReady: true, symbolIn: 'WETH' })).toEqual([{ label: 'Signing order...', state: 'active' }, { label: 'DCA order placed', state: 'todo' }])
    expect(signSteps({ phase: 'created', approvalListed: false, approvalReady: true, symbolIn: 'WETH' }).map((s) => s.state)).toEqual(['done', 'done'])
    expect(signSteps({ phase: 'failed', approvalListed: true, approvalReady: true, symbolIn: 'WETH' }).map((s) => s.state)).toEqual(['done', 'failed', 'todo'])
  })

  it('every visible text of v1\'s modal for the same frozen order is in the v2 sheet (rows, note, buttons)', async () => {
    await v1ToModal(false)
    const v1Text = (screen.getByRole('dialog').textContent ?? '').replace(/\s+/g, ' ')
    cleanup()
    resetFake()
    await v2ToSheet(false)
    const v2Text = (screen.getByRole('dialog').textContent ?? '').replace(/\s+/g, ' ')
    for (const s of ['DCA (recurring buy)', 'sign an autonomous order', 'Pair', 'WETH → USDC', 'Total to spend', '0.5 WETH', 'Per buy', '0.05 WETH', 'Minimum received', 'Schedule', '86400s × 10 buys', 'Expires', 'Router (constraint)', 'Nonce', '7', 'Price feed (oracle)', 'Route constraint hash', 'Approved on-chain — now sign the order.', 'Confirm & Sign Order', 'Cancel']) {
      expect(v1Text, `v1 lacks "${s}"`).toContain(s)
      expect(v2Text, `v2 lacks "${s}"`).toContain(s)
    }
  })
})
