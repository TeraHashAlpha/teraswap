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

  // [feat/swap-price-tiers] oracleUnavailable alone no longer renders the 9S S2 "No Chainlink oracle" amber —
  // the notice follows the SERVER's tier (see the tier block below); with no tier known, nothing is claimed.
  it('oracleUnavailable with no tier known renders NO oracle notice (the old amber is gone; the tier notice replaced it)', () => {
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          priceCheck: { ...idlePriceCheck, oracleUnavailable: true },
        })}
      />,
    )
    expect(screen.queryByText(/no chainlink oracle/i)).toBeNull()
    expect(screen.queryByTestId('price-tier-single-source')).toBeNull()
    expect(screen.queryByTestId('price-tier-unpriced')).toBeNull()
  })

  // [FIX-PRICE-ORACLE-FAIL-CLOSED] A feed that exists but could not be READ is also
  // oracleUnavailable — but saying the token "has no Chainlink oracle" is false during an outage.
  // The two notices must not be interchangeable.
  it('a READ FAILURE says the feed could not be read — never that the token has no oracle', () => {
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          priceCheck: { ...idlePriceCheck, oracleUnavailable: true, oracleReadFailed: true },
        })}
      />,
    )
    const notice = screen.getByTestId('oracle-read-failed-notice')
    expect(notice.textContent).toMatch(/could not be read/i)
    // The no-feed notice must NOT also render — one verdict, one message.
    expect(screen.queryByText(/no chainlink oracle/i)).toBeNull()
  })

  it('the Rate tooltip likewise distinguishes a read failure from a missing feed', () => {
    const { rerender } = renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          priceCheck: { ...idlePriceCheck, oracleUnavailable: true, oracleReadFailed: true },
        })}
      />,
    )
    expect(screen.getByText(/^Rate/).getAttribute('title')).toMatch(/could not be read/i)

    rerender(
      <QuoteBreakdown
        {...makeProps({ priceCheck: { ...idlePriceCheck, oracleUnavailable: true } })}
      />,
    )
    expect(screen.getByText(/^Rate/).getAttribute('title')).toMatch(/No Chainlink oracle/i)
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
  // [feat/swap-price-tiers] The 9S S2 "No Chainlink oracle … multi-source price comparison" amber is gone:
  // it pre-dated the value gate and claimed a reference the client never had. The notice now follows the
  // SERVER's tier (D1): single-source → the owner amber; unpriced → a heads-up that consent will be asked;
  // priced or unknown → nothing.
  const SINGLE = { tier: 'single-source' as const, legs: { in: { tier: 'single-source' as const, sources: ['defillama' as const], usd: 0.69 }, out: { tier: 'unpriced' as const, sources: [] } } }
  const UNPRICED = { tier: 'unpriced' as const, legs: { in: { tier: 'unpriced' as const, sources: [] }, out: { tier: 'unpriced' as const, sources: [] } } }
  const PRICED = { tier: 'priced' as const, legs: { in: { tier: 'priced' as const, sources: ['defillama' as const, 'coingecko' as const], usd: 0.69, agreementBps: 2 }, out: { tier: 'priced' as const, sources: ['defillama' as const, 'coingecko' as const], usd: 0.64, agreementBps: 3 } }, agreementBps: 3 }
  const NO_FEED = { ...idlePriceCheck, level: 'warn' as const, message: 'GENERIC-STALE-BANNER', oracleUnavailable: true, oracleMissingSymbols: ['USDC'] }

  it('single-source tier → the owner amber naming the vendor; the generic warn banner stays deduped', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ priceCheck: NO_FEED, priceTier: SINGLE })} />)
    expect(screen.getByTestId('price-tier-single-source').textContent)
      .toContain('Price from one source only (DefiLlama). Value-based limits use that price; double-check the rate before swapping.')
    expect(screen.queryByText('GENERIC-STALE-BANNER')).toBeNull()
    expect(screen.queryByText(/no chainlink oracle/i)).toBeNull()
    expect(screen.queryByTestId('price-tier-unpriced')).toBeNull()
  })

  it('unpriced tier → names BOTH tokens and says a confirmation will be asked; never the old "multi-source price comparison" claim', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ priceCheck: NO_FEED, priceTier: UNPRICED })} />)
    const notice = screen.getByTestId('price-tier-unpriced')
    expect(notice.textContent).toMatch(/No reference price for this pair/)
    expect(notice.textContent).toMatch(/for ETH or USDC/)
    expect(notice.textContent).toMatch(/asked to confirm before swapping/i)
    expect(notice.textContent).not.toMatch(/multi-source/i)
    expect(screen.queryByTestId('price-tier-single-source')).toBeNull()
  })

  it('priced tier → NO tier notice even with no Chainlink feed (the old amber is gone)', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ priceCheck: NO_FEED, priceTier: PRICED })} />)
    expect(screen.queryByTestId('price-tier-single-source')).toBeNull()
    expect(screen.queryByTestId('price-tier-unpriced')).toBeNull()
    expect(screen.queryByText(/no chainlink oracle/i)).toBeNull()
    expect(screen.queryByText(/multi-source/i)).toBeNull()
  })

  it('unknown tier (not answered yet / fetch failed) → nothing: the client never guesses (D1)', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ priceCheck: NO_FEED, priceTier: null })} />)
    expect(screen.queryByTestId('price-tier-single-source')).toBeNull()
    expect(screen.queryByTestId('price-tier-unpriced')).toBeNull()
    expect(screen.queryByText(/no chainlink oracle/i)).toBeNull()
  })

  it('shows NO tier notice when both feeds exist and the pair is priced', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ priceCheck: { ...idlePriceCheck, oracleUnavailable: false }, priceTier: PRICED })} />)
    expect(screen.queryByTestId('price-tier-single-source')).toBeNull()
    expect(screen.queryByTestId('price-tier-unpriced')).toBeNull()
  })
})

// [chore/swap-fee-usd-fix] Platform-fee USD must be valued from the reliably-priced
// side, never the fee (input) token × the other leg's price.
describe('QuoteBreakdown — platform fee USD (non-oracle fee token)', () => {
  const AERO: Token = {
    address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as `0x${string}`,
    symbol: 'AERO',
    name: 'Aerodrome',
    decimals: 18,
    logoURI: '',
    category: 'DeFi',
  }
  const WETH: Token = {
    address: '0x4200000000000000000000000000000000000006' as `0x${string}`,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    logoURI: '',
    category: 'Native',
  }

  it('AERO→WETH: values the AERO fee off the WETH oracle (~$0.002), NOT WETH price × an AERO amount (~$5.79)', () => {
    // ~$1.87 swap: 0.0005 WETH out at $3740. AERO (input) has no Chainlink feed.
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          tokenIn: AERO,
          tokenOut: WETH,
          amountIn: '3.716',
          meta: makeMeta({ source: '0x', toAmount: '500000000000000' }), // 0.0005 WETH
          tokenInUsdPrice: null, // AERO: no oracle
          tokenOutUsdPrice: 3740, // WETH/USD oracle
        })}
      />,
    )
    expect(screen.getByText(/<\$0\.01/)).toBeInTheDocument()
    // The bug valued the fee in the dollars, not sub-cent.
    expect(screen.queryByText(/\$5\.79/)).toBeNull()
    expect(screen.queryByText(/\$13\.9/)).toBeNull()
  })

  it('oracle-input swap is unchanged: WETH→USDC fee = 0.1% × input notional ($3.74)', () => {
    // 1 WETH in at $3740 → fee USD = 0.1% × $3740 = $3.74 (identical to the old
    // feeAbsolute × inputPrice, since the input token IS priced).
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          tokenIn: WETH,
          tokenOut: USDC,
          amountIn: '1',
          meta: makeMeta({ toAmount: '3740000000' }), // 3740 USDC
          tokenInUsdPrice: 3740, // WETH/USD oracle
          tokenOutUsdPrice: 1, // USDC
        })}
      />,
    )
    expect(screen.getByText(/\$3\.74/)).toBeInTheDocument()
  })

  it('no oracle on either side: shows the fee amount but NO USD figure (never fabricated)', () => {
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          tokenIn: AERO,
          tokenOut: { ...USDC, symbol: 'USDbC' },
          amountIn: '3.716',
          tokenInUsdPrice: null,
          tokenOutUsdPrice: null,
        })}
      />,
    )
    // Fee amount in AERO still renders; no "($X)" USD figure is shown for the fee.
    expect(screen.getAllByText(/AERO/).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/\(\$\d/)
  })
})

// ─────────────────────────────────────────────────────────────
// [CHORE-SUSHI-V7] Quote-only scoping label — a source that cannot settle
// on the active chain (no SC-04 selector / R1 decoder / on-chain router
// whitelist, e.g. Sushi v7 via RedSnwapper) is shown in the compare list
// for price context but labeled informational.
// ─────────────────────────────────────────────────────────────
describe('QuoteBreakdown — quote-only source label [CHORE-SUSHI-V7]', () => {
  function compareMeta(sources: Array<[string, string]>): MetaQuoteResult {
    const quotes = sources.map(([source, toAmount]) => ({
      source, toAmount, estimatedGas: 0, gasUsd: 0, routes: [],
    }))
    return { best: quotes[0], all: quotes, fetchedAt: Date.now() } as MetaQuoteResult
  }

  it('labels sushiswap "Quote only" on mainnet (RedSnwapper not execution-wired)', () => {
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          meta: compareMeta([['kyberswap', '2990000000'], ['sushiswap', '3000000000']]),
          chainId: 1,
        })}
      />,
    )
    expect(screen.getByText(/quote only/i)).toBeInTheDocument()
  })

  it('does not label executable sources', () => {
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({
          meta: compareMeta([['kyberswap', '2990000000'], ['velora', '2980000000']]),
          chainId: 1,
        })}
      />,
    )
    expect(screen.queryByText(/quote only/i)).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────
// [CHORE-QUORUM-LOWCONFIDENCE-FIX] Thin-quorum signal — meta.lowConfidence
// (set by the quote-quorum band when the displayed best could not be
// cross-checked: <3 usable responders) must reach the user as an
// INFORMATIONAL cue: bold lead, calm body, no alarm colouring (house style
// of the oracle-less notice above). The flag was previously set but
// rendered nowhere — a dead safety signal.
// ─────────────────────────────────────────────────────────────
describe('QuoteBreakdown — low-confidence quorum cue [CHORE-QUORUM-LOWCONFIDENCE-FIX]', () => {
  it('renders the cue when meta.lowConfidence is set — singular copy for a single usable source', () => {
    renderWithProviders(
      <QuoteBreakdown {...makeProps({ meta: { ...makeMeta(), lowConfidence: true } })} />,
    )
    expect(screen.getByText('Low confidence')).toBeInTheDocument()
    expect(screen.getByText(/only 1 source responded with a usable quote/i)).toBeInTheDocument()
  })

  it('uses plural copy when two quotes are displayed but could not be cross-validated', () => {
    const base = makeMeta()
    const runnerUp = { ...base.best, source: 'kyberswap' as const, toAmount: '2990000000' }
    renderWithProviders(
      <QuoteBreakdown
        {...makeProps({ meta: { ...base, all: [base.best, runnerUp], lowConfidence: true } })}
      />,
    )
    expect(screen.getByText(/only 2 sources responded with a usable quote/i)).toBeInTheDocument()
  })

  it('renders NO cue when lowConfidence is absent (healthy quorum)', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps()} />)
    expect(screen.queryByText('Low confidence')).toBeNull()
  })

  it('keeps the cue informational: bold lead, NO alarm colouring, and names the minimum-output backstop', () => {
    renderWithProviders(
      <QuoteBreakdown {...makeProps({ meta: { ...makeMeta(), lowConfidence: true } })} />,
    )
    const label = screen.getByText('Low confidence')
    expect(label.className).toMatch(/font-semibold/)
    const box = label.closest('div')!
    // Non-alarmist by requirement: none of the danger/warn/amber alarm palettes.
    expect(box.className).not.toMatch(/danger|warning|amber|red-/)
    expect(box.textContent).toMatch(/minimum-output/i)
  })
})

describe('QuoteBreakdown — [fix/functional-chain-ui] route names (F2) and gas precision (F3)', () => {
  const rowText = (label: string) => screen.getByText(label).parentElement?.textContent ?? ''

  it('F3: an L2-sized 0.0000012 ETH gas cost renders "~0.0000012 ETH" (never "~0.0000 ETH"), USD first', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ gasEstimate: () => ({ eth: 0.0000012, usd: 0.0036 }) })} />)
    const gas = rowText('Est. gas')
    expect(gas).toContain('~0.0000012 ETH')
    expect(gas).not.toContain('0.0000 ETH')
    expect(gas.indexOf('<$0.01')).toBeGreaterThan(-1)
    expect(gas.indexOf('<$0.01')).toBeLessThan(gas.indexOf('~0.0000012 ETH'))
  })

  it('F3: a mainnet-sized 0.0031 ETH gas cost renders "$9.30 (~0.0031 ETH)"', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ gasEstimate: () => ({ eth: 0.0031, usd: 9.3 }) })} />)
    expect(rowText('Est. gas')).toBe('Est. gas$9.30 (~0.0031 ETH)')
  })

  it('F3: without a USD price only the ETH figure is shown', () => {
    renderWithProviders(<QuoteBreakdown {...makeProps({ gasEstimate: () => ({ eth: 0.0031, usd: 0 }) })} />)
    expect(rowText('Est. gas')).toBe('Est. gas~0.0031 ETH')
  })

  it('F2: a raw pool address in routes renders as the source name, never the address', () => {
    const pool = '0xe0554a476a092703abdb3ef35c80e0d76d32939f' // recorded KyberSwap 1-WETH hop `pool`
    renderWithProviders(
      <QuoteBreakdown {...makeProps({ meta: makeMeta({ source: 'kyberswap', routes: [pool] }) })} />,
    )
    const route = rowText('Route')
    expect(route).toBe('RouteKyberSwap')
    expect(route).not.toContain('0x')
  })

  it('F2: named hops pass through unchanged', () => {
    renderWithProviders(
      <QuoteBreakdown {...makeProps({ meta: makeMeta({ source: 'kyberswap', routes: ['uniswapv3', 'fluid-dex-t1'] }) })} />,
    )
    expect(rowText('Route')).toBe('Routeuniswapv3 + fluid-dex-t1')
  })
})
