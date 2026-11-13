// @vitest-environment jsdom
/**
 * [feat/ui-v2-fiat-value C2] The approximate fiat lines under Sell and Receive, and the gas / fee lines in the visitor's currency. The card's
 * hooks are mocked at the module edge exactly as in swap-card.test.tsx; the price and EUR routes are a fetch stub. DISPLAY ONLY: the review
 * sheet is built from the dollar view, so a euro figure never reaches it.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ETH, USDC, NO_ORACLE, fixtureMeta, taggedFixture } from './test-fixtures'
import { NATIVE_ETH } from '@/lib/constants'

const h = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false, chain: undefined as { id: number } | undefined },
  balance: undefined as { value: bigint; decimals: number } | undefined,
  chainId: 1,
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: vi.fn() },
  oracle: { chainlinkPrice: 2490 as number | null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false } as Record<string, unknown>,
  approval: { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 } as unknown, status: 'ready', error: null, approve: async () => {}, isReady: true } as Record<string, unknown>,
  tier: { data: null as unknown, loading: false },
  switchChain: vi.fn(),
  openConnectModal: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: h.balance }),
  useSwitchChain: () => ({ switchChain: h.switchChain }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => h.chainId, useActiveChainId: () => h.chainId }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => h.oracle }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => h.approval }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => h.tier }))
vi.mock('@/lib/sounds', () => ({ playQuoteReceived: vi.fn(), playTouchMP3: vi.fn(), stopWaitingSound: vi.fn() }))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: new Map() }) }))
vi.mock('./lifecycle/use-swap-lifecycle', async () => {
  const m = await import('./lifecycle/test-stubs')
  return { useSwapLifecycle: () => m.idleLifecycle() }
})
vi.mock('@/hooks/useDepegCheck', async () => {
  const m = await import('./lifecycle/test-stubs')
  return { useDepegCheck: () => m.OK_DEPEG }
})
vi.mock('../shell/toasts', async () => {
  const m = await import('./lifecycle/test-stubs')
  return { useV2Toast: () => m.TOAST_STUB }
})

import { SwapCard } from './SwapCard'
import { _resetApproxPrices } from '../fiat/approx-prices'
import { _resetEurRate } from '../fiat/eur-rate'
import { _resetFiatPreference, setFiatCurrency } from '../fiat/fiat-preference'

const type = (value: string) => fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value } })
const CONNECTED = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
const norm = (s: string | null | undefined) => (s ?? '').replace(/[   ]/g, ' ')
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
const fiat = (side: 'sell' | 'receive') => norm(document.querySelector(`[data-fiat="${side}"]`)?.textContent)

let calls: string[]
function stubRoutes(prices: Record<string, number>, eur: { rate: number; updatedAt: number; maxStaleness: number } | null) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      if (url.startsWith('/api/portfolio/prices')) {
        const asked = decodeURIComponent(new URL(url, 'http://x').searchParams.get('tokens') ?? '').split(',')
        return { ok: true, json: async () => ({ prices: Object.fromEntries(asked.filter((a) => prices[a]).map((a) => [a, prices[a]])) }) }
      }
      if (url.startsWith('/api/fiat/eur-usd')) return eur ? { ok: true, json: async () => eur } : { ok: false, status: 503, json: async () => ({}) }
      return { ok: true, json: async () => ({}) }
    }),
  )
}
const PRICES = { [NATIVE_ETH.toLowerCase()]: 2490, [USDC.address.toLowerCase()]: 1 }
const FRESH = () => ({ rate: 1.1, updatedAt: Math.floor(Date.now() / 1000) - 300, maxStaleness: 90000 })

beforeEach(() => {
  h.account = CONNECTED
  h.balance = undefined
  h.chainId = 1
  h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: vi.fn() }
  h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
  h.tier = { data: null, loading: false }
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    /* ignore */
  }
  _resetFiatPreference()
  _resetEurRate()
  _resetApproxPrices()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Sell and Receive fiat lines', () => {
  it('both lines show the approximate value of the amount; Receive uses the QUOTED amount', async () => {
    stubRoutes(PRICES, null)
    render(<SwapCard />)
    type('1')
    await flush()
    expect(fiat('sell')).toBe('≈ $2 490.00') // 1 ETH × 2490
    expect(fiat('receive')).toBe('≈ $2 487.68') // 2 487.6842 USDC (the quote's best) × 1
    expect(document.querySelector('[data-fiat="sell"]')?.className).toContain('text-v2-muted')
    expect(ETH.symbol).toBe('ETH')
  })

  it('one request serves Sell, Receive and the fee line: the Portfolio route only, never /api/rpc; the EUR route is not asked in dollars', async () => {
    stubRoutes(PRICES, FRESH())
    render(<SwapCard />)
    type('1')
    await flush()
    const prices = calls.filter((c) => c.startsWith('/api/portfolio/prices'))
    expect(prices).toHaveLength(1)
    expect(prices[0]).toContain('chainId=1')
    expect(calls.filter((c) => c.startsWith('/api/fiat/eur-usd'))).toHaveLength(0)
    expect(calls.some((c) => c.includes('/api/rpc'))).toBe(false)
  })

  it('NO PRICE: nothing on that line, no element, no $0, no dash', async () => {
    stubRoutes({}, null)
    render(<SwapCard />)
    type('1')
    await flush()
    expect(document.querySelector('[data-fiat]')).toBeNull()
    expect(norm(document.querySelector('[data-swap-card]')?.textContent)).not.toContain('≈')
  })

  it('only the priced side shows its line', async () => {
    stubRoutes({ [NATIVE_ETH.toLowerCase()]: 2490 }, null)
    render(<SwapCard />)
    type('1')
    await flush()
    expect(fiat('sell')).toBe('≈ $2 490.00')
    expect(document.querySelector('[data-fiat="receive"]')).toBeNull()
  })

  it('no amount: no line', async () => {
    stubRoutes(PRICES, null)
    render(<SwapCard />)
    await flush()
    expect(document.querySelector('[data-fiat]')).toBeNull()
  })

  it('EUROS: every line follows the switch (amounts, gas and fee) and the rate is the Chainlink one', async () => {
    stubRoutes(PRICES, FRESH())
    setFiatCurrency('EUR')
    render(<SwapCard />)
    type('1')
    await flush()
    expect(fiat('sell')).toBe('≈ €2 263.64') // 2490 / 1.1
    expect(fiat('receive')).toBe('≈ €2 261.53') // 2 487.6842 / 1.1
    const panel = norm(document.querySelector('[data-quote-panel]')?.textContent)
    expect(panel).toContain('~0.000012 ETH (€0.03)') // native amount first, fiat second, in euros
    expect(panel).toContain('0.001 ETH (€2.26)') // the fee: 2.49 / 1.1
    expect(panel).not.toContain('$0.03')
    expect(calls.filter((c) => c.startsWith('/api/fiat/eur-usd'))).toEqual(['/api/fiat/eur-usd?chainId=1'])
  })

  it('euros chosen but the rate is unavailable: dollars everywhere, never a stale or invented euro figure', async () => {
    stubRoutes(PRICES, null)
    setFiatCurrency('EUR')
    render(<SwapCard />)
    type('1')
    await flush()
    expect(fiat('sell')).toBe('≈ $2 490.00')
    const panel = norm(document.querySelector('[data-quote-panel]')?.textContent)
    expect(panel).toContain('~0.000012 ETH ($0.03)')
    expect(document.body.textContent).not.toContain('€')
  })
})

describe('the review sheet never carries a euro figure', () => {
  it('euros chosen: the panel reads €, the review sheet (built from the dollar view) reads $', async () => {
    stubRoutes(PRICES, FRESH())
    setFiatCurrency('EUR')
    render(<SwapCard />)
    type('1')
    await flush()
    expect(norm(document.querySelector('[data-quote-panel]')?.textContent)).toContain('~0.000012 ETH (€0.03)')
    fireEvent.click(document.querySelector('[data-cta]') as HTMLButtonElement)
    const dlg = screen.getByRole('dialog', { name: 'Review Transaction' })
    const sheet = norm(dlg.textContent)
    expect(sheet).toContain('~0.000012 ETH ($0.03)')
    expect(sheet).toContain('0.001 ETH ($2.49)')
    expect(sheet).not.toContain('€')
    expect(sheet).not.toContain('≈')
  })
})
