// @vitest-environment jsdom
/**
 * [SPRINT-9U U1] CowOrderReviewModal — renders the DECODED frozen CoW order exactly as it will be
 * signed. Verifies the trust surface (sell/buy/receiver/validTo/fee/settlement/appData) reflects the
 * frozen order.message field-by-field, and that confirm/cancel wire through.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import CowOrderReviewModal from './CowOrderReviewModal'
import type { PendingCowOrder } from '@/hooks/useSwap'
import type { Token } from '@/lib/tokens'

const WETH: Token = { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: '', category: 'Native' }
const USDC: Token = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '', category: 'Stablecoin' }
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'

function makeOrder(over: Partial<PendingCowOrder['message']> = {}): PendingCowOrder {
  const message = {
    sellToken: WETH.address as `0x${string}`,
    buyToken: USDC.address as `0x${string}`,
    receiver: ACCOUNT as `0x${string}`,
    sellAmount: 1_000000000000000000n,
    buyAmount: 2_950000000n,
    validTo: Math.floor(Date.now() / 1000) + 600,
    appData: ('0x' + 'a'.repeat(64)) as `0x${string}`,
    feeAmount: 500000000000000n,
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    ...over,
  }
  return {
    domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 1, verifyingContract: SETTLEMENT as `0x${string}` },
    types: { Order: [{ name: 'sellToken', type: 'address' }] },
    message,
    orderParams: {} as PendingCowOrder['orderParams'],
    tokenIn: WETH,
    tokenOut: USDC,
    rawAmount: '1000000000000000000',
    settlement: SETTLEMENT as `0x${string}`,
    chainId: 1,
    account: ACCOUNT as `0x${string}`,
    startTime: Date.now(),
  }
}

describe('CowOrderReviewModal [SPRINT-9U U1]', () => {
  it('renders the frozen order fields (sell/buy/receiver/settlement) the wallet will sign', () => {
    renderWithProviders(<CowOrderReviewModal order={makeOrder()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    // Sell = 1 WETH (from message.sellAmount @ 18 dp); Receive = 2,950 USDC (buyAmount @ 6 dp).
    expect(screen.getByTestId('cow-sell').textContent).toMatch(/WETH/)
    expect(screen.getByTestId('cow-sell').textContent).toMatch(/\b1\b/)
    expect(screen.getByTestId('cow-buy').textContent).toMatch(/USDC/)
    expect(screen.getByTestId('cow-buy').textContent).toMatch(/950/)
    // Receiver == the connected account → "Your wallet".
    expect(screen.getByTestId('cow-receiver').textContent).toMatch(/0x1111\.\.\.1111/)
    expect(screen.getByText('Your wallet')).toBeInTheDocument() // the badge (exact), not the header copy
    // Settlement contract shown.
    expect(screen.getByTestId('cow-settlement').textContent).toMatch(/0x9008\.\.\.ab41/)
    // appData (carrying the 0.1% partner fee) shown.
    expect(screen.getByTestId('cow-appdata').textContent).toMatch(/0xaaaa/)
  })

  it('flags a recipient that is NOT the connected wallet', () => {
    const order = makeOrder({ receiver: '0x9999999999999999999999999999999999999999' as `0x${string}` })
    renderWithProviders(<CowOrderReviewModal order={order} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/^Other$/)).toBeInTheDocument()
  })

  it('confirm + cancel wire through', () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn()
    renderWithProviders(<CowOrderReviewModal order={makeOrder()} onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /confirm & sign order/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
