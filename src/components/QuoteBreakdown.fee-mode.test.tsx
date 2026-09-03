// @vitest-environment jsdom
/**
 * [fix/zerox-partner-fee-armed] The rendered fee claim names its mechanism.
 *
 * The Platform-fee row carries data-fee-mode, so "we show a fee here" and "this
 * is WHY a fee is collected here" are separately assertable. Deliberately NO
 * mock of isFeeCollectorActive — the whole point is to exercise the real
 * chain-driven decision. User-facing copy is unchanged by this branch.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, screen } from '@/test-utils/render'
import QuoteBreakdown from './QuoteBreakdown'
import type { MetaQuoteResult } from '@/lib/api'
import type { Token } from '@/lib/tokens'
import type { PriceCheck } from '@/lib/chainlink'
import type { AggregatorName } from '@/lib/constants'

const ETH: Token = {
  address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as `0x${string}`,
  symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: '', category: 'Native',
}
const USDC: Token = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
  symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '', category: 'Stablecoin',
}
const idlePriceCheck: PriceCheck = {
  chainlinkPrice: null, executionPrice: null, deviation: 0,
  level: 'none', message: null, oracleUnavailable: false,
}

function renderFor(source: AggregatorName, chainId: number) {
  const best = {
    source, toAmount: '3000000000', estimatedGas: 200_000, gasUsd: 10, routes: [],
    tx: { to: '0x0', data: '0x', value: '0', gas: 200_000 },
  }
  const meta = { best, all: [best], fetchedAt: Date.now() } as MetaQuoteResult
  const { container } = renderWithProviders(
    <QuoteBreakdown
      meta={meta} chainId={chainId} tokenIn={ETH} tokenOut={USDC} amountIn="1"
      slippage={0.5} countdown={10} priceCheck={idlePriceCheck}
      approvalPlan={null} onEditSlippage={vi.fn()}
    />,
  )
  return container.querySelector('[data-fee-mode]')?.getAttribute('data-fee-mode')
}

const MAINNET = 1
const BASE = 8453 // FeeCollector env-unset in CI → inactive

describe('[acceptance 3] the fee row states the mechanism', () => {
  it("0x on mainnet → native-partner-fee, and a fee IS shown", () => {
    expect(renderFor('0x', MAINNET)).toBe('native-partner-fee')
    expect(screen.getByText(/Platform fee \(/)).toBeTruthy()
    expect(screen.queryByText('Free')).toBeNull()
  })

  it('a FeeCollector-routed source on mainnet → fee-collector', () => {
    expect(renderFor('kyberswap', MAINNET)).toBe('fee-collector')
  })

  // ── NEGATIVE CONTROL: FeeCollector inactive, native term isolated ──
  it('0x KEEPS its fee claim with the FeeCollector inactive (Base)', () => {
    expect(renderFor('0x', BASE)).toBe('native-partner-fee')
    expect(screen.queryByText('Free')).toBeNull()
  })

  it('kyberswap on that same chain drops to none → "Free"', () => {
    // Confirms the FeeCollector term is genuinely off on Base, so the 0x claim
    // above rests on the native mechanism alone and not on a leaked mainnet answer.
    expect(renderFor('kyberswap', BASE)).toBe('none')
    expect(screen.getByText('Free')).toBeTruthy()
  })
})
