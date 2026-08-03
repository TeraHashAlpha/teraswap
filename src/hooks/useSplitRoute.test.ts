// @vitest-environment jsdom
/**
 * [P79/M-01 Phase 2] useSplitRoute — split-analysis gate + recommendation.
 *
 * The hook decides whether a trade is large enough to attempt a multi-
 * source split, fetches sub-amount quotes via /api/quote, and surfaces
 * `splitRecommended` + auto-enables `useSplit` when the improvement
 * crosses SPLIT_MIN_IMPROVEMENT_BPS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFetchSplitQuotes = vi.fn()
const mockFindBestSplit = vi.fn()

vi.mock('@/lib/split-router', () => ({
  fetchSplitQuotes: (...args: unknown[]) => mockFetchSplitQuotes(...args),
  findBestSplit: (...args: unknown[]) => mockFindBestSplit(...args),
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return actual
})

import { renderHook, act, waitFor } from '@testing-library/react'
import { useSplitRoute } from './useSplitRoute'
import type { Token } from '@/lib/tokens'
import type { MetaQuoteResult, NormalizedQuote } from '@/lib/api'
import type { SplitRoute } from '@/lib/split-routing-types'

const USDC: Token = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '',
  category: 'Stablecoin',
}

const ETH: Token = {
  address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native',
}

const FOO: Token = {
  address: '0x0000000000000000000000000000000000001234',
  symbol: 'FOO',
  name: 'Foo Token',
  decimals: 18,
  logoURI: '',
  category: 'Other',
}

function makeMeta(toAmount: string, source = '1inch'): MetaQuoteResult {
  const quote = {
    source,
    toAmount,
    estimatedGas: 200_000,
    gasUsd: 5,
    routes: [],
    tx: { to: '0x0', data: '0x', value: '0', gas: 200_000 },
  } as unknown as NormalizedQuote
  return {
    best: quote,
    all: [quote],
    fetchedAt: Date.now(),
  } as MetaQuoteResult
}

function makeBestSplit(isSplit: boolean, improvementBps = 0): SplitRoute {
  return {
    legs: [],
    totalOutput: '0',
    totalGasUsd: 0,
    isSplit,
    improvementBps,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchSplitQuotes.mockResolvedValue(new Map())
  mockFindBestSplit.mockReturnValue(makeBestSplit(false))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSplitRoute — disabled / below-threshold paths', () => {
  it('returns null result when enabled=false', async () => {
    const meta = makeMeta('10000000000') // 10k USDC out, but disabled.
    const { result } = renderHook(() =>
      useSplitRoute(meta, ETH, USDC, '5', false),
    )
    expect(result.current.splitResult).toBeNull()
    expect(result.current.analyzing).toBe(false)
    expect(mockFetchSplitQuotes).not.toHaveBeenCalled()
  })

  it('does not fetch split quotes when execution USD < SPLIT_MIN_USD (output is stable but tiny)', async () => {
    // 100 USDC out — well below the $5k threshold.
    const meta = makeMeta('100000000')
    renderHook(() => useSplitRoute(meta, ETH, USDC, '1', true))
    // Give effects a tick to run.
    await act(async () => { await Promise.resolve() })
    expect(mockFetchSplitQuotes).not.toHaveBeenCalled()
  })

  it('returns null result when meta is null', () => {
    const { result } = renderHook(() =>
      useSplitRoute(null, ETH, USDC, '5', true),
    )
    expect(result.current.splitResult).toBeNull()
  })

  it('returns null result when both tokens are non-stable (no USD estimate)', async () => {
    // Output token is FOO (non-stable), input is ETH (non-stable) →
    // executionPriceUsd is null → tradeAboveThreshold=false.
    const meta = makeMeta('10000000000000000000000') // 10k FOO out (huge but unstable)
    renderHook(() => useSplitRoute(meta, ETH, FOO, '5', true))
    await act(async () => { await Promise.resolve() })
    expect(mockFetchSplitQuotes).not.toHaveBeenCalled()
  })
})

describe('useSplitRoute — recommendation gating', () => {
  it('recommends a split when findBestSplit returns isSplit=true and improvement >= threshold', async () => {
    // 10k USDC out → above SPLIT_MIN_USD threshold.
    const meta = makeMeta('10000000000')
    mockFindBestSplit.mockReturnValue(makeBestSplit(true, 25)) // 25 bps > 10
    const { result } = renderHook(() =>
      useSplitRoute(meta, ETH, USDC, '5', true),
    )
    await waitFor(() => expect(result.current.splitRecommended).toBe(true))
    expect(result.current.useSplit).toBe(true) // auto-enabled
    expect(result.current.splitResult).not.toBeNull()
  })

  it('does NOT recommend split when improvementBps is below SPLIT_MIN_IMPROVEMENT_BPS', async () => {
    const meta = makeMeta('10000000000')
    mockFindBestSplit.mockReturnValue(makeBestSplit(true, 5)) // 5 bps < 10
    const { result } = renderHook(() =>
      useSplitRoute(meta, ETH, USDC, '5', true),
    )
    await waitFor(() => expect(result.current.splitResult).not.toBeNull())
    expect(result.current.splitRecommended).toBe(false)
    expect(result.current.useSplit).toBe(false)
  })

  it('does NOT recommend split when bestSplit.isSplit is false', async () => {
    const meta = makeMeta('10000000000')
    mockFindBestSplit.mockReturnValue(makeBestSplit(false, 50)) // not split
    const { result } = renderHook(() =>
      useSplitRoute(meta, ETH, USDC, '5', true),
    )
    await waitFor(() => expect(result.current.splitResult).not.toBeNull())
    expect(result.current.splitRecommended).toBe(false)
  })
})

describe('useSplitRoute — USD estimation paths', () => {
  it('uses output amount when output token is a stablecoin (USDC)', async () => {
    const meta = makeMeta('10000000000') // 10k USDC out
    mockFindBestSplit.mockReturnValue(makeBestSplit(true, 30))
    renderHook(() => useSplitRoute(meta, ETH, USDC, '5', true))
    await waitFor(() => expect(mockFetchSplitQuotes).toHaveBeenCalled())
  })

  it('uses input amount when input token is a stablecoin', async () => {
    // 10000 USDC in → estimated USD = 10000, above threshold.
    const meta = makeMeta('5000000000000000000') // arbitrary FOO out
    mockFindBestSplit.mockReturnValue(makeBestSplit(true, 30))
    renderHook(() => useSplitRoute(meta, USDC, FOO, '10000', true))
    await waitFor(() => expect(mockFetchSplitQuotes).toHaveBeenCalled())
  })
})

describe('useSplitRoute — toggleSplit', () => {
  it('flips the useSplit state when called', async () => {
    const meta = makeMeta('100000000') // small trade — won't auto-enable
    const { result } = renderHook(() =>
      useSplitRoute(meta, ETH, USDC, '0.1', true),
    )
    expect(result.current.useSplit).toBe(false)
    act(() => {
      result.current.toggleSplit()
    })
    expect(result.current.useSplit).toBe(true)
    act(() => {
      result.current.toggleSplit()
    })
    expect(result.current.useSplit).toBe(false)
  })
})

describe('useSplitRoute — robustness', () => {
  it('does not crash when amountIn is invalid (parseUnits throws)', async () => {
    const meta = makeMeta('10000000000')
    const { result } = renderHook(() =>
      useSplitRoute(meta, ETH, USDC, 'not-a-number', true),
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.splitResult).toBeNull()
    expect(mockFetchSplitQuotes).not.toHaveBeenCalled()
  })

  it('handles fetchSplitQuotes rejection without crashing (catches into null result)', async () => {
    const meta = makeMeta('10000000000')
    mockFetchSplitQuotes.mockRejectedValueOnce(new Error('network'))
    const { result } = renderHook(() =>
      useSplitRoute(meta, ETH, USDC, '5', true),
    )
    await waitFor(() => expect(result.current.analyzing).toBe(false))
    expect(result.current.splitResult).toBeNull()
  })

  it('stale request guard: only the latest amountIn triggers a fresh fetch', async () => {
    // Both fetches resolve immediately. We just verify that a rerender
    // with a different amountIn produces a fresh fetchSplitQuotes call —
    // the abortRef wiring is exercised indirectly (no crash, fresh state).
    mockFetchSplitQuotes.mockResolvedValue(new Map())
    mockFindBestSplit.mockReturnValue(makeBestSplit(false, 0))

    const meta = makeMeta('10000000000')
    const { rerender } = renderHook(
      ({ amount }: { amount: string }) =>
        useSplitRoute(meta, ETH, USDC, amount, true),
      { initialProps: { amount: '5' } },
    )
    await waitFor(() => expect(mockFetchSplitQuotes).toHaveBeenCalledTimes(1))
    rerender({ amount: '6' })
    await waitFor(() => expect(mockFetchSplitQuotes).toHaveBeenCalledTimes(2))
  })
})

// ─────────────────────────────────────────────────────────────
// [CHORE-SPLITROUTE-CHAINID] Sub-quote fetch URL — chain awareness.
//
// The hook builds `fetchQuoteAtAmount` and hands it to fetchSplitQuotes;
// the URL it constructs was NEVER asserted before, which is how the
// chainId omission survived (triage: PR #262 — Base sub-legs were priced
// on mainnet via /api/quote's P217 default, killing split routing on
// Base). These tests capture the REAL closure through the module mock
// and pin the request URL per chain:
//   - Base (8453): the request MUST carry chainId=8453.
//   - Mainnet: NO chainId param — P219 convention (mirrors useQuote's
//     fetchMetaQuoteViaApi): mainnet requests stay byte-identical to the
//     pre-multi-chain shape, and /api/quote's P217 default IS chain 1.
// ─────────────────────────────────────────────────────────────
describe('useSplitRoute — sub-quote fetch URL chain awareness [CHORE-SPLITROUTE-CHAINID]', () => {
  async function captureSubQuoteUrl(chainId?: number): Promise<URL> {
    const meta = makeMeta('10000000000') // 10k USDC out → above threshold
    mockFindBestSplit.mockReturnValue(makeBestSplit(false))
    renderHook(() =>
      chainId === undefined
        ? useSplitRoute(meta, ETH, USDC, '5', true)
        : useSplitRoute(meta, ETH, USDC, '5', true, chainId),
    )
    await waitFor(() => expect(mockFetchSplitQuotes).toHaveBeenCalled())
    // First arg of fetchSplitQuotes is the hook's REAL fetchQuoteAtAmount.
    const fetchQuoteAtAmount = mockFetchSplitQuotes.mock.calls[0][0] as (amount: string) => Promise<unknown>

    const seen: URL[] = []
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
      seen.push(new URL(String(args[0]), 'http://localhost'))
      return new Response(JSON.stringify({ best: null, all: [], fetchedAt: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    try {
      await fetchQuoteAtAmount('2500000000000000000')
    } finally {
      fetchSpy.mockRestore()
    }
    expect(seen.length).toBe(1)
    return seen[0]
  }

  it('carries chainId=8453 when the active chain is Base', async () => {
    const url = await captureSubQuoteUrl(8453)
    expect(url.pathname).toBe('/api/quote')
    expect(url.searchParams.get('chainId')).toBe('8453')
    expect(url.searchParams.get('src')).toBe(ETH.address)
    expect(url.searchParams.get('dst')).toBe(USDC.address)
    expect(url.searchParams.get('amount')).toBe('2500000000000000000')
  })

  it('mainnet request stays byte-identical: no chainId param (P219; the P217 default IS chain 1)', async () => {
    const url = await captureSubQuoteUrl(1)
    expect(url.searchParams.has('chainId')).toBe(false)
    expect(url.searchParams.get('srcDecimals')).toBe('18')
    expect(url.searchParams.get('dstDecimals')).toBe('6')
  })

  it('defaults to the mainnet shape when the chainId param is omitted (back-compat)', async () => {
    const url = await captureSubQuoteUrl(undefined)
    expect(url.searchParams.has('chainId')).toBe(false)
  })
})

// [CHORE-STABLECOIN-CONSTANT] The USD estimate that gates split analysis resolves stable
// membership through the chain-keyed constant — USDbC is ~$1 ON BASE (it never was in the
// old inline list), while BOLD is mainnet-only (the old chain-blind list applied it everywhere).
describe('chain-keyed stable membership for the USD estimate', () => {
  const USDbC: Token = {
    address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    symbol: 'USDbC',
    name: 'USD Base Coin',
    decimals: 6,
    logoURI: '',
    category: 'Stablecoin',
  }

  const BOLD: Token = {
    address: '0x6440f144b7e50D6a8439336510312d2F54beB01D',
    symbol: 'BOLD',
    name: 'Liquity BOLD',
    decimals: 18,
    logoURI: '',
    category: 'Stablecoin',
  }

  it('counts USDbC output as ~USD on Base (8453) → split analysis runs', async () => {
    const meta = makeMeta('10000000000') // 10k USDbC (6 dp) out — above the $5k threshold.
    renderHook(() => useSplitRoute(meta, ETH, USDbC, '5', true, 8453))
    await waitFor(() => expect(mockFetchSplitQuotes).toHaveBeenCalled())
  })

  it('does NOT count BOLD as ~USD on Base — BOLD is a mainnet-only stable', async () => {
    const meta = makeMeta('10000000000000000000000') // 10k BOLD (18 dp) out.
    renderHook(() => useSplitRoute(meta, ETH, BOLD, '5', true, 8453))
    await act(async () => { await Promise.resolve() })
    expect(mockFetchSplitQuotes).not.toHaveBeenCalled()
  })

  it('still counts BOLD as ~USD on mainnet (default chain)', async () => {
    const meta = makeMeta('10000000000000000000000') // 10k BOLD (18 dp) out.
    renderHook(() => useSplitRoute(meta, ETH, BOLD, '5', true))
    await waitFor(() => expect(mockFetchSplitQuotes).toHaveBeenCalled())
  })
})
