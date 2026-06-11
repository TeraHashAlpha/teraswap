// @vitest-environment jsdom
/**
 * [RQ-2026-06-11] ExecutionTimeline — execution rows + explorer link.
 *
 * Pins the tx-hash explorer link to the mainnet explorer URL (order executions
 * are mainnet-only today — the executor is deployed on chainId 1 only), so the
 * chain-aware-helper refactor is provably byte-identical.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderWithProviders, screen } from '@/test-utils/render'
import ExecutionTimeline from './ExecutionTimeline'

const TX = '0x' + 'cd'.repeat(32)

function mockExecutionsFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      executions: [
        {
          id: 'ex-1',
          execution_number: 1,
          executed_at: new Date('2026-06-01T12:00:00Z').toISOString(),
          amount_in: '1000000000000000000',
          amount_out: '2900000000',
          tx_hash: TX,
          gas_used: null,
          gas_price: null,
          error: null,
          status: 'executed',
        },
      ],
      order: null,
    }),
  })))
}

beforeEach(() => {
  mockExecutionsFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ExecutionTimeline — explorer link [RQ-2026-06-11]', () => {
  it('renders the execution tx link as the mainnet explorer URL (byte-identical pin)', async () => {
    renderWithProviders(
      <ExecutionTimeline
        orderId="order-1"
        wallet="0x1111111111111111111111111111111111111111"
        tokenInSymbol="WETH"
        tokenOutSymbol="USDC"
        tokenInDecimals={18}
        tokenOutDecimals={6}
      />,
    )
    // The fetch resolves async — wait for the row to appear.
    const link = await screen.findByText(`${TX.slice(0, 10)}...${TX.slice(-6)}`)
    const anchor = link.closest('a') as HTMLAnchorElement
    expect(anchor).toBeTruthy()
    expect(anchor.href).toBe(`https://etherscan.io/tx/${TX}`)
  })
})
