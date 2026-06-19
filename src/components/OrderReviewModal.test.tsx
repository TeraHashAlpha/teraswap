// @vitest-environment jsdom
/**
 * [SPRINT-9U U2] OrderReviewModal — renders the DECODED frozen autonomous-order exactly as it will be
 * signed (type, pair, amounts, trigger/limit price, expiry, min output, router, nonce).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// [CHORE-DCA-APPROVAL-FLOW] The modal now consumes useOrderApproval (a wagmi-backed hook) to gate
// the sign button behind a one-time executor approval. Mock it so tests drive isApproved/needsApproval
// directly without standing up a wagmi provider. Default: already approved → single-step sign flow
// (keeps the existing confirm/cancel assertions green).
const mockUseOrderApproval = vi.fn()
vi.mock('@/hooks/useOrderApproval', () => ({
  useOrderApproval: (...args: unknown[]) => mockUseOrderApproval(...args),
}))

import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import OrderReviewModal from './OrderReviewModal'
import { OrderType, PriceCondition } from '@/lib/order-engine'
import { getOrderExecutor } from '@/lib/order-engine'
import type { PendingOrderReview } from '@/hooks/useOrderEngine'

function approvalState(over: Partial<{ needsApproval: boolean; isApproved: boolean; status: string; error: string | null; approve: () => void; spender: string | null; allowance: bigint | undefined }> = {}) {
  return {
    spender: getOrderExecutor(1),
    allowance: 10n ** 30n,
    isApproved: true,
    needsApproval: false,
    status: 'idle',
    error: null,
    approve: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: approved → "Confirm & Sign Order" shown.
  mockUseOrderApproval.mockReturnValue(approvalState())
})

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
    // [9U audit] the signed priceFeed (oracle) + routerDataHash are part of the trust surface.
    expect(screen.getByTestId('order-pricefeed').textContent).toMatch(/0x5f4e\.\.\.8419/)
    expect(screen.getByTestId('order-routerhash').textContent).toMatch(/0x1111\.\.\.1111/)
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

  // [CHORE-DCA-APPROVAL-FLOW] Per-buy/total label fix — what's displayed == what's signed.
  it('DCA labels o.amountIn as the TOTAL and shows a derived Per buy = amountIn/dcaTotal', () => {
    // amountIn 1e18 (= "1 WETH") over 10 buys → per buy = 0.1 WETH.
    renderWithProviders(<OrderReviewModal order={makeReview({ orderType: OrderType.DCA })} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    // The amount row is now labelled "Total to spend" (not "Amount per buy") and shows the full total.
    expect(screen.getByText(/total to spend/i)).toBeTruthy()
    expect(screen.getByTestId('order-amountin').textContent).toMatch(/1\s*WETH/)
    // Per-buy row = amountIn / dcaTotal = 0.1 WETH (locale may render the decimal as , or .).
    expect(screen.getByTestId('order-perbuy').textContent).toMatch(/0[.,]1\s*WETH/)
  })

  it('non-DCA keeps the single "Sell" amount and shows no Per buy row', () => {
    renderWithProviders(<OrderReviewModal order={makeReview()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/^Sell$/)).toBeTruthy()
    expect(screen.queryByTestId('order-perbuy')).toBeNull()
  })

  // [CHORE-DCA-APPROVAL-FLOW] Approve-then-sign gate.
  it('shows "Approve {symbol}" and DISABLES the sign button when approval is needed', () => {
    const approve = vi.fn()
    mockUseOrderApproval.mockReturnValue(approvalState({ needsApproval: true, isApproved: false, approve }))
    const onConfirm = vi.fn()
    renderWithProviders(<OrderReviewModal order={makeReview()} onConfirm={onConfirm} onCancel={vi.fn()} />)
    // The sign button is not rendered while approval is pending; an Approve button is.
    expect(screen.queryByTestId('order-confirm')).toBeNull()
    const approveBtn = screen.getByTestId('order-approve')
    expect(approveBtn.textContent).toMatch(/approve\s*WETH/i)
    fireEvent.click(approveBtn)
    expect(approve).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled() // approving must NOT sign
  })

  it('passes the FROZEN tokenIn, total amountIn and chainId to useOrderApproval', () => {
    const review = makeReview({ orderType: OrderType.DCA })
    renderWithProviders(<OrderReviewModal order={review} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(mockUseOrderApproval).toHaveBeenCalledWith(review.order.tokenIn, review.order.amountIn, review.chainId)
  })

  it('once approved, the Approve step disappears and "Confirm & Sign Order" calls onConfirm', () => {
    mockUseOrderApproval.mockReturnValue(approvalState({ needsApproval: false, isApproved: true }))
    const onConfirm = vi.fn()
    renderWithProviders(<OrderReviewModal order={makeReview()} onConfirm={onConfirm} onCancel={vi.fn()} />)
    expect(screen.queryByTestId('order-approve')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /confirm & sign order/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('shows a pending label while the approve tx confirms', () => {
    mockUseOrderApproval.mockReturnValue(approvalState({ needsApproval: true, isApproved: false, status: 'confirming' }))
    renderWithProviders(<OrderReviewModal order={makeReview()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const approveBtn = screen.getByTestId('order-approve') as HTMLButtonElement
    expect(approveBtn.textContent).toMatch(/approving/i)
    expect(approveBtn.disabled).toBe(true)
  })
})
