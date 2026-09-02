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
// [ADR-020] Real (unmocked) chain lookup — the route label is resolved against it.
import { getWhitelistedRouters } from '@/lib/order-engine'

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
        nextBestOutRaw: null,
        nextBestSource: null,
        aggregationValueRaw: null,
      },
    ],
    totals: {
      totalInvestedRaw: '1000000',
      totalReceivedRaw: '500000000000000000',
      avgPrice: 2,
      totalProtocolFeeRaw: '2000',
      totalNetworkCostWeiRaw: '100000000000000',
      totalAggregationValueRaw: null,
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
          totalAggregationValueRaw: null,
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

  it('ACCURACY INVARIANT: forwards only txHash/executionNumber/createdAt to the resolver — never the Supabase amount_in/amount_out/fee_amount columns, even when the API response includes them', async () => {
    // The REAL /api/orders/:id/executions endpoint returns amount_in/amount_out/fee_amount
    // alongside tx_hash — this fixture deliberately sets a WRONG fee_amount to prove the modal
    // never reads it: only txHash/executionNumber/createdAt may reach buildSettlementReceipt.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        executions: [
          {
            execution_number: 1,
            tx_hash: '0xfill1',
            created_at: '2026-01-01T00:00:00Z',
            amount_in: '999999999', // decoy — must not be forwarded
            amount_out: '1', // decoy — must not be forwarded
            fee_amount: '123456789', // decoy — must not be forwarded
          },
        ],
      }),
    }) as unknown as typeof fetch
    buildSettlementReceiptMock.mockResolvedValue(makeReceipt())

    render(<SettlementReceiptModal order={makeOrder()} onClose={() => {}} />)
    await waitFor(() => expect(buildSettlementReceiptMock).toHaveBeenCalledTimes(1))

    const callArgs = buildSettlementReceiptMock.mock.calls[0][0] as { fills: unknown[] }
    expect(callArgs.fills).toEqual([{
      executionNumber: 1, txHash: '0xfill1', createdAt: '2026-01-01T00:00:00Z',
      nextBestOutRaw: null, nextBestSource: null,
    }])
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

// ── [CHORE-DCA-AGGREGATION-VALUE] "Aggregation value" line — per-fill + total ──────────────
describe('SettlementReceiptModal [CHORE-DCA-AGGREGATION-VALUE] — aggregation value', () => {
  it('renders the per-fill line with exact delta math when a runner-up was recorded', async () => {
    buildSettlementReceiptMock.mockResolvedValue(
      makeReceipt({
        fills: [
          {
            executionNumber: 1,
            txHash: '0xfill1',
            txUrl: 'https://basescan.org/tx/0xfill1',
            timestamp: 1_700_000_000_000,
            amountInRaw: '1000000',
            amountOutRaw: '500000000000000000', // 0.5 WETH
            effectivePrice: 2,
            protocolFeeRaw: '2000',
            networkCostWeiRaw: '100000000000000',
            nextBestOutRaw: '480000000000000000', // 0.48 WETH — runner-up
            nextBestSource: '1inch',
            aggregationValueRaw: '20000000000000000', // exact delta: 0.02 WETH
          },
        ],
        totals: {
          totalInvestedRaw: '1000000',
          totalReceivedRaw: '500000000000000000',
          avgPrice: 2,
          totalProtocolFeeRaw: '2000',
          totalNetworkCostWeiRaw: '100000000000000',
          totalAggregationValueRaw: '20000000000000000',
        },
      }),
    )
    render(<SettlementReceiptModal order={makeOrder()} onClose={vi.fn()} />)

    const line = await screen.findByTestId('fill-aggregation-value')
    expect(line.textContent).toMatch(/Next-best: 1inch/)
    expect(line.textContent).toMatch(/Aggregation value: \+0[.,]02 WETH/)
    // Fee stays on its own, separate line — never folded into the aggregation-value text.
    expect(line.textContent).not.toMatch(/Fee/)
  })

  it('shows "—" for a fill with no runner-up recorded (no claim, never fabricated)', async () => {
    buildSettlementReceiptMock.mockResolvedValue(makeReceipt()) // default fixture: nextBestOutRaw null
    render(<SettlementReceiptModal order={makeOrder()} onClose={vi.fn()} />)

    const line = await screen.findByTestId('fill-aggregation-value')
    expect(line.textContent?.trim()).toBe('Aggregation value: —')
  })

  it('total "Aggregation value" line shows "—" when no fill in the position has comparison data', async () => {
    buildSettlementReceiptMock.mockResolvedValue(makeReceipt()) // totalAggregationValueRaw: null
    render(<SettlementReceiptModal order={makeOrder()} onClose={vi.fn()} />)

    const total = await screen.findByTestId('settlement-aggregation-value-total')
    expect(total.textContent).toMatch(/—/)
  })

  it('total "Aggregation value" line renders the summed delta when present', async () => {
    buildSettlementReceiptMock.mockResolvedValue(
      makeReceipt({
        totals: {
          totalInvestedRaw: '1000000',
          totalReceivedRaw: '500000000000000000',
          avgPrice: 2,
          totalProtocolFeeRaw: '2000',
          totalNetworkCostWeiRaw: '100000000000000',
          totalAggregationValueRaw: '20000000000000000', // 0.02 WETH
        },
      }),
    )
    render(<SettlementReceiptModal order={makeOrder()} onClose={vi.fn()} />)

    const total = await screen.findByTestId('settlement-aggregation-value-total')
    expect(total.textContent).toMatch(/\+0[.,]02 WETH/)
  })

  it('never claims "free", never states a guaranteed/absolute savings claim, never names an external competitor', async () => {
    buildSettlementReceiptMock.mockResolvedValue(
      makeReceipt({
        fills: [
          {
            executionNumber: 1, txHash: '0xfill1', txUrl: 'https://basescan.org/tx/0xfill1',
            timestamp: 1_700_000_000_000, amountInRaw: '1000000', amountOutRaw: '500000000000000000',
            effectivePrice: 2, protocolFeeRaw: '2000', networkCostWeiRaw: '100000000000000',
            nextBestOutRaw: '480000000000000000', nextBestSource: '1inch',
            aggregationValueRaw: '20000000000000000',
          },
        ],
      }),
    )
    render(<SettlementReceiptModal order={makeOrder()} onClose={vi.fn()} />)
    await screen.findByTestId('fill-aggregation-value')

    const body = screen.getByTestId('settlement-receipt-body').textContent ?? ''
    expect(body.toLowerCase()).not.toMatch(/\bfree\b|gasless/)
    expect(body.toLowerCase()).not.toMatch(/guaranteed|always saves|1inch\.io|paraswap\.io|uniswap\.org/i)
    // Naming the WINNING source by its keeper-recorded label ("1inch") is fine — that IS the data;
    // the denylist above targets marketing-style named-competitor comparisons, not this.
  })
})

// ── [ADR-020 / finding B6] The receipt's route label reads the chain's whitelisted-router map ──
// This is a DISPLAY path, so "fail closed" here means "never fabricate": a router address that is
// not in THIS chain's set must degrade to the generic label, not borrow mainnet's name for it.
// Before the fail-closed map, an order on a chain config.ts does not know resolved its label
// against MAINNET_ROUTERS, so a mainnet address printed a confident, wrong "1inch v6".
describe('SettlementReceiptModal [ADR-020] — route label never borrows another chain map', () => {
  const ARBITRUM_CHAIN_ID = 42161

  function receiptWithRunnerUp() {
    return makeReceipt({
      chainId: ARBITRUM_CHAIN_ID,
      fills: [
        {
          executionNumber: 1,
          txHash: '0xfill1',
          txUrl: 'https://arbiscan.io/tx/0xfill1',
          timestamp: 1_700_000_000_000,
          amountInRaw: '1000000',
          amountOutRaw: '500000000000000000',
          effectivePrice: 2,
          protocolFeeRaw: '2000',
          networkCostWeiRaw: '100000000000000',
          nextBestOutRaw: '480000000000000000',
          nextBestSource: 'kyberswap',
          aggregationValueRaw: '20000000000000000',
        },
      ],
    })
  }

  it("shows the generic label for a mainnet router address on a chain with no router set", async () => {
    // Address READ from the mainnet map, never typed here — the same negative control the
    // config-level suite uses (src/lib/order-engine/router-map-fail-closed.test.ts).
    const mainnetOneInch = getWhitelistedRouters(1)['1inch']
    expect(mainnetOneInch).toBeDefined()

    buildSettlementReceiptMock.mockResolvedValue(receiptWithRunnerUp())
    render(
      <SettlementReceiptModal
        order={makeOrder({
          chainId: ARBITRUM_CHAIN_ID,
          order: { maxSlippageBps: 300, router: mainnetOneInch.address } as AutonomousOrder['order'],
        })}
        onClose={vi.fn()}
      />,
    )

    const line = await screen.findByTestId('fill-aggregation-value')
    expect(line.textContent).toMatch(/Best route: our route/)
    expect(line.textContent).not.toMatch(new RegExp(mainnetOneInch.label))
  })

  it('still names the router on a chain that DOES have a set (Base)', async () => {
    const baseAugustus = getWhitelistedRouters(8453)['augustusV6']
    expect(baseAugustus).toBeDefined()

    buildSettlementReceiptMock.mockResolvedValue(makeReceipt({ ...receiptWithRunnerUp(), chainId: 8453 }))
    render(
      <SettlementReceiptModal
        order={makeOrder({
          chainId: 8453,
          order: { maxSlippageBps: 300, router: baseAugustus.address } as AutonomousOrder['order'],
        })}
        onClose={vi.fn()}
      />,
    )

    const line = await screen.findByTestId('fill-aggregation-value')
    expect(line.textContent).toMatch(new RegExp(`Best route: ${baseAugustus.label}`))
  })
})
