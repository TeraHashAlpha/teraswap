// @vitest-environment jsdom
/**
 * [ADR-025 / B6b C2] Cancel from Positions → v1's path. v1's DCAPanel and the v2 card run on the SAME fake engine (`dca-engine-fake`):
 * Cancel freezes a plan (`cancelOrder(id)`), the cancel review confirms it (`confirmCancel()`), Keep drops it (`clearPendingCancel()`);
 * Cancel All freezes an invalidate plan (`cancelAllOrders()`). Arguments, order and count must be equal; no cancel ever runs without the
 * sheet's confirm; the list shows the engine's status (no optimistic flip, no request of v2's own); the sheet's words are v1's modal's.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent } from '../__tests__/content-parity'
import { BASE, h, resetHarness } from './dca-harness'
import { fake, resetFake } from './dca-engine-fake'

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
  return { useChainlinkPrice: () => h.oracle }
})
vi.mock('@/hooks/useDepegCheck', async () => {
  const { h } = await import('./dca-harness')
  return { useDepegCheck: () => h.depeg }
})
vi.mock('@/hooks/useOrderExecutions', () => ({ useOrderExecutions: () => ({ executions: [], lastFillAtMs: null, orderMeta: null, loading: false }) }))
vi.mock('@/components/dca/SettlementReceiptModal', () => ({ default: () => null, isReceiptEligible: () => false }))
vi.mock('@/components/dca/DCAPositionStats', () => ({ default: () => null }))
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
import OrderCancelReviewModal from '@/components/OrderCancelReviewModal'
import type { PendingCancelReview } from '@/hooks/useOrderEngine'
import { OrderType, type AutonomousOrder, type OnChainOrder } from '@/lib/order-engine'
import { findChainToken, getCanonicalUsdc } from '@/lib/chains/tokens'
import { getWrappedNative } from '@/lib/chains/registry'
import { DcaCard } from './DcaCard'
import { DcaCancelSheet } from './DcaCancelSheet'

const weth = () => findChainToken(getWrappedNative(BASE), BASE)!
const usdc = () => getCanonicalUsdc(BASE)!
const NOW = Date.now()
function order(over: Partial<AutonomousOrder> & { id: string }): AutonomousOrder {
  return {
    orderHash: `0x${over.id.padEnd(64, '0')}`, signature: '0xsig', orderType: OrderType.DCA, chainId: BASE,
    order: {
      owner: '0xd44d00000000000000000000000000000000962d', tokenIn: weth().address, tokenOut: usdc().address, amountIn: 1_000_000_000_000_000_000n, minAmountOut: 1_200_000_000n,
      maxSlippageBps: 300, orderType: 2, condition: 0, targetPrice: 0n, priceFeed: '0x0000000000000000000000000000000000000000', expiry: BigInt(Math.floor(NOW / 1000) + 26 * 86_400),
      nonce: 3n, router: '0x1111111111111111111111111111111111111111', dcaInterval: 86_400n, dcaTotal: 10n,
    } as unknown as AutonomousOrder['order'],
    status: 'active', tokenInSymbol: 'WETH', tokenInDecimals: 18, tokenOutSymbol: 'USDC', tokenOutDecimals: 6,
    dcaExecuted: 4, dcaTotal: 10, floorTier: null, createdAt: NOW - 3_600_000, executedAt: null, expiresAt: NOW + 26 * 86_400_000, error: null, amountOut: null, txHash: null,
    ...over,
  }
}

beforeEach(() => {
  resetHarness()
  resetFake()
  fake.orders = [order({ id: 'a1' }), order({ id: 'a2', tokenOutSymbol: 'ARB' }), order({ id: 'h1', status: 'filled', dcaExecuted: 10 })]
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const names = () => fake.seq.map((c) => c[0])

async function v1Positions() {
  render(<DCAPanel chainId={BASE} />)
  fireEvent.click(screen.getByRole('button', { name: /^Positions/ }))
  await screen.findAllByRole('button', { name: 'Cancel' })
}
async function v2Positions() {
  const view = render(<DcaCard chainId={BASE} />)
  fireEvent.click(screen.getByRole('tab', { name: /Positions/ }))
  await screen.findAllByTestId('order-cancel')
  return view
}

describe('cancel one: v1 and v2 hand the engine the same calls', () => {
  it('Cancel → cancelOrder(id) · confirm → confirmCancel() · the event plays v1\'s sound and toast — equal sequences', async () => {
    await v1Positions()
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0])
    expect(fake.seq).toEqual([['cancelOrder', 'a1']])
    fireEvent.click(await screen.findByTestId('cancel-confirm'))
    await waitFor(() => expect(h.soundLog).toContain('playCancelOrderMP3'))
    const v1Seq = [...fake.seq]
    const v1Sounds = [...h.soundLog]
    const v1Toasts = h.toast.mock.calls.map((c) => c[0])
    cleanup()
    resetFake()
    fake.orders = [order({ id: 'a1' }), order({ id: 'a2', tokenOutSymbol: 'ARB' }), order({ id: 'h1', status: 'filled', dcaExecuted: 10 })]
    h.soundLog.length = 0
    h.toast.mockClear()

    await v2Positions()
    fireEvent.click(screen.getAllByTestId('order-cancel')[0])
    expect(fake.seq).toEqual([['cancelOrder', 'a1']])
    const sheet = await screen.findByRole('dialog')
    expect(sheet.getAttribute('data-sheet')).toBe('dca-cancel')
    expect(within(sheet).getByTestId('dca-cancel-pair').textContent).toContain('WETH → USDC')
    expect(within(sheet).getByTestId('dca-cancel-nonce').textContent).toContain('3')
    expect(document.activeElement).toBe(within(sheet).getByTestId('dca-cancel-keep')) // the safe default
    fireEvent.click(within(sheet).getByTestId('dca-cancel-confirm'))
    await waitFor(() => expect(h.soundLog).toContain('playCancelOrderMP3'))

    expect(fake.seq).toEqual(v1Seq)
    expect(names()).toEqual(['cancelOrder', 'confirmCancel'])
    expect(h.soundLog).toEqual(v1Sounds)
    expect(h.toast.mock.calls.map((c) => c[0])).toEqual(v1Toasts)
    expect(v1Toasts).toEqual([{ type: 'success', title: 'DCA order cancelled', description: 'Your DCA order has been cancelled on-chain.' }])
  })

  it('Keep this order → clearPendingCancel(), no confirmCancel; Esc does the same (v1: backdrop / Cancel → clearPendingCancel)', async () => {
    await v2Positions()
    fireEvent.click(screen.getAllByTestId('order-cancel')[0])
    fireEvent.click(await screen.findByTestId('dca-cancel-keep'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(names()).toEqual(['cancelOrder', 'clearPendingCancel'])
    fireEvent.click(screen.getAllByTestId('order-cancel')[1])
    await screen.findByRole('dialog')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(names()).toEqual(['cancelOrder', 'clearPendingCancel', 'cancelOrder', 'clearPendingCancel'])
    expect(names()).not.toContain('confirmCancel')
  })

  it('the list is the engine\'s: no status flips before the event, the cancelled order moves to History after it, and v2 fetches nothing itself', async () => {
    const { container } = await v2Positions()
    expect(container.querySelectorAll('[data-testid="dca-order-row"][data-status="active"]').length).toBe(2)
    fireEvent.click(screen.getAllByTestId('order-cancel')[0])
    await screen.findByRole('dialog')
    expect(container.querySelectorAll('[data-testid="dca-order-row"][data-status="active"]').length).toBe(2) // frozen plan: nothing changed
    fireEvent.click(screen.getByTestId('dca-cancel-confirm'))
    await waitFor(() => expect(container.querySelectorAll('[data-testid="dca-order-row"][data-status="cancelled"]').length).toBe(1))
    expect(container.querySelectorAll('[data-testid="dca-order-row"][data-status="active"]').length).toBe(1)
    expect(container.querySelector('[data-order-id="a1"]')?.getAttribute('data-status')).toBe('cancelled')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a failed cancel: the engine\'s error is v1\'s toast, the row stays active', async () => {
    fake.cancelOutcome = async (orderId) => ({ type: 'order_error', orderId, error: 'User rejected the request.' })
    const { container } = await v2Positions()
    fireEvent.click(screen.getAllByTestId('order-cancel')[0])
    fireEvent.click(await screen.findByTestId('dca-cancel-confirm'))
    await waitFor(() => expect(h.toast).toHaveBeenCalled())
    expect(h.toast.mock.calls.map((c) => c[0])).toEqual([{ type: 'error', title: 'DCA order failed', description: 'User rejected the request.' }])
    expect(container.querySelector('[data-order-id="a1"]')?.getAttribute('data-status')).toBe('active')
    expect(h.soundLog.slice(-2)).toEqual(['stopWaitingSound', 'playCancelOrderMP3'])
  })
})

describe('Cancel All: v1 and v2 freeze the same invalidate plan', () => {
  it('Cancel All → cancelAllOrders() → the plan sheet (v1\'s arithmetic: one cancelOrder() per DCA) → confirmCancel()', async () => {
    await v1Positions()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel All' }))
    const modal = await screen.findByRole('dialog')
    const v1Text = (modal.textContent ?? '').replace(/\s+/g, ' ')
    fireEvent.click(screen.getByTestId('cancel-confirm'))
    await waitFor(() => expect(names()).toEqual(['cancelAllOrders', 'confirmCancel']))
    const v1Seq = [...fake.seq]
    cleanup()
    resetFake()
    fake.orders = [order({ id: 'a1' }), order({ id: 'a2', tokenOutSymbol: 'ARB' }), order({ id: 'h1', status: 'filled', dcaExecuted: 10 })]

    await v2Positions()
    fireEvent.click(screen.getByTestId('orders-cancel-all'))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByRole('heading', { level: 2 }).textContent).toBe('Cancel all orders')
    expect(within(sheet).getByTestId('dca-invalidate-count').textContent).toContain('2')
    expect(within(sheet).getByTestId('dca-invalidate-tx-summary').textContent).toContain('2 total (2 cancelOrder calls — DCA orders)')
    expect(within(sheet).getAllByTestId('dca-invalidate-row').length).toBe(2)
    for (const s of ['2 on-chain transactions', '2 individual cancelOrder calls for the DCA orders below', 'Your wallet will prompt 2 times', 'Orders affected', 'expect 2 wallet prompts. No funds move.']) {
      expect(v1Text, `v1 lacks "${s}"`).toContain(s)
      expect((sheet.textContent ?? '').replace(/\s+/g, ' '), `v2 lacks "${s}"`).toContain(s)
    }
    fireEvent.click(within(sheet).getByTestId('dca-cancel-confirm'))
    await waitFor(() => expect(names()).toEqual(['cancelAllOrders', 'confirmCancel']))
    expect(fake.seq).toEqual(v1Seq)
  })
})

describe('the cancel sheet is v1\'s OrderCancelReviewModal, word for word', () => {
  const o1 = order({ id: 'a1' })
  const o2 = order({ id: 'a2', tokenOutSymbol: 'ARB' })
  const other = order({ id: 'x', chainId: 42161 })
  const account = '0xd44d00000000000000000000000000000000962d' as const
  const STRUCT: OnChainOrder = {
    owner: account, tokenIn: weth().address as `0x${string}`, tokenOut: usdc().address as `0x${string}`, amountIn: 1_000_000_000_000_000_000n, minAmountOut: 1_200_000_000n, maxSlippageBps: 300,
    orderType: 2, condition: 0, targetPrice: 0n, priceFeed: '0x0000000000000000000000000000000000000000', expiry: BigInt(Math.floor(NOW / 1000) + 26 * 86_400), nonce: 3n,
    router: '0x1111111111111111111111111111111111111111', routerDataHash: `0x${'0'.repeat(64)}`, dcaInterval: 86_400n, dcaTotal: 10n,
  }
  const CANCEL: PendingCancelReview = { action: 'cancel', orderId: 'a1', order: o1, orderStruct: STRUCT, isV3: true, chainId: BASE, account }
  const INVALIDATE: PendingCancelReview = {
    action: 'invalidate', newNonce: 4n, v2AffectedOrders: [o1], v3Batches: [], v3DcaOrders: [{ order: o2, orderStruct: STRUCT }],
    affectedOrders: [o1, o2], skippedOrders: [other], chainId: BASE, account,
  }

  it.each([
    ['cancel', CANCEL],
    ['invalidate (nonce + one DCA cancel, one skipped chain)', INVALIDATE],
  ] as const)('%s: every visible v1 text node is in v2; Confirm / Keep call the same handlers', (_n, review) => {
    const v1 = render(<OrderCancelReviewModal review={review} onConfirm={() => {}} onCancel={() => {}} />)
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const v2 = render(<DcaCancelSheet review={review} onConfirm={onConfirm} onCancel={onCancel} />)
    const r = compareContent(v1Root, v2.container)
    expect(r.missingText).toEqual([])
    fireEvent.click(screen.getByTestId('dca-cancel-confirm'))
    fireEvent.click(screen.getByTestId('dca-cancel-keep'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
    if (review.action === 'invalidate') {
      expect(v2.container.textContent).toContain('1 order on other chains (Arbitrum One) were NOT included')
      expect(v2.container.textContent).toContain('New invalidation nonce')
      expect(v2.container.textContent).toContain('2 total (1 nonce invalidation) (1 cancelOrder call — DCA orders)')
    }
  })
})
