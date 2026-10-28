// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SwapPriceLeg, SwapPriceTierResponse } from '@/lib/swap-price-tier'
import { SINGLE_SOURCE_TAIL, TierNotice, UNPRICED_LINE } from './TierNotice'

const leg = (tier: SwapPriceLeg['tier'], sources: SwapPriceLeg['sources'] = [], usd?: number): SwapPriceLeg => ({ tier, sources, ...(usd ? { usd } : {}) })
const pair = (tier: SwapPriceTierResponse['tier'], a: SwapPriceLeg, b: SwapPriceLeg): SwapPriceTierResponse => ({ tier, legs: { in: a, out: b } })
const text = (t: SwapPriceTierResponse | null | undefined) => render(<TierNotice tier={t} />).container.textContent

describe('tier notice (24)', () => {
  it('priced → nothing', () => {
    expect(text(pair('priced', leg('priced', ['chainlink', 'defillama'], 1), leg('priced', ['chainlink', 'defillama'], 1)))).toBe('')
  })
  it('unknown (null / undefined: not asked, in flight, failed) → nothing — the client never guesses', () => {
    expect(text(null)).toBe('')
    expect(text(undefined)).toBe('')
  })
  it('single-source → the amber notice, verbatim from v1 (#608), naming the vendor(s) in trust order', () => {
    expect(text(pair('single-source', leg('single-source', ['defillama'], 2490), leg('single-source', ['defillama'], 1)))).toBe(
      `⚠ Price from one source only (DefiLlama). ${SINGLE_SOURCE_TAIL}`,
    )
    expect(SINGLE_SOURCE_TAIL).toBe('Value-based limits use that price; double-check the rate before swapping.')
    expect(text(pair('single-source', leg('single-source', ['coingecko'], 1), leg('single-source', ['chainlink'], 1)))).toContain('(Chainlink / CoinGecko)')
  })
  it('unpriced → ONE line, verbatim; the consent dialog is B4', () => {
    const c = render(<TierNotice tier={pair('unpriced', leg('unpriced'), leg('unpriced'))} />).container
    expect(c.textContent).toBe('No reference price — consent required before swapping')
    expect(UNPRICED_LINE).toBe('No reference price — consent required before swapping')
    expect(c.querySelectorAll('button, input, [role="dialog"]').length).toBe(0)
  })
  it('each notice is amber and carries the testid v1 uses', () => {
    expect(render(<TierNotice tier={pair('single-source', leg('single-source', ['defillama'], 1), leg('single-source', ['defillama'], 1))} />).container.querySelector('[data-testid="price-tier-single-source"].border-v2-amber')).not.toBeNull()
    expect(render(<TierNotice tier={pair('unpriced', leg('unpriced'), leg('unpriced'))} />).container.querySelector('[data-testid="price-tier-unpriced"].border-v2-amber')).not.toBeNull()
  })
})
