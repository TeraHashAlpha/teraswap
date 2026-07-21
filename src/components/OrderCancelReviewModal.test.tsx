// @vitest-environment jsdom
/**
 * [CANCEL-REVIEW] OrderCancelReviewModal — renders the DECODED frozen cancel/invalidate plan exactly
 * as it will be executed/signed (action, affected order(s): pair, amount, type, nonce, expiry; the
 * frozen invalidation nonce for cancel-all). Mirrors OrderReviewModal (9U): renders EXCLUSIVELY from
 * the frozen PendingCancelReview, so modal == executed payload.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import OrderCancelReviewModal from './OrderCancelReviewModal'
import { OrderType, PriceCondition } from '@/lib/order-engine'
import type { AutonomousOrder, OnChainOrder } from '@/lib/order-engine'
import type { PendingCancelReview } from '@/hooks/useOrderEngine'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as `0x${string}`
const EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 86400)

function makeStruct(over: Partial<OnChainOrder> = {}): OnChainOrder {
  return {
    owner: ACCOUNT,
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`, // WETH (public mainnet address) — gitleaks:allow
    tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`, // USDC (public mainnet address) — gitleaks:allow
    amountIn: 1_000000000000000000n,
    minAmountOut: 2_900000000n,
    orderType: OrderType.LIMIT,
    condition: PriceCondition.ABOVE,
    targetPrice: 300000000000n,
    priceFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as `0x${string}`,
    expiry: EXPIRY,
    nonce: 7n,
    router: '0x111111125421ca6dc452d289314280a0f8842a65' as `0x${string}`,
    routerDataHash: ('0x' + '11'.repeat(32)) as `0x${string}`,
    dcaInterval: 0n,
    dcaTotal: 1n,
    ...over,
  }
}

function makeOrder(over: Partial<AutonomousOrder> = {}): AutonomousOrder {
  return {
    id: 'order-1',
    orderHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    order: makeStruct(),
    signature: '0xsig',
    status: 'active',
    orderType: OrderType.LIMIT,
    tokenInSymbol: 'WETH',
    tokenInDecimals: 18,
    tokenOutSymbol: 'USDC',
    tokenOutDecimals: 6,
    dcaExecuted: 0,
    dcaTotal: 0,
    createdAt: Date.now(),
    executedAt: null,
    expiresAt: Number(EXPIRY) * 1000,
    error: null,
    amountOut: null,
    txHash: null,
    ...over,
  }
}

function makeCancelReview(): Extract<PendingCancelReview, { action: 'cancel' }> {
  return {
    action: 'cancel',
    orderId: 'order-1',
    order: makeOrder(),
    orderStruct: makeStruct(),
    isV3: false, // [SPRINT-V3-P3] this fixture is a v2 order (existing suite, byte-identical)
    chainId: 8453, // Base — the review must carry the ACTIVE chain, never assume mainnet
    account: ACCOUNT,
  }
}

function makeInvalidateReview(): Extract<PendingCancelReview, { action: 'invalidate' }> {
  const v2AffectedOrders = [
    makeOrder({ id: 'o1', tokenInSymbol: 'WETH', tokenOutSymbol: 'USDC' }),
    makeOrder({ id: 'o2', tokenInSymbol: 'DAI', tokenOutSymbol: 'WETH', orderType: OrderType.DCA }),
  ]
  return {
    action: 'invalidate',
    newNonce: 6n,
    v2AffectedOrders,
    // [SPRINT-V3-P3] this fixture is a v2-only cancel-all (existing suite, byte-identical).
    v3Batches: [],
    v3DcaOrders: [],
    affectedOrders: v2AffectedOrders,
    chainId: 8453,
    account: ACCOUNT,
  }
}

describe('OrderCancelReviewModal [CANCEL-REVIEW] — single-order cancel', () => {
  it('renders the frozen cancel fields (action/type/pair/amount/nonce/expiry) field-by-field', () => {
    renderWithProviders(<OrderCancelReviewModal review={makeCancelReview()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('cancel-action').textContent).toMatch(/cancel order/i)
    expect(screen.getByTestId('cancel-type').textContent).toMatch(/limit/i)
    expect(screen.getByTestId('cancel-pair').textContent).toMatch(/WETH/)
    expect(screen.getByTestId('cancel-pair').textContent).toMatch(/USDC/)
    expect(screen.getByTestId('cancel-amount').textContent).toMatch(/1.*WETH/)
    // nonce + expiry come from the FROZEN struct (the exact cancelOrder() tx arg)
    expect(screen.getByTestId('cancel-nonce').textContent).toBe('7')
    expect(screen.getByTestId('cancel-expiry').textContent).not.toBe('')
    // the orderHash binds the off-chain (Supabase) removal signature to this order
    expect(screen.getByTestId('cancel-orderhash').textContent).toMatch(/0xaaaa\.\.\.aaaa/)
  })

  it('Confirm calls onConfirm; Keep order calls onCancel (no execution from render)', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderWithProviders(<OrderCancelReviewModal review={makeCancelReview()} onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('cancel-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('cancel-keep'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

function makeMixedInvalidateReview(): Extract<PendingCancelReview, { action: 'invalidate' }> {
  // [BUG-MASS-CANCEL-DCA-ONCHAIN] A batch containing v3 DCA orders — these are NEVER covered by
  // invalidateUnorderedNonces (the contract's DCA branch skips the bitmap check entirely), so
  // confirmCancel sends one individual cancelOrder() per DCA order PLUS the nonce tx(es) for
  // everything else. The modal must say so instead of claiming a single blanket nonce invalidation.
  const v2AffectedOrders = [makeOrder({ id: 'o1', tokenInSymbol: 'WETH', tokenOutSymbol: 'USDC' })]
  const dcaOrder1 = makeOrder({ id: 'dca1', orderType: OrderType.DCA, tokenInSymbol: 'DAI', tokenOutSymbol: 'WETH' })
  const dcaOrder2 = makeOrder({ id: 'dca2', orderType: OrderType.DCA, tokenInSymbol: 'USDC', tokenOutSymbol: 'WETH' })
  return {
    action: 'invalidate',
    newNonce: 6n,
    v2AffectedOrders,
    v3Batches: [],
    v3DcaOrders: [
      { order: dcaOrder1, orderStruct: makeStruct({ nonce: 4n }) },
      { order: dcaOrder2, orderStruct: makeStruct({ nonce: 5n }) },
    ],
    affectedOrders: [v2AffectedOrders[0], dcaOrder1, dcaOrder2],
    chainId: 8453,
    account: ACCOUNT,
  }
}

describe('OrderCancelReviewModal [BUG-MASS-CANCEL-DCA-ONCHAIN] — mixed batch (v2/non-DCA nonce + v3 DCA individual cancels)', () => {
  it('states the real transaction breakdown instead of "one transaction" when DCA orders are present', () => {
    renderWithProviders(<OrderCancelReviewModal review={makeMixedInvalidateReview()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    // 1 nonce invalidation tx (v2) + 2 individual cancelOrder txs (the DCA orders) = 3 total.
    const summary = screen.getByTestId('invalidate-tx-summary').textContent || ''
    expect(summary).toMatch(/3/)
    expect(summary).toMatch(/2.*cancelOrder|cancelOrder.*2/i)
    expect(summary).not.toMatch(/^\s*$/)
  })

  it('never claims the nonce invalidation cancels the DCA orders too', () => {
    renderWithProviders(<OrderCancelReviewModal review={makeMixedInvalidateReview()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const body = screen.getByTestId('cancel-review-body').textContent || ''
    // The old blanket claim ("cancels every order above at once" via the nonce alone) is false
    // for this shape — DCA orders are cancelled by their own cancelOrder() call, not the nonce.
    expect(body).not.toMatch(/cancels every order above at once/i)
  })
})

describe('OrderCancelReviewModal [CANCEL-REVIEW] — invalidate-all', () => {
  it('renders the frozen invalidation nonce and every affected order', () => {
    renderWithProviders(<OrderCancelReviewModal review={makeInvalidateReview()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('cancel-action').textContent).toMatch(/cancel all/i)
    // the FROZEN invalidateNonces() arg, displayed verbatim
    expect(screen.getByTestId('invalidate-nonce').textContent).toBe('6')
    expect(screen.getByTestId('invalidate-count').textContent).toMatch(/2/)
    const rows = screen.getAllByTestId('invalidate-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toMatch(/WETH/)
    expect(rows[0].textContent).toMatch(/USDC/)
    expect(rows[1].textContent).toMatch(/DAI/)
  })

  it('Confirm calls onConfirm exactly once', () => {
    const onConfirm = vi.fn()
    renderWithProviders(<OrderCancelReviewModal review={makeInvalidateReview()} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('cancel-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
