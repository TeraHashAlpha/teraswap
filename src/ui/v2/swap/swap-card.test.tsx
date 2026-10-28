// @vitest-environment jsdom
/**
 * [ADR-025] The Swap card, state by state (round7 21a idle · 21b quoting · 20 quote). v1's hooks are mocked at the module
 * edge — the card is the unit under test, so what is asserted is what it renders for a given hook answer.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ETH, USDC, NO_ORACLE, fixtureMeta, taggedFixture } from './test-fixtures'

const h = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false, chain: undefined as { id: number } | undefined },
  balance: undefined as { value: bigint; decimals: number } | undefined,
  chainId: 1,
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: vi.fn() },
  oracle: { chainlinkPrice: 2490 as number | null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false } as Record<string, unknown>,
  approval: { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 } as unknown, status: 'ready', error: null, approve: async () => {}, isReady: true } as Record<string, unknown>,
  tier: { data: null as unknown, loading: false },
  useQuoteArgs: [] as unknown[],
}))

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: h.balance }),
}))
vi.mock('@/hooks/useQuote', () => ({
  useQuote: (...args: unknown[]) => {
    h.useQuoteArgs = args
    return h.quote
  },
}))
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

const THIN = ' '
const type = (value: string) => fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value } })

beforeEach(() => {
  h.account = { address: undefined, isConnected: false, chain: undefined }
  h.balance = undefined
  h.chainId = 1
  h.quote = { meta: null, loading: false, error: null, countdown: 12, refresh: vi.fn() }
  h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
  h.tier = { data: null, loading: false }
  h.approval = { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 }, status: 'ready', error: null, approve: async () => {}, isReady: true }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    /* ignore */
  }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('21a — idle', () => {
  it('chain label, SELL / RECEIVE, token buttons, the one cream CTA says Connect wallet', () => {
    render(<SwapCard />)
    expect(screen.getByText('Ethereum')).toBeTruthy()
    expect(screen.getByText('Sell')).toBeTruthy()
    expect(screen.getByText('Receive')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Sell token: ETH/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Receive token: USDC/ })).toBeTruthy()
    const cta = document.querySelector('[data-cta]') as HTMLButtonElement
    expect(cta.textContent).toBe('Connect wallet')
    expect(cta.disabled).toBe(false)
    expect(document.querySelectorAll('[data-variant="primary"]').length).toBe(1) // ONE solid cream square CTA
  })

  it('no quote panel, no boxes: the right column is skeleton rows only', () => {
    render(<SwapCard />)
    expect(document.querySelector('[data-quote-panel]')).toBeNull()
    expect(document.querySelector('[data-skeleton="idle"]')).not.toBeNull()
    expect(document.querySelector('[data-swap-card]')?.getAttribute('data-quoting')).toBeNull()
  })

  it('balance is — and the native asset is named; quoting is enabled before a wallet (feat/quote-before-wallet)', () => {
    render(<SwapCard />)
    expect(screen.getByText('Balance: —')).toBeTruthy()
    expect(screen.getByText('Native asset')).toBeTruthy()
    expect(h.useQuoteArgs[3]).toBe(true) // isChainOkForQuote: disconnected → true
  })

  it('50% / MAX only exist once a balance does; they fill the field', () => {
    const { rerender } = render(<SwapCard />)
    expect(screen.queryByRole('button', { name: '50%' })).toBeNull()
    h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
    h.balance = { value: 3_000_000_000_000_000_000n, decimals: 18 }
    rerender(<SwapCard />)
    expect(screen.getByText(`Balance: 3.0000 ETH`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '50%' }))
    expect((screen.getByLabelText('Sell amount') as HTMLInputElement).value).toBe('1.5')
    fireEvent.click(screen.getByRole('button', { name: 'MAX' }))
    expect((screen.getByLabelText('Sell amount') as HTMLInputElement).value).toBe('3')
  })

  it('the amount input groups with a thin space (README §3) and rejects non-numbers', () => {
    render(<SwapCard />)
    type('1234567.5')
    expect((screen.getByLabelText('Sell amount') as HTMLInputElement).value).toBe(`1${THIN}234${THIN}567.5`)
    type('12abc')
    expect((screen.getByLabelText('Sell amount') as HTMLInputElement).value).toBe(`1${THIN}234${THIN}567.5`) // unchanged
  })

  it('⇅ swaps the pair and clears the amount', () => {
    render(<SwapCard />)
    type('1')
    fireEvent.click(screen.getByRole('button', { name: 'Swap sell and receive tokens' }))
    expect(screen.getByRole('button', { name: /Sell token: USDC/ })).toBeTruthy()
    expect((screen.getByLabelText('Sell amount') as HTMLInputElement).value).toBe('')
  })
})

describe('21b — quoting', () => {
  it('skeleton in the output and in the right column; the CTA is disabled and says so', () => {
    h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
    h.quote = { ...h.quote, loading: true }
    render(<SwapCard />)
    type('1')
    expect(document.querySelector('[data-quoting]')).not.toBeNull()
    expect(document.querySelector('[data-receive] .ts-v2-skeleton')).not.toBeNull()
    expect(document.querySelector('[data-skeleton="quoting"]')).not.toBeNull()
    expect(document.querySelector('[data-quote-panel]')).toBeNull()
    const cta = document.querySelector('[data-cta]') as HTMLButtonElement
    expect(cta.textContent).toBe('Finding best route...')
    expect(cta.disabled).toBe(true)
  })
})

describe('20 — quote', () => {
  function withQuote(amount = '1') {
    h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), amount) }
    render(<SwapCard />)
    type(amount)
  }

  it('Best via X, the rows, Min. output, +Δ vs second best', () => {
    withQuote()
    const panel = document.querySelector('[data-quote-panel]') as HTMLElement
    const text = panel.textContent ?? ''
    expect(text).toContain('Best via Velora')
    expect(text).toContain(`1 ETH = 2${THIN}487.6842 USDC`)
    expect(text).toContain('Dexalot + PancakeSwap V3 + Dexalot')
    expect(text).toContain('Max slippage')
    expect(text).toContain('0.3%')
    expect(text).toContain('Est. gas')
    expect(text).toContain('$0.03 (~0.000012 ETH)')
    expect(text).toContain('Platform fee (0.1%)')
    expect(text).toContain('0.001 ETH ($2.49)')
    expect(text).toContain('No approval needed')
    expect(text).toContain('Min. output')
    expect(text).toContain(`2${THIN}480.2211 USDC`)
    expect(text).toContain('+0.6547 USDC vs KyberSwap')
    expect(panel.querySelector('.ts-swap-route')?.textContent).not.toMatch(/0x[0-9a-f]{4}/i) // Route: names, never addresses
    expect(document.querySelector('[data-quoting]')).toBeNull()
  })

  it('RECEIVE shows ~ the output (DigitRoller, as v1), the CTA is Review swap and enabled', () => {
    withQuote()
    expect(document.querySelector('[data-receive] [role="text"]')?.getAttribute('aria-label')).toBe(`~2${THIN}487.6842`)
    const cta = document.querySelector('[data-cta]') as HTMLButtonElement
    expect(cta.textContent).toBe('Review swap')
    expect(cta.disabled).toBe(false)
  })

  it('"N sources enabled" + "M sources queried" come from the same data as v1', () => {
    withQuote()
    expect(screen.getByText(/^\d+ sources enabled$/)).toBeTruthy()
    expect(screen.getByText('5 sources queried')).toBeTruthy()
  })

  it('excluding a source updates the count and is passed to useQuote', () => {
    withQuote()
    fireEvent.click(screen.getByText(/sources enabled$/))
    fireEvent.click(screen.getByRole('checkbox', { name: /Velora/ }))
    expect(screen.getByText(/^\d+ of \d+ sources enabled$/)).toBeTruthy()
    expect(h.useQuoteArgs[4]).toEqual(['velora'])
  })

  it('Compare (5 sources): a disclosure with per-source rows under one hairline, "Quote only" on a source that cannot settle here', () => {
    withQuote()
    const btn = screen.getByRole('button', { name: /Compare \(5 sources\)/ })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const list = document.getElementById(btn.getAttribute('aria-controls') as string) as HTMLElement
    expect(list.querySelectorAll('li').length).toBe(5)
    expect(list.classList.contains('ts-rule-l')).toBe(true)
    const sushi = within(list).getByText('SushiSwap').closest('li') as HTMLElement
    expect(sushi.textContent).toContain('Quote only')
    expect(within(list).getByText('Uniswap V3').closest('li')?.textContent).toContain('Direct')
    expect(list.querySelector('[data-best]')?.textContent).toContain('Velora')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(list.hidden).toBe(true)
  })

  it('Rate ⇄ flips the direction and remembers it for the session (v1 key)', () => {
    withQuote()
    fireEvent.click(screen.getByRole('button', { name: 'Flip rate direction' }))
    expect(screen.getByRole('button', { name: 'Flip rate direction' }).textContent).toContain('1 USDC = 0.000402 ETH')
    expect(sessionStorage.getItem('teraswap:rateInverted')).toBe('1')
  })

  it('Max slippage ✎ opens the slippage sheet (B4); a preset changes the row and the Min. output, Esc restores focus', () => {
    withQuote()
    const edit = document.querySelector('[data-edit-slippage]') as HTMLButtonElement
    expect(edit.textContent).toContain('0.3%')
    const minBefore = document.body.textContent
    edit.focus()
    fireEvent.click(edit)
    expect(screen.getByRole('dialog', { name: 'Max slippage' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1%' }))
    expect(screen.queryByRole('dialog')).toBeNull() // v1: a choice closes the modal
    expect((document.querySelector('[data-edit-slippage]') as HTMLElement).textContent).toContain('1%')
    expect(document.body.textContent).not.toBe(minBefore) // Min. output follows the value
    fireEvent.click(document.querySelector('[data-edit-slippage]') as HTMLElement)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a token button opens the token sheet (B4); choosing a token swaps that side and the sheet hides the other side', () => {
    withQuote()
    fireEvent.click(screen.getByRole('button', { name: /Receive token: USDC/ }))
    expect(screen.getByRole('dialog', { name: 'Select token' })).toBeTruthy()
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-token-row]'))
    const sym = (r: HTMLElement) => r.querySelector('.ts-token-sym')?.textContent
    expect(rows.some((r) => sym(r) === 'ETH')).toBe(false) // the sell side's token is hidden
    fireEvent.click(rows.find((r) => sym(r) === 'USDT')!)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /Receive token: USDT/ })).toBeTruthy()
  })

  it('MEV: the row is a switch; v1\'s exposure hint offers Enable, which flips it', () => {
    withQuote()
    expect(screen.getByText('CoW Protocol available for MEV protection.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    expect(screen.getByRole('switch', { name: /Force MEV Protection/ }).getAttribute('aria-checked')).toBe('true')
  })
})

const CONNECTED = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
const TIER = {
  priced: { tier: 'priced', legs: { in: { tier: 'priced', sources: ['chainlink', 'defillama'], usd: 2490 }, out: { tier: 'priced', sources: ['chainlink', 'defillama'], usd: 1 } } },
  single: { tier: 'single-source', legs: { in: { tier: 'single-source', sources: ['defillama'], usd: 2490 }, out: { tier: 'single-source', sources: ['defillama'], usd: 1 } } },
  unpriced: { tier: 'unpriced', legs: { in: { tier: 'unpriced', sources: [] }, out: { tier: 'unpriced', sources: [] } } },
}

describe('24 — tier notices (the quote panel, as v1 QuoteBreakdown)', () => {
  function quoteWithTier(data: unknown) {
    h.account = CONNECTED
    h.tier = { data, loading: false }
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1') }
    render(<SwapCard />)
    type('1')
  }
  it('priced → nothing; unknown → nothing', () => {
    quoteWithTier(TIER.priced)
    expect(document.querySelector('[data-testid^="price-tier"]')).toBeNull()
    cleanup()
    quoteWithTier(null)
    expect(document.querySelector('[data-testid^="price-tier"]')).toBeNull()
  })
  it('single-source → the verbatim amber notice', () => {
    quoteWithTier(TIER.single)
    expect(document.querySelector('[data-testid="price-tier-single-source"]')?.textContent).toBe(
      '⚠ Price from one source only (DefiLlama). Value-based limits use that price; double-check the rate before swapping.',
    )
  })
  it('unpriced → the one-line notice, and the CTA still reads Review swap (its click opens the consent in the review sheet — see 26)', () => {
    quoteWithTier(TIER.unpriced)
    expect(document.querySelector('[data-testid="price-tier-unpriced"]')?.textContent).toBe('No reference price — consent required before swapping')
    expect((document.querySelector('[data-cta]') as HTMLElement).textContent).toBe('Review swap')
  })
  it('no notice without a quote: the panel owns it, as in v1', () => {
    h.account = CONNECTED
    h.tier = { data: TIER.single, loading: false }
    render(<SwapCard />)
    type('1')
    expect(document.querySelector('[data-testid="price-tier-single-source"]')).toBeNull()
  })
})

describe('CTA states in the card (21a / 20 / 29)', () => {
  const cta = () => document.querySelector('[data-cta]') as HTMLElement
  it('connected, no amount → Enter amount (disabled)', () => {
    h.account = CONNECTED
    render(<SwapCard />)
    expect(cta().textContent).toBe('Enter amount')
    expect((cta() as HTMLButtonElement).disabled).toBe(true)
  })
  it('amount above the balance → Insufficient balance (disabled), even with a quote', () => {
    h.account = CONNECTED
    h.balance = { value: 1_000_000_000_000_000n, decimals: 18 } // 0.001 ETH
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1') }
    render(<SwapCard />)
    type('1')
    expect(cta().textContent).toBe('Insufficient balance')
    expect((cta() as HTMLButtonElement).disabled).toBe(true)
    type('0.0005')
    expect(cta().textContent).not.toBe('Insufficient balance')
  })
  it('a malformed amount is insufficient, never a crash', () => {
    h.account = CONNECTED
    h.balance = { value: 10n ** 18n, decimals: 18 }
    render(<SwapCard />)
    expect(() => fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1.' } })).not.toThrow()
  })
  it('wrong network (29): a text button "Switch to Ethereum", not the solid CTA; nothing is quoted', () => {
    h.account = { address: CONNECTED.address, isConnected: true, chain: { id: 137 } }
    render(<SwapCard />)
    type('1')
    expect(cta().textContent).toBe('Switch to Ethereum')
    expect(cta().getAttribute('data-variant')).toBe('text')
    expect(document.querySelectorAll('[data-variant="primary"]').length).toBe(0)
    expect(h.useQuoteArgs[3]).toBe(false) // isChainOkForQuote: connected on an unsupported chain
  })
  it('review (20): the one solid cream CTA, enabled', () => {
    h.account = CONNECTED
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1') }
    render(<SwapCard />)
    type('1')
    expect(cta().textContent).toBe('Review swap')
    expect(cta().getAttribute('data-variant')).toBe('primary')
    expect(document.querySelectorAll('[data-variant="primary"]').length).toBe(1)
  })
})

describe('#604 — a stale quote never feeds the display', () => {
  it('a quote for the OTHER pair is treated as no quote', () => {
    h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1', 1, USDC, ETH) } // identity says USDC → ETH
    render(<SwapCard />)
    type('1')
    expect(document.querySelector('[data-quote-panel]')).toBeNull()
    expect((document.querySelector('[data-cta]') as HTMLElement).textContent).toBe('No quotes available')
  })

  it('a quote for ANOTHER AMOUNT is "quoting": skeleton, CTA disabled — receive/rate/min never describe a different sell amount', () => {
    h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1') }
    render(<SwapCard />)
    type('2') // the field says 2, the quote answered 1
    expect(document.querySelector('[data-quote-panel]')).toBeNull()
    expect(document.querySelector('[data-quoting]')).not.toBeNull()
    const cta = document.querySelector('[data-cta]') as HTMLButtonElement
    expect(cta.textContent).toBe('Finding best route...')
    expect(cta.disabled).toBe(true)
    type('1') // back to the amount the quote answered → it is shown again
    expect(document.querySelector('[data-quote-panel]')).not.toBeNull()
  })

  it('a ⇅ flip drops the quote at once (identity no longer matches)', () => {
    h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1') }
    render(<SwapCard />)
    type('1')
    expect(document.querySelector('[data-quote-panel]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Swap sell and receive tokens' }))
    expect(document.querySelector('[data-quote-panel]')).toBeNull()
  })
})

describe('tokens used in the fixtures resolve', () => {
  it('ETH is native and USDC is not', () => {
    expect(ETH.symbol).toBe('ETH')
    expect(USDC.symbol).toBe('USDC')
  })
})

describe('26 / 25 — the review and Permit2 sheets opened from the card (B4 sheets; Confirm is B5)', () => {
  const quote = (tier: unknown = null) => {
    h.account = CONNECTED
    h.tier = { data: tier, loading: false }
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1') }
    render(<SwapCard />)
    type('1')
  }
  const cta = () => document.querySelector('[data-cta]') as HTMLButtonElement

  it('Review swap opens the review sheet with the card\'s own numbers; Cancel closes it and returns focus to the CTA', () => {
    quote()
    expect(cta().hasAttribute('data-b5-stub')).toBe(false) // the click does something now (it opens a display-only sheet)
    cta().focus()
    fireEvent.click(cta())
    const dlg = screen.getByRole('dialog', { name: 'Review Transaction' })
    const panel = document.querySelector('[data-quote-panel]')!.textContent!.replace(/[\u00a0\u2009\u202f]/g, ' ')
    const sheet = dlg.textContent!.replace(/[\u00a0\u2009\u202f]/g, ' ')
    for (const s of ['2 480.2211 USDC', '0.001 ETH ($2.49)', '$0.03 (~0.000012 ETH)', '0.3%']) {
      expect(panel).toContain(s)
      expect(sheet).toContain(s)
    }
    expect(within(dlg).getByRole('button', { name: 'Confirm & Sign' }).hasAttribute('data-b5-stub')).toBe(false) // Confirm is wired (lifecycle tests)
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(cta())
  })

  it('the sheet follows a changed slippage', () => {
    quote()
    fireEvent.click(document.querySelector('[data-edit-slippage]') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: '1%' }))
    fireEvent.click(cta())
    expect(screen.getByTestId('review-slippage').textContent).toContain('1%')
  })

  it('unpriced tier: the consent sits in the sheet and gates Confirm; single-source shows the amber line only', () => {
    quote(TIER.unpriced)
    fireEvent.click(cta())
    expect((screen.getByRole('button', { name: 'Confirm & Sign' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('unpriced-consent-body').textContent).toContain('5 sources quoted within 0.27% of each other')
    fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
    expect((screen.getByRole('button', { name: 'Confirm & Sign' }) as HTMLButtonElement).disabled).toBe(false)
    cleanup()
    quote(TIER.single)
    fireEvent.click(cta())
    expect(within(screen.getByRole('dialog')).getByTestId('price-tier-single-source')).toBeTruthy()
    expect(screen.queryByTestId('unpriced-consent')).toBeNull()
  })

  it('no sheet opens for a state that has no review: Enter amount / Connect wallet', () => {
    render(<SwapCard />)
    fireEvent.click(cta())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('useApproval says Permit2 education is needed → the Permit2 sheet; Continue / Cancel are useApproval\'s own callbacks', () => {
    const confirm = vi.fn()
    const cancel = vi.fn()
    h.approval = { ...h.approval, needsPermit2Education: true, confirmPermit2Education: confirm, cancelPermit2Education: cancel }
    quote()
    const dlg = screen.getByRole('dialog', { name: 'About to sign a Permit2 approval' })
    expect(within(dlg).getByText('1 ETH')).toBeTruthy()
    fireEvent.click(within(dlg).getByRole('button', { name: 'Continue to signature' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
