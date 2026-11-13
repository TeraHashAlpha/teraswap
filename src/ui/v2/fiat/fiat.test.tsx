// @vitest-environment jsdom
/**
 * [feat/ui-v2-fiat-value C1] The fiat value hook, its formatter, the currency preference and the EUR rate reader.
 * Cases: priced, unpriced, stale EUR, the switch, and "no RPC added" (every request goes to our own two HTTP routes, in one batch).
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_ETH } from '@/lib/constants'
import type { Token } from '@/lib/tokens'
import { fmtFiat, convertUsd } from './fiat-format'
import { _resetFiatPreference, FIAT_CURRENCY_KEY, getFiatCurrency, setFiatCurrency, useFiatPreference } from './fiat-preference'
import { _resetEurRate, judgeEurRate, loadEurRate, rejudge } from './eur-rate'
import { _resetApproxPrices } from './approx-prices'
import { fiatText, useFiatDisplay, useFiatValue } from './use-fiat-value'

const ETH = { address: NATIVE_ETH, symbol: 'ETH', decimals: 18 } as unknown as Token
const AAVE = { address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', symbol: 'AAVE', decimals: 18 } as unknown as Token
const NO_PRICE = { address: '0x00000000000000000000000000000000000000aa', symbol: 'NOPE', decimals: 18 } as unknown as Token

const nowSec = () => Math.floor(Date.now() / 1000)
let calls: string[]

function stubFetch(opts: { prices?: Record<string, number>; eur?: { rate: number; updatedAt: number; maxStaleness: number } | 'down' } = {}) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      if (url.startsWith('/api/portfolio/prices')) {
        const asked = decodeURIComponent(new URL(url, 'http://x').searchParams.get('tokens') ?? '').split(',')
        const prices: Record<string, number> = {}
        for (const a of asked) if (opts.prices?.[a]) prices[a] = opts.prices[a]
        return { ok: true, json: async () => ({ prices }) }
      }
      if (url.startsWith('/api/fiat/eur-usd')) {
        if (!opts.eur || opts.eur === 'down') return { ok: false, status: 503, json: async () => ({ error: 'EUR rate unavailable' }) }
        return { ok: true, json: async () => opts.eur }
      }
      throw new Error(`unexpected request ${url}`)
    }),
  )
}

const PRICES = { [NATIVE_ETH.toLowerCase()]: 1403.6, [AAVE.address.toLowerCase()]: 180 }
const FRESH_EUR = () => ({ rate: 1.1, updatedAt: nowSec() - 600, maxStaleness: 90000 })

beforeEach(() => {
  localStorage.clear()
  _resetFiatPreference()
  _resetEurRate()
  _resetApproxPrices()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers() // also restores the real clock after a vi.setSystemTime
})

describe('fmtFiat', () => {
  it('two decimals, thin-space grouping, ≈ prefix on request', () => {
    expect(fmtFiat(2105.4, 'USD')).toBe('$2 105.40')
    expect(fmtFiat(2105.4, 'USD', { approx: true })).toBe('≈ $2 105.40')
    expect(fmtFiat(2105.4, 'EUR', { approx: true })).toBe('≈ €2 105.40')
    expect(fmtFiat(0.2149, 'EUR')).toBe('€0.21')
  })
  it('below one cent reads <$0.01 / <€0.01; unusable values return null, never $0 or a dash', () => {
    expect(fmtFiat(0.004, 'USD')).toBe('<$0.01')
    expect(fmtFiat(0.004, 'EUR')).toBe('<€0.01')
    for (const bad of [null, undefined, NaN, Infinity, -1]) expect(fmtFiat(bad as number, 'USD')).toBeNull()
  })
  it('convertUsd: euros need a rate; a EUR request without one is null (never a dollar figure labelled €)', () => {
    expect(convertUsd(110, 'EUR', 1.1)).toBeCloseTo(100)
    expect(convertUsd(110, 'EUR', null)).toBeNull()
    expect(convertUsd(110, 'EUR', 0)).toBeNull()
    expect(convertUsd(110, 'USD', null)).toBe(110)
  })
})

describe('useFiatValue: priced and unpriced', () => {
  it('ETH → "≈ $…" for a pair with no stablecoin, from /api/portfolio/prices', async () => {
    stubFetch({ prices: PRICES })
    const { result } = renderHook(() => useFiatValue('1.5', ETH, 1))
    expect(result.current.text).toBeNull() // nothing until a price arrives
    await waitFor(() => expect(result.current.text).toBe(`≈ $${(1.5 * 1403.6).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`))
  })
  it('an unpriced token renders nothing (null), not $0 and not a dash', async () => {
    stubFetch({ prices: PRICES })
    const { result } = renderHook(() => useFiatValue('10', NO_PRICE, 1))
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    await act(async () => {})
    expect(result.current.text).toBeNull()
  })
  it('no amount, zero, malformed, or no token → null and no request', async () => {
    stubFetch({ prices: PRICES })
    for (const amount of ['', '0', '0.0', 'abc', null, undefined]) {
      const { result } = renderHook(() => useFiatValue(amount, ETH, 1))
      await act(async () => {})
      expect(result.current.text, String(amount)).toBeNull()
    }
    const { result } = renderHook(() => useFiatValue('1', null, 1))
    expect(result.current.text).toBeNull()
  })
  it('a failed price call renders nothing', async () => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (calls.push(u), { ok: false, status: 500, json: async () => ({}) })))
    const { result } = renderHook(() => useFiatValue('1', ETH, 1))
    await act(async () => {})
    expect(result.current.text).toBeNull()
  })
})

describe('no RPC added', () => {
  it('Sell, Receive and the fee line on one card cost ONE price request, and nothing else is fetched', async () => {
    stubFetch({ prices: PRICES })
    const { result } = renderHook(() => ({ sell: useFiatValue('1', ETH, 1), recv: useFiatValue('7', AAVE, 1), fee: useFiatValue('0.001', ETH, 1) }))
    await waitFor(() => expect(result.current.recv.text).not.toBeNull())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^\/api\/portfolio\/prices\?tokens=.*&chainId=1$/)
    expect(calls.every((c) => c.startsWith('/api/portfolio/prices'))).toBe(true) // dollars: the EUR route is not even asked
    expect(calls.some((c) => c.includes('/api/rpc'))).toBe(false)
  })
})

describe('the switch', () => {
  it('defaults to dollars, persists the choice in localStorage, and every consumer follows', async () => {
    stubFetch({ prices: PRICES, eur: FRESH_EUR() })
    expect(getFiatCurrency()).toBe('USD')
    const { result } = renderHook(() => ({ pref: useFiatPreference(), v: useFiatValue('1', ETH, 1) }))
    await waitFor(() => expect(result.current.v.text).toMatch(/^≈ \$/))
    act(() => setFiatCurrency('EUR'))
    expect(localStorage.getItem(FIAT_CURRENCY_KEY)).toBe('EUR')
    await waitFor(() => expect(result.current.v.text).toMatch(/^≈ €/))
    expect(result.current.v.text).toBe(`≈ €${(1403.6 / 1.1).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`)
    act(() => setFiatCurrency('USD'))
    await waitFor(() => expect(result.current.v.text).toMatch(/^≈ \$/))
  })
  it('reads a stored choice; junk in storage is the default; storage that throws still switches for the page', () => {
    localStorage.setItem(FIAT_CURRENCY_KEY, 'EUR')
    _resetFiatPreference()
    expect(getFiatCurrency()).toBe('EUR')
    localStorage.setItem(FIAT_CURRENCY_KEY, 'GBP')
    _resetFiatPreference()
    expect(getFiatCurrency()).toBe('USD')
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    setFiatCurrency('EUR')
    expect(getFiatCurrency()).toBe('EUR')
    spy.mockRestore()
  })
})

describe('the EUR rate', () => {
  it('fresh → used; the euro is fetched only once the visitor asks for it (or the switch probes)', async () => {
    stubFetch({ prices: PRICES, eur: FRESH_EUR() })
    const { result } = renderHook(() => useFiatDisplay(1))
    await act(async () => {})
    expect(calls.filter((c) => c.startsWith('/api/fiat/eur-usd'))).toHaveLength(0) // dollars, no probe: not asked
    act(() => setFiatCurrency('EUR'))
    await waitFor(() => expect(result.current.currency).toBe('EUR'))
    expect(result.current.usdPerEur).toBe(1.1)
    expect(calls.filter((c) => c.startsWith('/api/fiat/eur-usd'))).toEqual(['/api/fiat/eur-usd?chainId=1']) // the feed's chain, one cache entry
  })
  it('STALE → dollars are shown, the euro option is unavailable, and no euro figure is ever produced', async () => {
    stubFetch({ prices: PRICES, eur: { rate: 1.1, updatedAt: nowSec() - 200_000, maxStaleness: 90000 } })
    setFiatCurrency('EUR')
    const { result } = renderHook(() => ({ d: useFiatDisplay(1), v: useFiatValue('1', ETH, 1) }))
    await waitFor(() => expect(result.current.v.text).toMatch(/^≈ \$/))
    expect(result.current.d).toMatchObject({ currency: 'USD', usdPerEur: null, preference: 'EUR', eurAvailable: false })
  })
  it('unavailable (503) → the same fallback; a malformed body too', async () => {
    stubFetch({ prices: PRICES, eur: 'down' })
    setFiatCurrency('EUR')
    const { result } = renderHook(() => useFiatDisplay(1))
    await waitFor(() => expect(result.current.eurAvailable).toBe(false))
    expect(result.current.currency).toBe('USD')
    _resetEurRate()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rate: 'x' }) })))
    await act(async () => {
      await loadEurRate(1)
    })
    expect(judgeEurRate({ phase: 'failed', at: 0 }, Date.now()).status).toBe('unavailable')
    expect(result.current.currency).toBe('USD')
  })
  it('a payload that was fresh when fetched but has since aged out is judged unavailable at the moment of use', () => {
    const payload = { rate: 1.1, updatedAt: nowSec() - 89_000, maxStaleness: 90000 }
    expect(judgeEurRate({ phase: 'ready', payload, at: Date.now() }, Date.now()).status).toBe('ok')
    expect(judgeEurRate({ phase: 'ready', payload, at: Date.now() }, Date.now() + 2_000_000).status).toBe('unavailable')
  })
})

describe('EUR staleness by market hours (owner decision)', () => {
  const sec = (iso: string) => Date.parse(iso) / 1000
  it('SATURDAY with Friday\'s round: euros are shown and the option is available', async () => {
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'))
    stubFetch({ prices: PRICES, eur: { rate: 1.1, updatedAt: sec('2026-11-13T20:00:00Z'), maxStaleness: 90000 } })
    setFiatCurrency('EUR')
    const { result } = renderHook(() => ({ d: useFiatDisplay(1), v: useFiatValue('1', ETH, 1) }))
    await waitFor(() => expect(result.current.v.text).toMatch(/^≈ €/))
    expect(result.current.d).toMatchObject({ currency: 'EUR', eurAvailable: true, usdPerEur: 1.1 })
  })
  it('WEDNESDAY with a 30 h old round: dollars, and the option is disabled', async () => {
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
    stubFetch({ prices: PRICES, eur: { rate: 1.1, updatedAt: sec('2026-11-10T06:00:00Z'), maxStaleness: 90000 } })
    setFiatCurrency('EUR')
    const { result } = renderHook(() => ({ d: useFiatDisplay(1), v: useFiatValue('1', ETH, 1) }))
    await waitFor(() => expect(result.current.v.text).toMatch(/^≈ \$/))
    expect(result.current.d).toMatchObject({ currency: 'USD', eurAvailable: false, eurStatus: 'unavailable' })
  })
})

describe('aging while the page stays open', () => {
  it('a rate that was fresh when loaded flips to dollars once its round ages out (the tick re-judges; render never reads the clock)', async () => {
    stubFetch({ prices: PRICES, eur: { rate: 1.1, updatedAt: nowSec() - 89_000, maxStaleness: 90000 } })
    setFiatCurrency('EUR')
    const { result } = renderHook(() => useFiatDisplay(1))
    await waitFor(() => expect(result.current.currency).toBe('EUR'))
    act(() => rejudge(Date.now() + 2_000_000))
    expect(result.current).toMatchObject({ currency: 'USD', usdPerEur: null, preference: 'EUR', eurAvailable: false })
  })
})

describe('fiatText (pure)', () => {
  it('multiplies, converts, formats; unpriced is null', () => {
    expect(fiatText('2', 100, { currency: 'USD', usdPerEur: null })).toBe('≈ $200.00')
    expect(fiatText('2', 110, { currency: 'EUR', usdPerEur: 1.1 })).toBe('≈ €200.00')
    expect(fiatText('2', null, { currency: 'USD', usdPerEur: null })).toBeNull()
    expect(fiatText('2', 100, { currency: 'USD', usdPerEur: null }, false)).toBe('$200.00')
  })
})
