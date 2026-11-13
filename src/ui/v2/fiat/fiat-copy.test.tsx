// @vitest-environment jsdom
/**
 * [feat/ui-v2-fiat-value C3] The new copy, listed once (this table is the content-map delta) and held to the owner's rule: no U+2014 and no
 * spaced U+2013 in anything a visitor reads. The repo-wide net is `__tests__/no-em-dash.guard.test.tsx`; this one pins the exact strings.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1, useActiveChainId: () => 1 }))

import { CurrencySwitch } from './CurrencySwitch'
import { EUR_RATE_UNAVAILABLE_TITLE } from './eur-rate'
import { fmtFiat } from './fiat-format'

/** Every string this change adds to what a visitor sees (v2 only; v1 gains none). */
export const NEW_COPY: Record<string, string> = {
  'Account menu, group label': 'Currency',
  'Account menu, dollar choice': '$ USD',
  'Account menu, euro choice': '€ EUR',
  'Account menu, euro choice title when the rate cannot be used': 'EUR rate unavailable',
  'Sell / Receive line prefix (muted, under the amount)': '≈ ',
  'Sell / Receive line example': fmtFiat(2105.4, 'USD', { approx: true }) ?? '',
  'Est. gas line (native first, fiat second)': '~0.00011 ETH ($0.21)',
}

const bad = (s: string) => s.includes('—') || s.includes(' – ')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('new copy', () => {
  it('contains no em dash and no spaced en dash', () => {
    for (const [where, s] of Object.entries(NEW_COPY)) expect(bad(s), where).toBe(false)
    expect(bad(EUR_RATE_UNAVAILABLE_TITLE)).toBe(false)
  })

  it('the title constant is the owner\'s exact words', () => {
    expect(EUR_RATE_UNAVAILABLE_TITLE).toBe(NEW_COPY['Account menu, euro choice title when the rate cannot be used'])
  })

  it('the rendered switch (text and attributes) is clean and says what the table says', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    const { container } = render(<CurrencySwitch />)
    await new Promise((r) => setTimeout(r, 0))
    const html = container.innerHTML
    const text = container.textContent ?? ''
    expect(bad(html)).toBe(false)
    expect(text).toContain(NEW_COPY['Account menu, group label'])
    expect(text).toContain(NEW_COPY['Account menu, dollar choice'])
    expect(text).toContain(NEW_COPY['Account menu, euro choice'])
  })
})
