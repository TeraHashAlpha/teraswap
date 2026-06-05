// @vitest-environment jsdom
/**
 * [SPRINT-9U U2] OrderReviewModal — renders the DECODED frozen autonomous-order exactly as it will be
 * signed (type, pair, amounts, trigger/limit price, expiry, min output, router, nonce).
 */
import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import OrderReviewModal from './OrderReviewModal'
import { OrderType, PriceCondition } from '@/lib/order-engine'
import type { PendingOrderReview } from '@/hooks/useOrderEngine'

const ROUTER = '0x111111125421ca6dc452d289314280a0f8842a65'
const ACCOUNT = '0x1111111111111111111111111111111111111111'

function makeReview(over: Partial<{ orderType: number; condition: number }> = {}): PendingOrderReview {
  const orderType = over.orderType ?? OrderType.LIMIT
  return {
    order: {
      owner: ACCOUNT as `0x${string}`,
      tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`,
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
      amountIn: 1_000000000000000000n,
      minAmountOut: 2_900000000n,
      orderType,
      condition: over.condition ?? PriceCondition.ABOVE,
      targetPrice: 300000000000n, // 3000 @ 8 dp
      priceFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as `0x${string}`,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
      nonce: 7n,
      router: ROUTER as `0x${string}`,
      routerDataHash: ('0x' + '11'.repeat(32)) as `0x${string}`,
      dcaInterval: orderType === OrderType.DCA ? 3600n : 0n,
      dcaTotal: orderType === OrderType.DCA ? 10n : 1n,
    },
    config: {
      tokenIn: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
      tokenOut: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
      orderType,
    } as PendingOrderReview['config'],
    computedHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    chainId: 1,
    account: ACCOUNT as `0x${string}`,
  }
}

describe('OrderReviewModal [SPRINT-9U U2]', () => {
  it('renders the frozen limit-order fields (type/pair/amounts/price/router/nonce) to be signed', () => {
    renderWithProviders(<OrderReviewModal order={makeReview()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('order-type').textContent).toMatch(/limit/i)
    expect(screen.getByTestId('order-pair').textContent).toMatch(/WETH/)
    expect(screen.getByTestId('order-pair').textContent).toMatch(/USDC/)
    expect(screen.getByTestId('order-amountin').textContent).toMatch(/1.*WETH/)
    expect(screen.getByTestId('order-minout').textContent).toMatch(/2[,.]?900.*USDC/)
    expect(screen.getByTestId('order-price').textContent).toMatch(/3[,.]?000/) // 300000000000 @ 8dp
    expect(screen.getByTestId('order-router').textContent).toMatch(/0x1111\.\.\.2a65/)
    expect(screen.getByTestId('order-nonce').textContent).toBe('7')
  })

  it('renders DCA schedule instead of a trigger price for DCA orders', () => {
    renderWithProviders(<OrderReviewModal order={makeReview({ orderType: OrderType.DCA })} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('order-type').textContent).toMatch(/dca/i)
    expect(screen.getByTestId('order-dca').textContent).toMatch(/3600s.*10 buys/)
    expect(screen.queryByTestId('order-price')).toBeNull()
  })

  it('confirm + cancel wire through', () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn()
    renderWithProviders(<OrderReviewModal order={makeReview()} onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /confirm & sign order/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
