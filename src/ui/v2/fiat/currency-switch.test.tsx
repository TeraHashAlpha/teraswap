// @vitest-environment jsdom
/**
 * [feat/ui-v2-fiat-value C2] The $ / € switch in the account menu: a labelled group, stored in localStorage, dollars by default, the euro
 * option disabled with the title "EUR rate unavailable" when the rate cannot be used.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1, useActiveChainId: () => 1 }))

import { CurrencySwitch } from './CurrencySwitch'
import { _resetEurRate } from './eur-rate'
import { _resetFiatPreference, FIAT_CURRENCY_KEY } from './fiat-preference'

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
const eur = () => screen.getByRole('button', { name: /€ EUR/ }) as HTMLButtonElement
const usd = () => screen.getByRole('button', { name: /\$ USD/ }) as HTMLButtonElement

function stubEur(body: { rate: number; updatedAt: number; maxStaleness: number } | null) {
  vi.stubGlobal('fetch', vi.fn(async () => (body ? { ok: true, json: async () => body } : { ok: false, status: 503, json: async () => ({}) })))
}

beforeEach(() => {
  localStorage.clear()
  _resetFiatPreference()
  _resetEurRate()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('CurrencySwitch', () => {
  it('is a labelled group; dollars are selected by default', async () => {
    stubEur({ rate: 1.1, updatedAt: Math.floor(Date.now() / 1000) - 60, maxStaleness: 90000 })
    render(<CurrencySwitch />)
    await flush()
    const group = screen.getByRole('group', { name: 'Currency' })
    expect(group).toBeTruthy()
    expect(usd().getAttribute('aria-pressed')).toBe('true')
    expect(eur().getAttribute('aria-pressed')).toBe('false')
  })

  it('choosing euros switches and is stored in localStorage; choosing dollars again switches back', async () => {
    stubEur({ rate: 1.1, updatedAt: Math.floor(Date.now() / 1000) - 60, maxStaleness: 90000 })
    render(<CurrencySwitch />)
    await flush()
    fireEvent.click(eur())
    expect(localStorage.getItem(FIAT_CURRENCY_KEY)).toBe('EUR')
    await flush()
    expect(eur().getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(usd())
    expect(localStorage.getItem(FIAT_CURRENCY_KEY)).toBe('USD')
    expect(usd().getAttribute('aria-pressed')).toBe('true')
  })

  it('RATE UNAVAILABLE: the euro option is disabled, titled "EUR rate unavailable", and a click stores nothing', async () => {
    stubEur(null)
    render(<CurrencySwitch />)
    await flush()
    expect(eur().disabled).toBe(true)
    expect(eur().title).toBe('EUR rate unavailable')
    fireEvent.click(eur())
    expect(localStorage.getItem(FIAT_CURRENCY_KEY)).toBeNull()
    expect(usd().getAttribute('aria-pressed')).toBe('true')
  })

  it('a STALE rate is the same: disabled, dollars selected even when euros were stored', async () => {
    // A Wednesday: on the real clock this fails every Sunday, when the closed FX market makes the product accept a round this old.
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
    localStorage.setItem(FIAT_CURRENCY_KEY, 'EUR')
    _resetFiatPreference()
    stubEur({ rate: 1.1, updatedAt: Math.floor(Date.now() / 1000) - 200_000, maxStaleness: 90000 })
    render(<CurrencySwitch />)
    await flush()
    expect(eur().disabled).toBe(true)
    expect(eur().title).toBe('EUR rate unavailable')
    expect(usd().getAttribute('aria-pressed')).toBe('true')
  })

  it('market hours: on a Wednesday a 30 h round disables the euro option; on a Saturday Friday\'s round keeps it enabled', async () => {
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
    stubEur({ rate: 1.1, updatedAt: Date.parse('2026-11-10T06:00:00Z') / 1000, maxStaleness: 90000 })
    const wed = render(<CurrencySwitch />)
    await flush()
    expect(eur().disabled).toBe(true)
    expect(eur().title).toBe('EUR rate unavailable')
    wed.unmount()
    _resetEurRate()
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'))
    stubEur({ rate: 1.1, updatedAt: Date.parse('2026-11-13T20:00:00Z') / 1000, maxStaleness: 90000 })
    render(<CurrencySwitch />)
    await flush()
    expect(eur().disabled).toBe(false)
  })

  it('while the first answer is pending the euro option is disabled WITHOUT the unavailable title', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<CurrencySwitch />)
    expect(eur().disabled).toBe(true)
    expect(eur().title).toBe('')
  })

  it('no box language: the choices are text buttons with no border or fill classes of their own', async () => {
    stubEur(null)
    render(<CurrencySwitch />)
    await flush()
    for (const b of [usd(), eur()]) expect(b.className).not.toMatch(/\bborder\b|bg-v2-(?!transparent)/)
  })
})
