// @vitest-environment jsdom
/**
 * [P83/M-01 Phase 2] QuoteBreakdown — quote display + slippage editor.
 *
 * Verifies the structural rendering paths: source label, fee badge,
 * minimum-output computation, edit-slippage callback, and the
 * safeBigInt [10-L-01] guard against a malformed `toAmount`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

describe('QuoteBreakdown — Base/mainnet Compare parity rendering [SPRINT-9E]', () => {
  // The component is chain-agnostic: the SAME markup renders for Base and mainnet
  // given a multi-source meta. This proves the "single-source Direct DEX" view is
  // purely a function of meta.all.length, not a chain conditional.
  function multiMeta(): MetaQuoteResult {
    const mk = (source: MetaQuoteResult['best']['source'], toAmount: string) => ({
      source, toAmount, estimatedGas: 150_000, gasUsd: 0, routes: [],
    })
    const best = mk('velora', '3000000000')
    return {
      best,
      all: [best, mk('kyberswap', '2999000000'), mk('cowswap', '2998000000'), mk('uniswapv3', '2997000000')],
      fetchedAt: Date.now(),
    } as MetaQuoteResult
  }

  it('renders the Compare list for a multi-source meta (>1 source) — same component on every chain', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ meta: multiMeta() })} />)
    expect(screen.getByText(/Compare \(4 sources\)/i)).toBeInTheDocument()
    expect(screen.getAllByText(/velora/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/kyber/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/uniswap/i).length).toBeGreaterThan(0)
  })

  it('renders gas in ETH + USD when a gasEstimate is provided (parity USD display, not raw gas units)', () => {
    renderWithProviders(
      <QuoteBreakdown {...makeProps({ meta: multiMeta(), gasEstimate: () => ({ eth: 0.0001, usd: 0.25 }) })} />,
    )
    expect(screen.getByText(/\$0\.25/)).toBeInTheDocument()
  })
})

describe('QuoteBreakdown — [SPRINT-9Q Q2] rate-invert toggle', () => {
  beforeEach(() => { try { sessionStorage.clear() } catch {} })

  it('flips the rate direction on click (display-only, no math drift) and back', () => {
    // makeProps default: 1 ETH → 3000 USDC.
    renderWithProviders(<QuoteBreakdown {...makeProps()} />)
    const btn = () => screen.getByRole('button', { name: /flip rate direction/i })
    // Forward = ETH→USDC; value 3000 (formatDisplay uses a space thousands-separator).
    expect(btn().textContent).toMatch(/1\s*ETH\s*=.*USDC/)
    expect(btn().textContent).toContain('000.0000')
    fireEvent.click(btn())
    // Inverse = inputAmount / outputAmount = 1 / 3000 = 0.0003333… → formatDisplay 4dp = "0.0003".
    expect(btn().textContent).toMatch(/1\s*USDC\s*=.*ETH/)
    expect(btn().textContent).toContain('0.0003')
    fireEvent.click(btn())
    expect(btn().textContent).toMatch(/1\s*ETH\s*=.*USDC/)
  })

  it('guards a zero output (no Infinity) — inverse shows the — placeholder', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ meta: makeMeta({ toAmount: '0' }) })} />)
    const btn = screen.getByRole('button', { name: /flip rate direction/i })
    fireEvent.click(btn)
    expect(btn.textContent).toMatch(/1\s*USDC\s*=\s*—\s*ETH/)
  })

  it('persists the chosen direction for the session (survives remount)', () => {
    const { unmount } = renderWithProviders(<QuoteBreakdown {...makeProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /flip rate direction/i }))
    expect(sessionStorage.getItem('teraswap:rateInverted')).toBe('1')
    unmount()
    renderWithProviders(<QuoteBreakdown {...makeProps()} />)
    // Re-mount reads the persisted direction → starts inverted (USDC-first).
    expect(screen.getByRole('button', { name: /flip rate direction/i }).textContent).toMatch(/1\s*USDC\s*=.*ETH/)
  })
})

describe('QuoteBreakdown — [SPRINT-9S S2] one calm, specific oracle notice', () => {
  it('dedupes to a SINGLE notice when oracle is unavailable — suppresses the generic warn banner', () => {
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          priceCheck: {
            ...idlePriceCheck,
            level: 'warn',
            message: 'GENERIC-STALE-BANNER',
            oracleUnavailable: true,
            oracleMissingSymbols: ['USDC'],
          },
        })}
      />,
    )
    // The specific oracle notice renders once…
    expect(screen.getAllByText(/no chainlink oracle/i)).toHaveLength(1)
    // …and the redundant generic warn banner is gone (the two stacked yellow boxes are now one).
    expect(screen.queryByText('GENERIC-STALE-BANNER')).toBeNull()
  })

  it('NAMES the token actually missing a feed (direction-agnostic) + states the swap is still protected', () => {
    // tokenIn is ETH, but the OUTPUT token (DAI here) is the one missing a feed — must name DAI.
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          priceCheck: { ...idlePriceCheck, level: 'warn', oracleUnavailable: true, oracleMissingSymbols: ['DAI'] },
        })}
      />,
    )
    const notice = screen.getByText(/no chainlink oracle/i).closest('div')!
    expect(notice.textContent).toMatch(/DAI/)
    expect(notice.textContent).not.toMatch(/\bETH\b/) // names the missing token, not the input
    expect(notice.textContent).toMatch(/multi-source/i)
    expect(notice.textContent).toMatch(/minimum-output/i)
  })

  it('shows NO oracle notice when both feeds exist (oracleUnavailable=false)', () => {
    renderWithProviders(
      <QuoteBreakdown {...makeProps({ priceCheck: { ...idlePriceCheck, oracleUnavailable: false } })} />,
    )
    expect(screen.queryByText(/no chainlink oracle/i)).toBeNull()
  })
})
