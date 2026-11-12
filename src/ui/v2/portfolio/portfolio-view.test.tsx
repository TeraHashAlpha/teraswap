// @vitest-environment jsdom
/**
 * [fix/portfolio-tokens-view C2] Small balances and junk hidden by default, v1 == v2.
 * `usePortfolio()` is faked (one fake feeds v1's PortfolioTab and the v2 tab); wallet and chain are fakes. Fixture: a Base wallet flooded
 * with airdrop junk next to catalog tokens, including the owner's example, "✅Visit to claim: t.me/s/us_pool".
 */
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent, visibleTextNodes } from '../__tests__/content-parity'
import { fmtToken } from '@/lib/format'
import type { PortfolioData, PortfolioToken } from '@/hooks/usePortfolio'
import { getChainTokenList } from '@/lib/chains/tokens'
import {
  ALL_HIDDEN_NOTE, HIDE_SMALL_LABEL, PORTFOLIO_TRUNCATED_NOTE, THIRD_PARTY_NOTE, UNVERIFIED_TOKEN_NAME,
  isSmallBalance, looksLikeJunkMetadata, showAllLabel,
} from '@/lib/portfolio-view'

const h = vi.hoisted(() => ({ data: null as unknown as PortfolioData, push: vi.fn() }))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 8453 } }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false, isLoading: false }),
}))
vi.mock('@/hooks/useChainId', () => ({ useActiveChainId: () => 8453 }))
vi.mock('@/hooks/usePortfolio', () => ({ usePortfolio: () => h.data }))
vi.mock('@/hooks/useTokenImport', () => ({ useTokenImport: () => ({ importToken: vi.fn() }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))

import V1PortfolioTab from '@/components/PortfolioTab'
import { PortfolioTab as V2PortfolioTab } from './PortfolioTab'

const base = getChainTokenList(8453)
const bySymbol = (s: string) => base.find((t) => t.symbol === s)!
const eth = bySymbol('ETH')
const usdc = bySymbol('USDC')
const uni = bySymbol('UNI')
const weth = bySymbol('WETH')

const SHORT_JUNK = '0x00000000000000000000000000000000000a11ce'
const junkToken = (address: string, symbol: string, name: string): PortfolioToken['token'] => ({
  address: address as `0x${string}`, symbol, name, decimals: 18, logoURI: '/api/token-logo?chainId=8453&address=' + address, category: 'Other',
})
const row = (token: PortfolioToken['token'], valueUsd: number | null): PortfolioToken => ({
  token, balance: 10n ** 18n, balanceFormatted: fmtToken(10n ** 18n, token.decimals), priceUsd: valueUsd === null ? null : valueUsd, valueUsd,
})

const OWNER_JUNK = junkToken(SHORT_JUNK, 'CLAIM', '✅Visit to claim: t.me/s/us_pool')
const PLAIN = junkToken('0x00000000000000000000000000000000000b0b0b', 'PLN', 'Plain Coin')
const PLAIN_SMALL = junkToken('0x00000000000000000000000000000000000c0c0c', 'PEN', 'Penny Coin')
const PRICED_JUNK = junkToken('0x00000000000000000000000000000000000d0d0d', 'RWD', 'Reward at uniswap-rewards.xyz')

// ETH $2 000, UNI $78.60, PLAIN $1.00 (exactly), USDC $0.80, PEN $0.99, WETH unpriced, owner's junk unpriced, priced junk $5
const ROWS: PortfolioToken[] = [
  row(eth, 2000), row(usdc, 0.8), row(uni, 78.6), row(weth, null), row(PLAIN, 1), row(PLAIN_SMALL, 0.99), row(OWNER_JUNK, null), row(PRICED_JUNK, 5),
]
const SMALL = 4 // USDC $0.80, PEN $0.99, WETH (no price), owner's junk (no price)

const state = (over: Partial<PortfolioData> = {}): PortfolioData => ({
  tokens: ROWS, totalValueUsd: 2084.6, isLoading: false, isError: false, lastUpdated: new Date(), refresh: vi.fn(), isChainSupported: true, ...over,
})

beforeEach(() => { h.data = state() })
afterEach(() => cleanup())

function both() {
  const v1 = render(<V1PortfolioTab onSwapToken={() => h.push('/swap')} />).container as HTMLElement
  const v2 = render(<V2PortfolioTab />).container as HTMLElement
  return { v1, v2 }
}
const toggle = (root: HTMLElement) => within(root).getByRole('button', { name: /^(Show all tokens \(\d+ hidden\)|Hide small balances)$/ })
const swapLabels = (root: HTMLElement) => Array.from(root.querySelectorAll('button[aria-label^="Swap "], button[aria-label^="Add "]')).map((b) => b.getAttribute('aria-label')!)

describe('default view: only holdings worth $1.00 or more', () => {
  it('hides $0.80, $0.99 and unpriced tokens (native and catalog ones included); shows $1.00; names the count', () => {
    const { v1, v2 } = both()
    for (const root of [v1, v2]) {
      const labels = swapLabels(root).join('|')
      expect(labels).toContain('Swap ETH')
      expect(labels).toContain('Swap UNI')
      expect(labels).toContain('Add PLN to tokens') // exactly $1.00 is shown
      expect(labels).not.toContain('USDC') // $0.80, a catalog token
      expect(labels).not.toContain('PEN') // $0.99
      expect(labels).not.toContain('WETH') // catalog, no price
      expect(labels).not.toContain('0x0000…11ce') // the owner's unpriced junk row stays hidden
      expect(labels).toContain('Add Unverified token 0x0000…0d0d to tokens') // the $5 junk row is shown, but masked
      expect(toggle(root).textContent).toBe(showAllLabel(SMALL))
      expect(toggle(root).getAttribute('aria-expanded')).toBe('false')
    }
  })

  it('a native token is hidden too when it is worth under $1.00', () => {
    h.data = state({ tokens: [row(eth, 0.4), row(uni, 50)] })
    const { v1, v2 } = both()
    for (const root of [v1, v2]) {
      expect(swapLabels(root).join('|')).not.toContain('Swap ETH')
      expect(toggle(root).textContent).toBe(showAllLabel(1))
    }
  })

  it('the control reveals the rest in place and hides them again; closed on every page load', () => {
    const { v1, v2 } = both()
    for (const root of [v1, v2]) {
      fireEvent.click(toggle(root))
      expect(toggle(root).textContent).toBe(HIDE_SMALL_LABEL)
      expect(toggle(root).getAttribute('aria-expanded')).toBe('true')
      expect(swapLabels(root).join('|')).toContain('Swap USDC')
      expect(swapLabels(root).join('|')).toContain('Swap WETH')
      expect(swapLabels(root).length).toBe(ROWS.length)
      fireEvent.click(toggle(root))
      expect(toggle(root).textContent).toBe(showAllLabel(SMALL))
    }
    cleanup() // a new page load: a new mount, closed again
    const again = both()
    expect(toggle(again.v1).textContent).toBe(showAllLabel(SMALL))
    expect(toggle(again.v2).textContent).toBe(showAllLabel(SMALL))
  })

  it('no control when nothing is small', () => {
    h.data = state({ tokens: [row(eth, 2000), row(uni, 78.6)] })
    const { v1, v2 } = both()
    for (const root of [v1, v2]) expect(within(root).queryByRole('button', { name: /Show all tokens|Hide small balances/ })).toBeNull()
  })

  it('everything hidden: the page says so next to the control instead of looking empty', () => {
    h.data = state({ tokens: [row(usdc, 0.8), row(weth, null)], totalValueUsd: 0.8 })
    const { v1, v2 } = both()
    for (const root of [v1, v2]) {
      expect(within(root).getByText(ALL_HIDDEN_NOTE)).toBeTruthy()
      expect(toggle(root).textContent).toBe(showAllLabel(2))
      expect(root.querySelector('[data-testid="portfolio-empty"]')).toBeNull()
      fireEvent.click(toggle(root))
      expect(within(root).queryByText(ALL_HIDDEN_NOTE)).toBeNull()
    }
  })

  it('prices not landed yet: skeleton, no control, no false "nothing is worth $1.00"', () => {
    h.data = state({ isLoading: true, lastUpdated: null, tokens: [row(eth, null), row(uni, null)], totalValueUsd: null })
    const { v1, v2 } = both()
    for (const root of [v1, v2]) {
      expect(within(root).queryByText(ALL_HIDDEN_NOTE)).toBeNull()
      expect(within(root).queryByRole('button', { name: /Show all tokens/ })).toBeNull()
    }
    expect(v2.querySelector('[data-testid="portfolio-loading"]')).toBeTruthy()
  })

  it('the header total is the hook\'s, whatever is hidden', () => {
    const { v1, v2 } = both()
    expect(v2.querySelector('[data-testid="portfolio-total"]')!.textContent).toMatch(/2.?084\.60/)
    expect(visibleTextNodes(v1).some((t) => /2.?084\.60/.test(t))).toBe(true)
    fireEvent.click(toggle(v2))
    expect(v2.querySelector('[data-testid="portfolio-total"]')!.textContent).toMatch(/2.?084\.60/) // unchanged by the control
  })
})

describe('order: USD value, largest first; unpriced last, by name', () => {
  it('inside each section', () => {
    const ALPHA = junkToken('0x00000000000000000000000000000000000e0e0e', 'AAA', 'Alpha Coin')
    h.data = state({
      tokens: [row(PLAIN, 1), row(PRICED_JUNK, 5), row(PLAIN_SMALL, null), row(OWNER_JUNK, null), row(ALPHA, null), row(uni, 78.6), row(eth, 2000), row(weth, 30)],
    })
    const { v1, v2 } = both()
    fireEvent.click(toggle(v1)); fireEvent.click(toggle(v2))
    const names = (sel: string) => Array.from(v2.querySelectorAll(`${sel} [data-testid="holding-row"]`)).map((r) => r.querySelector('.font-semibold')!.textContent)
    expect(names('[data-category="Native"]')).toEqual(['ETH', 'WETH']) // $2 000 before $30
    expect(names('[data-category="DeFi"]')).toEqual(['UNI'])
    // Discovered: $5 (masked, so "Unverified token"), $1.00, then unpriced by displayed name: Alpha Coin, Penny Coin, "Unverified token"
    expect(names('[data-testid="holdings-discovered"]')).toEqual([UNVERIFIED_TOKEN_NAME, 'PLN', 'AAA', 'PEN', UNVERIFIED_TOKEN_NAME])
    expect(swapLabels(v1)).toEqual(swapLabels(v2)) // v1 renders the same rows in the same order
  })

  it('v1 and v2 render rows in the same order', () => {
    const { v1, v2 } = both()
    fireEvent.click(toggle(v1)); fireEvent.click(toggle(v2))
    expect(swapLabels(v2)).toEqual(swapLabels(v1))
  })
})

describe('junk metadata is never rendered', () => {
  it.each(['closed', 'open'])('%s: no "t.me", "claim", "visit", emoji or link anywhere in v1 or v2 (text and attributes)', (mode) => {
    const { v1, v2 } = both()
    if (mode === 'open') { fireEvent.click(toggle(v1)); fireEvent.click(toggle(v2)) }
    for (const root of [v1, v2]) {
      const html = root.innerHTML.toLowerCase()
      expect(html).not.toContain('t.me')
      expect(html).not.toContain('claim')
      expect(html).not.toContain('visit')
      expect(html).not.toContain('uniswap-rewards')
      expect(html).not.toMatch(/\p{Extended_Pictographic}/u)
      expect(root.querySelectorAll('a').length).toBe(0)
      expect(html).not.toContain('href')
    }
  })

  it('a masked row reads "Unverified token" plus its short address, with the third-party line, no logo, and its action still works', () => {
    const { v1, v2 } = both()
    for (const root of [v1, v2]) {
      fireEvent.click(toggle(root))
      const add = within(root).getByLabelText('Add Unverified token 0x0000…11ce to tokens')
      const rowEl = add.closest('[data-testid="holding-row"], div.rounded-xl')!
      expect(rowEl.textContent).toContain(UNVERIFIED_TOKEN_NAME)
      expect(rowEl.textContent).toContain('0x0000…11ce')
      expect(rowEl.textContent).toContain(THIRD_PARTY_NOTE)
      expect(rowEl.querySelector('img')).toBeNull()
    }
  })

  it('catalog rows carry no third-party line and are never masked; every non-catalog row carries it', () => {
    const { v1, v2 } = both()
    for (const root of [v1, v2]) {
      fireEvent.click(toggle(root))
      const text = (l: string) => within(root).getByLabelText(l).closest('[data-testid="holding-row"], div.rounded-xl')!.textContent!
      expect(text('Swap UNI')).not.toContain(THIRD_PARTY_NOTE)
      expect(text('Swap USDC')).not.toContain(THIRD_PARTY_NOTE)
      expect(text('Add PLN to tokens')).toContain(THIRD_PARTY_NOTE)
      expect(text('Add PLN to tokens')).toContain('Plain Coin') // plain names are shown
      expect(root.textContent!.split(THIRD_PARTY_NOTE).length - 1).toBe(4) // PLN, PEN, owner junk, priced junk
    }
  })

  it('looksLikeJunkMetadata: the owner\'s example and the usual advert shapes; plain names pass', () => {
    const junk: Array<[string, string]> = [
      ['✅Visit to claim: t.me/s/us_pool', 'CLAIM'], ['Reward', 'https://x.io'], ['Reward', 'www.free.com'], ['Join', 't.me/pool'],
      ['Bot', '@airdrop_bot'], ['Discord reward', 'DISC'], ['Join discord.gg/abc', 'D'], ['AIRDROP token', 'AD'], ['Get VISIT now', 'V'],
      ['🎁 Gift', 'GFT'], ['claim-uni.xyz', 'UNI'], ['Normal', 'a​b'], ['Reclaim', 'RCL'],
    ]
    for (const [name, symbol] of junk) expect(looksLikeJunkMetadata(name, symbol), `${name} / ${symbol}`).toBe(true)
    for (const [name, symbol] of [['Uniswap', 'UNI'], ['USD Coin', 'USDC'], ['Wrapped BTC', 'WBTC'], ['Plain Coin', 'PLN'], ['Bridged USDC', 'USDC.e']]) {
      expect(looksLikeJunkMetadata(name, symbol), `${name} / ${symbol}`).toBe(false)
    }
  })
})

describe('v1 == v2', () => {
  it.each(['closed', 'open', 'all hidden', 'truncated'])('same visible text in the same order: %s', (mode) => {
    if (mode === 'all hidden') h.data = state({ tokens: [row(usdc, 0.8), row(OWNER_JUNK, null)], totalValueUsd: 0.8 })
    if (mode === 'truncated') h.data = state({ truncated: true })
    const { v1, v2 } = both()
    if (mode === 'open') { fireEvent.click(toggle(v1)); fireEvent.click(toggle(v2)) }
    expect(compareContent(v1, v2).missingText).toEqual([])
    expect(visibleTextNodes(v2)).toEqual(visibleTextNodes(v1))
    if (mode === 'truncated') expect(within(v2).getByText(PORTFOLIO_TRUNCATED_NOTE)).toBeTruthy()
  })
})

describe('copy', () => {
  it('no U+2014 in any new string', () => {
    for (const s of [ALL_HIDDEN_NOTE, HIDE_SMALL_LABEL, showAllLabel(3), THIRD_PARTY_NOTE, UNVERIFIED_TOKEN_NAME, PORTFOLIO_TRUNCATED_NOTE]) {
      expect(s.includes(String.fromCharCode(0x2014))).toBe(false)
    }
    expect(ALL_HIDDEN_NOTE).toBe('No token in this wallet is worth $1.00 or more.')
  })

  it('isSmallBalance: below $1.00, unpriced and NaN are small; $1.00 is not', () => {
    expect([0.8, 0.99, null, NaN, 0].map(isSmallBalance)).toEqual([true, true, true, true, true])
    expect([1, 1.01, 2000].map(isSmallBalance)).toEqual([false, false, false])
  })
})
