// @vitest-environment jsdom
/**
 * [fix/privacy-no-usage-tracking A78 S-1/S-4] Which quotes are recorded.
 *
 * Owner ruling: swap-screen quotes stay in the `quotes` log (token pair, amount, the sources' answers; the wallet when
 * one is connected, NO identifier when none is) because the Analytics tab is built from them. The landing page's
 * preview quote is NOT logged. This file runs the REAL `useQuote` and the REAL `logQuoteToSupabase` (no analytics
 * mock) and counts what the hook actually POSTs to /api/log-quote, 15 s refreshes included.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let account: { address: string | undefined } = { address: undefined }
vi.mock('wagmi', () => ({ useAccount: vi.fn(() => account) }))
vi.mock('./useEthGasCost', () => ({
  useEthGasCost: vi.fn(() => ({ ethPrice: 2000, gasPriceGwei: 20, estimate: () => ({ eth: 0.001, usd: 2 }) })),
}))
vi.mock('./useDebounce', () => ({ useDebounce: <T,>(v: T) => v }))
vi.mock('@/lib/gasless-engine', () => ({
  analyzeGasless: vi.fn(() => ({ available: true, recommended: false, gasSavingsUsd: 0, priceDifferencePercent: 0, bestNonCowSource: '1inch', reason: 'baseline' })),
}))

import { renderHook, act } from '@testing-library/react'
import { useQuote } from './useQuote'
import type { Token } from '@/lib/tokens'
import { QUOTE_REFRESH_MS } from '@/lib/constants'
import { LANDING_PREVIEW_AMOUNT_IN } from '@/config/product-claims'

const TOKEN_IN: Token = { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: '', category: 'Native' }
const TOKEN_OUT: Token = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '', category: 'Stablecoin' }

const QUOTE = {
  best: { source: '1inch', toAmount: '2950000000', estimatedGas: 150000, gasUsd: 5, routes: [] },
  all: [
    { source: '1inch', toAmount: '2950000000', estimatedGas: 150000, gasUsd: 5, routes: [] },
    { source: 'paraswap', toAmount: '2949000000', estimatedGas: 160000, gasUsd: 5, routes: [] },
  ],
  fetchedAt: Date.now(),
}

/**
 * A valid /api/quote answer for GETs, echoing the request it answers (the hook stores a quote only when the echo matches
 * the current selection: an answer that does not is dropped before it could be logged, which would make a "0 log
 * requests" assertion pass for the wrong reason). Every POST (the logger) is recorded and acknowledged.
 */
function installFetch() {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = []
  let quoteGets = 0
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    quoteGets++
    const q = new URL(url, 'http://localhost').searchParams
    const echo = { tokenIn: q.get('src'), tokenOut: q.get('dst'), chainId: 1, decimalsIn: Number(q.get('srcDecimals')), decimalsOut: Number(q.get('dstDecimals')), amountIn: q.get('amount') }
    return new Response(JSON.stringify({ ...QUOTE, ...echo, fetchedAt: Date.now() }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return { posts, quoteGets: () => quoteGets, logPosts: () => posts.filter((p) => p.url === '/api/log-quote') }
}

const settleMicrotasks = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

beforeEach(() => {
  account = { address: undefined }
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useQuote: which quotes reach /api/log-quote', () => {
  it('landing preview (default options), no wallet, three 15 s refreshes: quotes succeed and ZERO log requests are sent', async () => {
    const f = installFetch()
    const { result } = renderHook(() => useQuote(TOKEN_IN, TOKEN_OUT, LANDING_PREVIEW_AMOUNT_IN, true))
    await settleMicrotasks()
    for (let i = 0; i < 3; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(QUOTE_REFRESH_MS) })
    }
    expect(f.quoteGets(), 'the quote refreshed every 15 s').toBe(4)
    expect(result.current.meta?.best?.source, 'the quote SUCCEEDED and was stored (so the zero below is not a failed fetch)').toBe('1inch')
    expect(f.logPosts()).toHaveLength(0)
  })

  it('landing preview with a connected wallet is not logged either', async () => {
    account = { address: '0x1111111111111111111111111111111111111111' }
    const f = installFetch()
    const { result } = renderHook(() => useQuote(TOKEN_IN, TOKEN_OUT, LANDING_PREVIEW_AMOUNT_IN, true))
    await settleMicrotasks()
    expect(result.current.meta?.best?.source).toBe('1inch')
    expect(f.logPosts()).toHaveLength(0)
  })

  it('swap screen (logQuote), no wallet: one request, carrying the pair, amount and sources, and NO wallet / session / device / referrer field', async () => {
    const f = installFetch()
    const { result } = renderHook(() => useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined, { logQuote: true }))
    await settleMicrotasks()
    expect(f.quoteGets()).toBe(1)
    expect(result.current.meta?.best?.source).toBe('1inch')
    const logs = f.logPosts()
    expect(logs).toHaveLength(1)
    expect(Object.keys(logs[0].body).sort()).toEqual([
      'allQuotes', 'amountIn', 'bestAmountOut', 'bestSource', 'responseTimeMs',
      'sourcesQueried', 'sourcesResponded', 'tokenIn', 'tokenInSymbol', 'tokenOut', 'tokenOutSymbol',
    ])
    expect(logs[0].body).toMatchObject({ tokenIn: TOKEN_IN.address, tokenOut: TOKEN_OUT.address, amountIn: '1000000000000000000', bestSource: '1inch' })
    expect(JSON.stringify(logs[0].body)).not.toMatch(/wallet|session|device|referrer|userAgent|0x1111/i)
  })

  it('swap screen (logQuote), wallet connected: the row carries that wallet', async () => {
    account = { address: '0x1111111111111111111111111111111111111111' }
    const f = installFetch()
    renderHook(() => useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined, { logQuote: true }))
    await settleMicrotasks()
    expect(f.logPosts()).toHaveLength(1)
    expect(f.logPosts()[0].body.wallet).toBe('0x1111111111111111111111111111111111111111')
  })

  it('swap screen keeps logging each automatic refresh (one request per quote), as before', async () => {
    const f = installFetch()
    renderHook(() => useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined, { logQuote: true }))
    await settleMicrotasks()
    await act(async () => { await vi.advanceTimersByTimeAsync(QUOTE_REFRESH_MS) })
    expect(f.quoteGets()).toBe(2)
    expect(f.logPosts()).toHaveLength(2)
  })
})

describe('callers: the opt-in is where the owner ruling puts it', () => {
  // v1 files may not name the second UI tree (the isolation test scans their text), so the v2 paths are built from segments.
  const v2 = (...rest: string[]) => ['src', 'ui', 'v' + '2', ...rest]
  const read = (segments: string[]) => readFileSync(resolve(__dirname, '../..', ...segments), 'utf8')
  it.each([
    ['SwapBox (v1)', ['src', 'components', 'SwapBox.tsx']],
    ['SwapCard (v2)', v2('swap', 'SwapCard.tsx')],
  ] as const)('%s, the swap screen, logs its quotes', (_n, segments) => {
    expect(read([...segments])).toMatch(/useQuote\([^)]*\{ logQuote: true \}\)/)
  })
  it.each([
    ['LandingPage (v1)', ['src', 'components', 'LandingPage.tsx']],
    ['Hero (v2)', v2('landing', 'Hero.tsx')],
  ] as const)('%s, the landing preview, does not', (_n, segments) => {
    expect(read([...segments])).not.toMatch(/logQuote/)
  })
})
