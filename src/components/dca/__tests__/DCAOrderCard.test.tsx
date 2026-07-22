// @vitest-environment jsdom
/**
 * [FEAT-DCA-SETTLEMENT-RECEIPT] DCAOrderCard — "View receipt" is offered ONLY for a position that
 * has reached a settlement-eligible terminal status (completed/cancelled), never for
 * active/expired/error history rows.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AutonomousOrder } from '@/lib/order-engine'
import DCAOrderCard from '../DCAOrderCard'

function makeOrder(overrides: Partial<AutonomousOrder> = {}): AutonomousOrder {
  return {
    id: 'order-1',
    orderHash: '0xorderhash',
    order: {} as AutonomousOrder['order'],
    signature: '0xsig',
    status: 'filled',
    orderType: 2,
    chainId: 8453,
    tokenInSymbol: 'USDC',
    tokenInDecimals: 6,
    tokenOutSymbol: 'WETH',
    tokenOutDecimals: 18,
    dcaExecuted: 2,
    dcaTotal: 2,
    createdAt: Date.now(),
    executedAt: Date.now(),
    expiresAt: Date.now() + 1000,
    error: null,
    amountOut: '1000',
    txHash: '0xtx',
    ...overrides,
  }
}

describe('DCAOrderCard — View receipt gating', () => {
  it('shows "View receipt" for a completed (filled) position', () => {
    render(<DCAOrderCard order={makeOrder({ status: 'filled' })} />)
    expect(screen.getByText('View receipt')).toBeInTheDocument()
  })

  it('shows "View receipt" for a cancelled position', () => {
    render(<DCAOrderCard order={makeOrder({ status: 'cancelled' })} />)
    expect(screen.getByText('View receipt')).toBeInTheDocument()
  })

  it('does NOT show "View receipt" for an expired position', () => {
    render(<DCAOrderCard order={makeOrder({ status: 'expired' })} />)
    expect(screen.queryByText('View receipt')).toBeNull()
  })

  it('does NOT show "View receipt" for a failed (error) position', () => {
    render(<DCAOrderCard order={makeOrder({ status: 'error' })} />)
    expect(screen.queryByText('View receipt')).toBeNull()
  })

  it('does not mount the receipt modal until "View receipt" is clicked (no eager fetch)', () => {
    render(<DCAOrderCard order={makeOrder({ status: 'filled' })} />)
    expect(screen.queryByRole('dialog', { name: /settlement receipt/i })).toBeNull()
  })
})
