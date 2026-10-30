// @vitest-environment jsdom
/**
 * [ADR-025] B6a commit 2 — the review sheet, the consent block and the Positions list.
 *   (4) consent GATES the CTA (both weaker tiers), its words are v1's with the real {N} / symbols / cap, a 409 REOPENS it for the tier
 *       the server named (never a weaker one); the CTA hands the acknowledged draft to `onCreate` — v1's `createOrder`, wired by the card (B6b);
 *   the list shows v1's fields for the SAME order objects v1's DCADashboard renders; the empty state is v1's; Cancel is the v1 hook.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent } from '../__tests__/content-parity'
import { BASE, h, offchainInfo, onchainInfo, resetHarness, unpricedInfo } from './dca-harness'

vi.mock('wagmi', async () => {
  const { h } = await import('./dca-harness')
  const actual = await vi.importActual<typeof import('wagmi')>('wagmi')
  return { ...actual, useAccount: () => h.account, useChainId: () => 8453, useSwitchChain: () => ({ switchChain: h.switchChain, switchChainAsync: vi.fn() }) }
})
vi.mock('@/lib/sounds', async () => {
  const { h } = await import('./dca-harness')
  return { ...h.sounds }
})
vi.mock('@/hooks/useOrderExecutions', () => ({ useOrderExecutions: () => ({ executions: [], lastFillAtMs: null, orderMeta: null, loading: false }) }))
vi.mock('@/components/dca/SettlementReceiptModal', () => ({ default: () => null, isReceiptEligible: () => false }))
vi.mock('@/components/dca/DCAPositionStats', () => ({ default: () => null }))
vi.mock('@/components/dca/TokenPairLogos', () => ({ default: ({ tokenInSymbol, tokenOutSymbol }: { tokenInSymbol: string; tokenOutSymbol: string }) => <span>{tokenInSymbol} → {tokenOutSymbol}</span> }))

import DCADashboard from '@/components/dca/DCADashboard'
import { FLOOR_CONSENT_CHECKBOX, FLOOR_CONSENT_HEADING, floorConsentCopy } from '@/components/dca/DcaFloorConsentDialog'
import { buildDcaDraft, reopenTier } from './dca-model'
import { DcaReviewSheet, type DcaReviewView } from './DcaReviewSheet'
import { DcaOrdersList, EMPTY_BODY, EMPTY_CTA, EMPTY_TITLE } from './DcaOrdersList'
import type { PreparedReview } from './use-dca-form'
import { findChainToken, getCanonicalUsdc } from '@/lib/chains/tokens'
import { getWrappedNative } from '@/lib/chains/registry'
import { OrderType, type AutonomousOrder } from '@/lib/order-engine'

beforeEach(resetHarness)
afterEach(cleanup)

const weth = () => findChainToken(getWrappedNative(BASE), BASE)!
const usdc = () => getCanonicalUsdc(BASE)!

function reviewFor(info: PreparedReview['info']): PreparedReview {
  const draft = buildDcaDraft({
    tokenIn: weth(), tokenOut: usdc(), amountIn: '500000000000000000', minAmountOut: '1200000000', maxSlippageBps: 300,
    expirySeconds: 2_592_000, router: '0x1111111111111111111111111111111111111111', priceInUsd: 2500, dcaInterval: 86_400, dcaTotal: 10,
  })
  return { draft, info, symbols: ['USDC'], minAmountOut: '1200000000' }
}
const VIEW: DcaReviewView = {
  symbolIn: 'WETH', symbolOut: 'USDC', chainName: 'Base', total: '0.5', perBuy: '0.05', buys: 10, every: '1d', duration: '10.0 days', expires: '30d',
  floorTotal: '1 200', floorPerBuy: '120',
}

describe('review sheet · consent gates the CTA (server tier = authority)', () => {
  it('on-chain feed: nothing to consent to — Create DCA is live and hands over the draft WITHOUT an acknowledgement', () => {
    const onCreate = vi.fn()
    render(<DcaReviewSheet review={reviewFor(onchainInfo())} view={VIEW} onCreate={onCreate} onClose={() => {}} />)
    expect(screen.queryByTestId('dca-consent')).toBeNull()
    const cta = screen.getByRole('button', { name: 'Create DCA' })
    expect(cta).toHaveProperty('disabled', false)
    fireEvent.click(cta)
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0]).toEqual(reviewFor(onchainInfo()).draft)
    expect(onCreate.mock.calls[0][0].floorAck).toBeUndefined()
  })

  it.each([
    ['unpriced', unpricedInfo({ registeredFeedCount: 3, effectiveCap: 250 })],
    ['offchain-price', offchainInfo({ registeredFeedCount: 2 })],
  ] as const)('%s: the consent block gates Create DCA; ticking it acknowledges THAT tier', (tier, info) => {
    const onCreate = vi.fn()
    render(<DcaReviewSheet review={reviewFor(info)} view={VIEW} onCreate={onCreate} onClose={() => {}} />)
    const cta = screen.getByRole('button', { name: 'Create DCA' })
    expect(cta).toHaveProperty('disabled', true)
    fireEvent.click(cta)
    expect(onCreate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dca-consent-checkbox'))
    expect(cta).toHaveProperty('disabled', false)
    fireEvent.click(cta)
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0].floorAck.tier).toBe(tier)
    expect(Number.isFinite(Date.parse(onCreate.mock.calls[0][0].floorAck.acknowledgedAt))).toBe(true)
  })

  it('the words are v1\'s: heading, checkbox label and body (real {N}, symbols and cap) come from v1\'s own exports', () => {
    const info = unpricedInfo({ registeredFeedCount: 3, effectiveCap: 250 })
    render(<DcaReviewSheet review={reviewFor(info)} view={VIEW} onCreate={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('dca-consent-heading').textContent).toBe(FLOOR_CONSENT_HEADING)
    expect(screen.getByTestId('dca-consent-checkbox').closest('label')?.textContent).toBe(FLOOR_CONSENT_CHECKBOX)
    const body = screen.getByTestId('dca-consent-body').textContent
    expect(body).toBe(floorConsentCopy({ tier: 'unpriced', symbols: ['USDC'], effectiveCapUsd: 250, registeredFeedCount: 3 }))
    expect(body).toContain('3 tokens on this network have')
    expect(body).toContain('each buy is capped at $250 and flagged')
  })

  it('the cap line (the tier line) shows the REAL cap, clamped to v1\'s ceiling', () => {
    render(<DcaReviewSheet review={reviewFor(unpricedInfo({ effectiveCap: 100 }))} view={VIEW} onCreate={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('dca-review-tier').textContent).toContain('No market price source right now — buys capped at $100 and flagged')
    expect(screen.getByTestId('dca-consent-body').textContent).toContain('capped at $100')
  })

  it('shows the schedule table: total, per buy, buys, execution, duration, expiry, the signed floor and Protection', () => {
    render(<DcaReviewSheet review={reviewFor(offchainInfo())} view={VIEW} onCreate={() => {}} onClose={() => {}} />)
    const t = (id: string) => screen.getByTestId(id).textContent
    expect(t('dca-review-total')).toContain('0.5 WETH')
    expect(t('dca-review-per-buy')).toContain('0.05 WETH')
    expect(t('dca-review-buys')).toContain('10')
    expect(t('dca-review-every')).toContain('Every 1d')
    expect(t('dca-review-duration')).toContain('10.0 days')
    expect(t('dca-review-expires')).toContain('30d')
    expect(t('dca-review-floor')).toContain('≥ 1 200 USDC — ≥ 120 USDC enforced per buy')
    expect(t('dca-review-protection')).toContain('Off-chain check')
  })
})

describe('review sheet · a 409 reopens the consent', () => {
  it('pure: reopenTier names only a STRONGER tier than the one already asked', () => {
    expect(reopenTier(null, 'offchain-price')).toBe('offchain-price')
    expect(reopenTier(null, 'unpriced')).toBe('unpriced')
    expect(reopenTier('offchain-price', 'unpriced')).toBe('unpriced')
    expect(reopenTier('unpriced', 'offchain-price')).toBeNull()
    expect(reopenTier('unpriced', 'unpriced')).toBeNull()
    expect(reopenTier(null, 'onchain-feed')).toBeNull()
    expect(reopenTier(null, undefined)).toBeNull()
    expect(reopenTier(null, 'garbage')).toBeNull()
  })

  it('on-chain feed + 409 requiredTier "unpriced": the consent block opens, the CTA locks again, ticking acknowledges the NEW tier', () => {
    const onCreate = vi.fn()
    const review = reviewFor(onchainInfo())
    const { rerender } = render(<DcaReviewSheet review={review} view={VIEW} onCreate={onCreate} onClose={() => {}} />)
    expect(screen.queryByTestId('dca-consent')).toBeNull()
    rerender(<DcaReviewSheet review={review} view={VIEW} conflictTier="unpriced" onCreate={onCreate} onClose={() => {}} />)
    expect(screen.getByTestId('dca-consent').getAttribute('data-tier')).toBe('unpriced')
    expect(screen.getByRole('button', { name: 'Create DCA' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByTestId('dca-consent-checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Create DCA' }))
    expect(onCreate.mock.calls[0][0].floorAck.tier).toBe('unpriced')
  })

  it('an acknowledgement given for offchain-price does not survive a 409 naming unpriced', () => {
    const review = reviewFor(offchainInfo())
    const { rerender } = render(<DcaReviewSheet review={review} view={VIEW} onCreate={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('dca-consent-checkbox'))
    expect(screen.getByRole('button', { name: 'Create DCA' })).toHaveProperty('disabled', false)
    rerender(<DcaReviewSheet review={review} view={VIEW} conflictTier="unpriced" onCreate={() => {}} onClose={() => {}} />)
    expect((screen.getByTestId('dca-consent-checkbox') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Create DCA' })).toHaveProperty('disabled', true)
    expect(screen.getByTestId('dca-consent-body').textContent).toContain('capped at $250') // the unpriced words, not the off-chain ones
  })

  it('a 409 naming a weaker tier than the one on screen changes nothing', () => {
    const review = reviewFor(unpricedInfo())
    const { rerender } = render(<DcaReviewSheet review={review} view={VIEW} onCreate={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('dca-consent-checkbox'))
    rerender(<DcaReviewSheet review={review} view={VIEW} conflictTier="offchain-price" onCreate={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('dca-consent').getAttribute('data-tier')).toBe('unpriced')
    expect(screen.getByRole('button', { name: 'Create DCA' })).toHaveProperty('disabled', false)
  })
})

describe('review sheet · keyboard', () => {
  it('Cancel is the default focus, Esc closes, Tab stays inside, a click on the dimmed page does not dismiss', () => {
    const onClose = vi.fn()
    render(<DcaReviewSheet review={reviewFor(unpricedInfo())} view={VIEW} onCreate={() => {}} onClose={onClose} />)
    expect(document.activeElement).toBe(screen.getByTestId('dca-review-cancel'))
    fireEvent.click(document.querySelector('[data-sheet-backdrop]') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    const last = within(dialog).getByTestId('dca-review-cancel')
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ── Positions ──────────────────────────────────────────────────────────────────

const NOW = Date.now()
function order(over: Partial<AutonomousOrder> & { id: string }): AutonomousOrder {
  return {
    orderHash: '0xabc', signature: '0xsig', orderType: OrderType.DCA, chainId: BASE,
    order: { owner: '0xd44d00000000000000000000000000000000962d', tokenIn: weth().address, tokenOut: usdc().address, amountIn: 1_000_000_000_000_000_000n, dcaInterval: 86_400n } as unknown as AutonomousOrder['order'],
    status: 'active', tokenInSymbol: 'WETH', tokenInDecimals: 18, tokenOutSymbol: 'USDC', tokenOutDecimals: 6,
    dcaExecuted: 4, dcaTotal: 10, floorTier: null, createdAt: NOW - 3_600_000, executedAt: null, expiresAt: NOW + 26 * 86_400_000, error: null, amountOut: null, txHash: null,
    ...over,
  }
}
const ACTIVE = order({ id: 'a1' })
const TIERED = order({ id: 'a2', floorTier: 'unpriced', tokenOutSymbol: 'ARB' })
const DONE = order({ id: 'h1', status: 'filled', dcaExecuted: 10 })
const CANCELLED = order({ id: 'h2', status: 'cancelled', dcaExecuted: 1, dcaTotal: 3 })
const FAILED = order({ id: 'h3', status: 'error', error: 'nonce reused' })

function renderList(active: AutonomousOrder[], history: AutonomousOrder[]) {
  return render(<DcaOrdersList active={active} history={history} connectedChainId={BASE} onCancel={h.engine.cancelOrder} onCancelAll={h.engine.cancelAllOrders} onRemove={h.engine.removeOrder} onCreate={() => {}} />)
}
function renderV1(active: AutonomousOrder[], history: AutonomousOrder[]) {
  return render(<DCADashboard active={active} history={history} connectedChainId={BASE} onCancel={h.engine.cancelOrder} onCancelAll={h.engine.cancelAllOrders} onRemove={h.engine.removeOrder} onCreate={() => {}} />)
}

describe('Positions · v2 rows show v1\'s fields for the same order objects', () => {
  const FIELDS = (o: AutonomousOrder, root: HTMLElement) => ({
    pair: root.textContent?.includes(`${o.tokenInSymbol} → ${o.tokenOutSymbol}`),
    progress: root.textContent?.includes(`${o.dcaExecuted} of ${o.dcaTotal} buys`),
  })

  it('each active and history order: pair, filled/total, status label, tier badge, chain — present in v1 AND v2', () => {
    const orders = [ACTIVE, TIERED, DONE, CANCELLED]
    const v1 = renderV1([ACTIVE, TIERED], [DONE, CANCELLED])
    const v1Rows = v1.container
    for (const o of orders) expect(FIELDS(o, v1Rows)).toEqual({ pair: true, progress: true })
    const v1Text = v1Rows.textContent as string
    cleanup()
    const v2 = renderList([ACTIVE, TIERED], [DONE, CANCELLED])
    const rows = Array.from(v2.container.querySelectorAll('[data-testid="dca-order-row"]'))
    expect(rows.map((r) => r.getAttribute('data-order-id'))).toEqual(['a1', 'a2', 'h1', 'h2'])
    for (const [i, o] of orders.entries()) expect(FIELDS(o, rows[i] as HTMLElement)).toEqual({ pair: true, progress: true })
    for (const word of ['Active', 'Completed', 'Cancelled', 'No price source', 'Base', 'History', 'Cancel All']) {
      expect(v1Text.toLowerCase()).toContain(word.toLowerCase()) // v1 prints it…
      expect(v2.container.textContent?.toLowerCase()).toContain(word.toLowerCase()) // …and so does v2
    }
  })

  it('an active row shows the next buy and the expiry; a history row does not', () => {
    const v2 = renderList([ACTIVE], [DONE])
    const [a, d] = Array.from(v2.container.querySelectorAll('[data-testid="dca-order-row"]'))
    expect(within(a as HTMLElement).getByTestId('order-next-buy').textContent).toMatch(/Next buy in\s+\d{2,}:\d{2}:\d{2}|Buying now/)
    expect(within(a as HTMLElement).getByTestId('order-expires').textContent).toMatch(/Expires in 2\dd/)
    expect(within(d as HTMLElement).queryByTestId('order-next-buy')).toBeNull()
  })

  it('a failed order shows v1\'s reason; the tx link is chain-aware', () => {
    const v2 = renderList([], [FAILED, order({ id: 'h4', status: 'filled', txHash: '0xdeadbeef' })])
    expect(within(v2.container).getByTestId('failed-banner').textContent).toBeTruthy()
    expect(v2.container.querySelector('a[href*="basescan"]')).not.toBeNull()
  })

  it('Cancel calls v1\'s cancelOrder with the order id (and plays v1\'s click); Remove / Cancel All / Remove All are v1\'s handlers', () => {
    renderList([ACTIVE, TIERED], [DONE, CANCELLED])
    fireEvent.click(screen.getAllByTestId('order-cancel')[0])
    expect(h.engine.cancelOrder).toHaveBeenCalledWith('a1')
    expect(h.sounds.playClick).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('orders-cancel-all'))
    expect(h.engine.cancelAllOrders).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByTestId('order-remove')[0])
    expect(h.engine.removeOrder).toHaveBeenCalledWith('h1')
    fireEvent.click(screen.getByTestId('orders-remove-all'))
    expect(h.engine.removeOrder).toHaveBeenCalledWith('h2')
  })

  it('an order on another chain than the wallet: the badge is amber and Cancel reads "Switch to {chain}" (v1)', () => {
    const v2 = render(<DcaOrdersList active={[order({ id: 'x', chainId: 42161 })]} history={[]} connectedChainId={BASE} onCancel={h.engine.cancelOrder} onCancelAll={h.engine.cancelAllOrders} onRemove={h.engine.removeOrder} onCreate={() => {}} />)
    expect(within(v2.container).getByTestId('order-cancel').textContent).toBe('Switch to Arbitrum One')
  })

  it('empty state: v1\'s words, verbatim, and its Start a DCA button returns to the form', () => {
    const v1 = renderV1([], [])
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const onCreate = vi.fn()
    const v2 = render(<DcaOrdersList active={[]} history={[]} onCancel={() => {}} onCancelAll={() => {}} onRemove={() => {}} onCreate={onCreate} />)
    const r = compareContent(v1Root, v2.container)
    expect(r.missingText).toEqual([])
    expect(v2.container.textContent).toContain(EMPTY_TITLE)
    expect(v2.container.textContent).toContain(EMPTY_BODY)
    fireEvent.click(screen.getByRole('button', { name: EMPTY_CTA }))
    expect(onCreate).toHaveBeenCalled()
  })

  it('the 1 s clock stops at the target (no timer leak): unmounting clears it', () => {
    vi.useFakeTimers()
    const v2 = renderList([ACTIVE], [])
    act(() => { vi.advanceTimersByTime(3000) })
    v2.unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
