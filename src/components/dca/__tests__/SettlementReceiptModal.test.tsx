// @vitest-environment jsdom
/**
 * [FEAT-DCA-SETTLEMENT-RECEIPT] SettlementReceiptModal — totals, per-fill rows, estimate
 * comparison, and the terminal-status gate, with `buildSettlementReceipt` mocked so this file
 * exercises only the UI rendering (the resolver's own math is covered by
 * settlement-receipt.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { AutonomousOrder } from '@/lib/order-engine'
import type { SettlementReceipt } from '@/lib/dca/settlement-receipt'

const useAccountMock = vi.fn()
vi.mock('wagmi', () => ({ useAccount: () => useAccountMock() }))

const buildSettlementReceiptMock = vi.fn<(...args: unknown[]) => Promise<SettlementReceipt>>()
vi.mock('@/lib/dca/settlement-receipt', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dca/settlement-receipt')>('@/lib/dca/settlement-receipt')
  return { ...actual, buildSettlementReceipt: (...args: unknown[]) => buildSettlementReceiptMock(...args) }
})

import SettlementReceiptModal, { isReceiptEligible } from '../SettlementReceiptModal'

const ADDRESS = '0x1111111111111111111111111111111111111111'

function makeOrder(overrides: Partial<AutonomousOrder> = {}): AutonomousOrder {
  return {
    id: 'order-1',
    orderHash: '0xorderhash',
    order: { maxSlippageBps: 300 } as AutonomousOrder['order'],
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

function makeReceipt(overrides: Partial<SettlementReceipt> = {}): SettlementReceipt {
  return {
    orderHash: '0xorderhash',
    status: 'completed',
    chainId: 8453,
    tokenInSymbol: 'USDC',
    tokenOutSymbol: 'WETH',
    tokenInDecimals: 6,
    tokenOutDecimals: 18,
    fills: [
      {
        executionNumber: 1,
        txHash: '0xfill1',
        txUrl: 'https://basescan.org/tx/0xfill1',
        timestamp: 1_700_000_000_000,
        amountInRaw: '1000000',
        amountOutRaw: '500000000000000000',
        effectivePrice: 2,
        protocolFeeRaw: '2000',
        networkCostWeiRaw: '100000000000000',
      },
    ],
    totals: {
      totalInvestedRaw: '1000000',
      totalReceivedRaw: '500000000000000000',
      avgPrice: 2,
      totalProtocolFeeRaw: '2000',
      totalNetworkCostWeiRaw: '100000000000000',
    },
    estimate: { maxSlippageBps: 300, realizedFeeBps: 20 },
    networkCostLabel: 'Network cost — covered by TeraSwap',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS })
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ executions: [{ execution_number: 1, tx_hash: '0xfill1', created_at: '2026-01-01T00:00:00Z' }] }),
  }) as unknown as typeof fetch
})

describe('isReceiptEligible', () => {
  it('is true only for terminal filled/cancelled statuses', () => {
    expect(isReceiptEligible('filled')).toBe(true)
    expect(isReceiptEligible('cancelled')).toBe(true)
    expect(isReceiptEligible('active')).toBe(false)
    expect(isReceiptEligible('expired')).toBe(false)
    expect(isReceiptEligible('error')).toBe(false)
  })
})

describe('SettlementReceiptModal', () => {
  it('renders totals, average price, protocol fee, and network cost with its label', async () => {
    buildSettlementReceiptMock.mockResolvedValue(makeReceipt())
    render(<SettlementReceiptModal order={makeOrder()} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('settlement-totals')).toBeInTheDocument())
    const totals = screen.getByTestId('settlement-totals')
    expect(totals.textContent).toContain('1 USDC')
    expect(totals.textContent).toMatch(/0[.,]5 WETH/)
    expect(totals.textContent).toContain('Network cost — covered by TeraSwap')
  })

  it('renders the per-fill table with a tx link', async () => {
    buildSettlementReceiptMock.mockResolvedValue(makeReceipt())
    render(<SettlementReceiptModal order={makeOrder()} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('settlement-fills-table')).toBeInTheDocument())
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /View tx/i })).toHaveAttribute('href', 'https://basescan.org/tx/0xfill1')
  })

  it('renders the estimate comparison (signed budget vs realized fee)', async () => {
    buildSettlementReceiptMock.mockResolvedValue(makeReceipt())
    render(<SettlementReceiptModal order={makeOrder()} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('settlement-estimate-comparison')).toBeInTheDocument())
    const box = screen.getByTestId('settlement-estimate-comparison')
    expect(box.textContent).toContain('3%') // 300 bps signed budget
    expect(box.textContent).toMatch(/0[.,]2%/) // 20 bps realized fee
  })

  it('a zero-fill cancelled receipt shows the empty-fills message, not a crash', async () => {
    buildSettlementReceiptMock.mockResolvedValue(
      makeReceipt({
        status: 'cancelled',
        fills: [],
        totals: {
          totalInvestedRaw: '0',
          totalReceivedRaw: '0',
          avgPrice: null,
          totalProtocolFeeRaw: '0',
          totalNetworkCostWeiRaw: '0',
        },
        estimate: { maxSlippageBps: null, realizedFeeBps: null },
      }),
    )
    render(<SettlementReceiptModal order={makeOrder({ status: 'cancelled' })} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('settlement-fills-table')).toBeInTheDocument())
    expect(screen.getByText(/No fills executed/i)).toBeInTheDocument()
  })

  it('shows an error state when the position is not yet settled', async () => {
    render(<SettlementReceiptModal order={makeOrder({ status: 'active' })} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('settlement-receipt-error')).toBeInTheDocument())
    expect(buildSettlementReceiptMock).not.toHaveBeenCalled()
  })

  it('never renders "free" or "gasless" anywhere (transparency brand copy tone)', async () => {
    buildSettlementReceiptMock.mockResolvedValue(makeReceipt())
    const { container } = render(<SettlementReceiptModal order={makeOrder()} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('settlement-totals')).toBeInTheDocument())
    const text = container.textContent?.toLowerCase() ?? ''
    expect(text).not.toContain('free')
    expect(text).not.toContain('gasless')
  })
})
