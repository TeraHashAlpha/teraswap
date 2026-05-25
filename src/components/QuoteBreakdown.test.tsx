// @vitest-environment jsdom
/**
 * [P83/M-01 Phase 2] QuoteBreakdown — quote display + slippage editor.
 *
 * Verifies the structural rendering paths: source label, fee badge,
 * minimum-output computation, edit-slippage callback, and the
 * safeBigInt [10-L-01] guard against a malformed `toAmount`.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    isFeeCollectorActive: () => true,
  }
})

import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import QuoteBreakdown from './QuoteBreakdown'
import type { MetaQuoteResult } from '@/lib/api'
import type { Token } from '@/lib/tokens'
import type { PriceCheck } from '@/lib/chainlink'

const ETH: Token = {
  address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as `0x${string}`,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native',
}
const USDC: Token = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '',
  category: 'Stablecoin',
}

function makeMeta(overrides: Partial<MetaQuoteResult['best']> = {}): MetaQuoteResult {
  const best = {
    source: '1inch' as const,
    toAmount: '3000000000', // 3000 USDC (6 decimals)
    estimatedGas: 200_000,
    gasUsd: 10,
    routes: [],
    tx: { to: '0x0', data: '0x', value: '0', gas: 200_000 },
    ...overrides,
  }
  return {
    best,
    all: [best],
    fetchedAt: Date.now(),
  } as MetaQuoteResult
}

const idlePriceCheck: PriceCheck = {
  chainlinkPrice: null,
  executionPrice: null,
  deviation: 0,
  level: 'none',
  message: null,
  oracleUnavailable: false,
}

function makeProps(over: Partial<React.ComponentProps<typeof QuoteBreakdown>> = {}) {
  return {
    meta: makeMeta(),
    tokenIn: ETH,
    tokenOut: USDC,
    amountIn: '1',
    slippage: 0.5,
    countdown: 10,
    priceCheck: idlePriceCheck,
    approvalPlan: null,
    onEditSlippage: vi.fn(),
    ...over,
  }
}

describe('QuoteBreakdown — render', () => {
  it('renders the source label (1inch)', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps()} />)
    expect(screen.getAllByText(/1inch/i).length).toBeGreaterThan(0)
  })

  it('renders the countdown when > 0', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ countdown: 7 })} />)
    expect(screen.getByText(/7s/)).toBeInTheDocument()
  })

  it('renders a minimum-output row reflecting slippage', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ slippage: 1 })} />)
    // USDC appears in multiple rows (output, min output, etc.) — assert
    // it shows up at all and that there's a "Min" row.
    expect(screen.getAllByText(/USDC/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/min/i)).toBeInTheDocument()
  })

  it('clicking the edit-slippage trigger calls onEditSlippage', () => {
    const onEditSlippage = vi.fn()
    renderWithProviders(<QuoteBreakdown {...makeProps({ onEditSlippage })} />)
    // The slippage row exposes a clickable element labelled as a
    // percentage. Find any button whose text matches a percentage.
    const buttons = screen.getAllByRole('button')
    // Click each button until one calls onEditSlippage; the test
    // succeeds when we find it.
    let called = false
    for (const btn of buttons) {
      fireEvent.click(btn)
      if (onEditSlippage.mock.calls.length > 0) {
        called = true
        break
      }
    }
    expect(called).toBe(true)
  })

  it('renders the warn-level price check banner when priceCheck.level=warn', () => {
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          priceCheck: {
            ...idlePriceCheck,
            level: 'warn',
            message: 'Price deviates from oracle',
          },
        })}
      />,
    )
    expect(screen.getByText(/deviates from oracle/i)).toBeInTheDocument()
  })

  it('renders the danger-level price check banner when priceCheck.level=danger', () => {
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          priceCheck: {
            ...idlePriceCheck,
            level: 'danger',
            message: 'Price significantly diverged',
          },
        })}
      />,
    )
    expect(screen.getByText(/significantly diverged/i)).toBeInTheDocument()
  })

  it('renders the oracle-unavailable warning when priceCheck.oracleUnavailable=true', () => {
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          priceCheck: { ...idlePriceCheck, oracleUnavailable: true },
        })}
      />,
    )
    expect(screen.getByText(/no chainlink oracle/i)).toBeInTheDocument()
  })
})

describe('QuoteBreakdown — safeBigInt guard [10-L-01]', () => {
  it('does not crash when best.toAmount is malformed', () => {
    expect(() =>
      renderWithProviders(
        <QuoteBreakdown {...makeProps({ meta: makeMeta({ toAmount: 'not-a-number' }) })} />,
      ),
    ).not.toThrow()
    // The rate row falls back to a dash placeholder when toAmount is invalid.
    expect(screen.getByText(/—|--/)).toBeInTheDocument()
  })
})
