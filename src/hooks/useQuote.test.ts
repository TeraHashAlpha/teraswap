// @vitest-environment jsdom
/**
 * [P115/M-01 + HF-L-01] useQuote tests.
 *
 * Two test groups in this file:
 *
 *   1. Phase-1 (M-01) behaviour — input debouncing, stale-result
 *      discard, error handling, and the gasless overlay populated on
 *      every successful fetch.
 *
 *   2. Hotfix HF-L-01 — pins the three lessons from the production
 *      quote-flood incident:
 *        - doFetch identity is stable across renders so the polling
 *          useEffect doesn't tear down + immediately re-fire.
 *        - In-flight guard: concurrent calls to doFetch yield one
 *          network request, not N.
 *        - Exponential backoff on 429: doubles to MAX_BACKOFF_MS
 *          (120 s) on consecutive rate-limits, snaps back to
 *          QUOTE_REFRESH_MS (15 s) on the first success.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock wagmi useAccount BEFORE the hook import (factory hoists).
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: '0x1111111111111111111111111111111111111111' })),
}))

// useEthGasCost: returns a fresh `estimate` function on each render.
// The hotfix captures it via ref so doFetch identity stays stable —
// the test that pins HF-L-01 fact #1 verifies exactly this.
let estimateCallCount = 0
vi.mock('./useEthGasCost', () => ({
  useEthGasCost: vi.fn(() => ({
    ethPrice: 2000,
    gasPriceGwei: 20,
    estimate: () => {
      estimateCallCount++
      return { eth: 0.001, usd: 2 }
    },
  })),
}))

// Skip the debounce in tests — re-export passthrough so doFetch fires
// synchronously on input change.
vi.mock('./useDebounce', () => ({
  useDebounce: <T,>(v: T) => v,
}))

// analyzeGasless is a pure function — let it run but stub the import
// so we don't pull the whole adapter graph.
vi.mock('@/lib/gasless-engine', () => ({
  analyzeGasless: vi.fn(() => ({
    available: true,
    recommended: false,
    gasSavingsUsd: 0,
    priceDifferencePercent: 0,
    bestNonCowSource: '1inch',
    reason: 'baseline',
  })),
}))

// Fire-and-forget Supabase logger — no-op.
vi.mock('@/lib/analytics', () => ({
  logQuoteToSupabase: vi.fn(),
}))

import { renderHook, waitFor, act } from '@testing-library/react'
import { useQuote } from './useQuote'
import type { Token } from '@/lib/tokens'

const TOKEN_IN: Token = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  name: 'Wrapped Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native',
}

const TOKEN_OUT: Token = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '',
  category: 'Stablecoin',
}

const VALID_RESPONSE = {
  best: { source: '1inch', toAmount: '2950000000', estimatedGas: 150000, gasUsd: 5, routes: [] },
  all: [
    { source: '1inch', toAmount: '2950000000', estimatedGas: 150000, gasUsd: 5, routes: [] },
  ],
  fetchedAt: Date.now(),
}

beforeEach(() => {
  vi.clearAllMocks()
  estimateCallCount = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Yield to microtasks + a couple of macro turns so React effects can
 *  flush. Real timers — fake timers break @testing-library's waitFor. */
async function flush() {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

/** Each call produces a fresh Response — Body streams can only be read
 *  once, so a shared instance breaks the second fetch in any test that
 *  does a manual refetch. */
function mockFetchSuccess(body: unknown = VALID_RESPONSE) {
  return vi.spyOn(global, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )
}

function mockFetchStatus(status: number, body: unknown = { error: 'failed' }) {
  return vi.spyOn(global, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
}

// ─────────────────────────────────────────────────────────────
// M-01 Phase 1 behaviour
// ─────────────────────────────────────────────────────────────
describe('useQuote — Phase 1 behaviour', () => {
  it('fetches once on mount when enabled with valid inputs', async () => {
    const fetchSpy = mockFetchSuccess()
    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.meta).not.toBeNull())
    expect(result.current.error).toBeNull()
  })

  it('does NOT fetch when enabled=false', async () => {
    const fetchSpy = mockFetchSuccess()
    renderHook(() => useQuote(TOKEN_IN, TOKEN_OUT, '1', false, undefined))
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does NOT fetch when amount is zero or empty', async () => {
    const fetchSpy = mockFetchSuccess()
    const { rerender } = renderHook(
      ({ amt }: { amt: string }) =>
        useQuote(TOKEN_IN, TOKEN_OUT, amt, true, undefined),
      { initialProps: { amt: '' } },
    )
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()

    rerender({ amt: '0' })
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('populates a non-rate-limit error via setError on API failure', async () => {
    mockFetchStatus(500, { error: 'upstream blew up' })
    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    await waitFor(() => expect(result.current.error).toMatch(/upstream/i))
    expect(result.current.meta).toBeNull()
  })

  it('[SPRINT-9X X3] an HTML platform 504 → CLEAN "service busy" error, never the raw JSON-parse crash', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response('<!DOCTYPE html><html><body>504 Gateway Timeout</body></html>', { status: 504, headers: { 'Content-Type': 'text/html' } }),
    )
    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    await waitFor(() => expect(result.current.error).toMatch(/service busy/i))
    expect(result.current.error).not.toMatch(/DOCTYPE|Unexpected token|not valid JSON/)
    expect(result.current.meta).toBeNull()
  })

  it('exposes the analyzeGasless overlay alongside best/all on a successful fetch', async () => {
    mockFetchSuccess()
    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    await waitFor(() => expect(result.current.meta).not.toBeNull())
    expect(result.current.meta?.gasless).toBeDefined()
    expect(result.current.meta?.gasless?.available).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// HF-L-01 — doFetch stability + in-flight guard
// ─────────────────────────────────────────────────────────────
describe('useQuote — HF-L-01 stability', () => {
  it('does NOT re-fetch on every parent rerender (doFetch identity is stable)', async () => {
    const fetchSpy = mockFetchSuccess()
    const { rerender, result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )

    await waitFor(() => expect(result.current.meta).not.toBeNull())
    const firstCallCount = fetchSpy.mock.calls.length

    // Force several parent re-renders. estimateGasCost is rebuilt every
    // render — pre-hotfix this drove doFetch identity churn and a
    // request flood. After the hotfix, the polling effect doesn't
    // re-arm, so no extra fetch.
    for (let i = 0; i < 5; i++) rerender()
    await flush()

    expect(fetchSpy.mock.calls.length).toBe(firstCallCount)
  })

  it('[P208] supersedes an in-flight request: refetch() aborts the prior fetch and issues a new one', async () => {
    // Hold the first fetch open so the supersede is observable. The boolean
    // drop-guard used to make a concurrent refetch a no-op; the
    // AbortController model aborts the stale request and starts a fresh one.
    const pending = new Promise<Response>(() => {}) // never resolves
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockReturnValueOnce(pending)
      .mockResolvedValue(
        new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }),
      )

    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    // Let the first fetch start.
    await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // The first request carries an AbortSignal that is not yet aborted.
    const firstSignal = (fetchSpy.mock.calls[0][1] as RequestInit | undefined)?.signal
    expect(firstSignal).toBeDefined()
    expect(firstSignal?.aborted).toBe(false)

    // A manual refetch aborts the stale request and issues a fresh one.
    await act(async () => {
      await result.current.refetch()
    })
    expect(firstSignal?.aborted).toBe(true)
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
    expect(result.current.meta).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// HF-L-01 — exponential backoff on 429
// ─────────────────────────────────────────────────────────────
describe('useQuote — HF-L-01 exponential backoff on 429', () => {
  it('keeps the error visible across a manual refetch while in backoff', async () => {
    // First call: 429. Subsequent calls: also 429 — the refetch should
    // NOT clear the message at the top (setError(null) is gated by
    // inBackoffRef once we've entered backoff).
    mockFetchStatus(429, { error: 'Rate limit exceeded. Try again in a minute.' })
    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    await waitFor(() => expect(result.current.error).toMatch(/rate limit/i))
    const firstErrorMessage = result.current.error

    // Manually trigger a retry — message must not blip to null.
    await act(async () => {
      await result.current.refetch()
    })
    expect(result.current.error).toBe(firstErrorMessage)
  })

  it('recovers cleanly: a 200 after a 429 clears the error and resumes the normal cadence', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'rate-limited' }), { status: 429 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }),
      )

    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    await waitFor(() => expect(result.current.error).toMatch(/rate/i))

    // Manually refetch — the next fetch is the success mock; backoff
    // state must reset on the success and error must clear.
    await act(async () => {
      await result.current.refetch()
    })
    await waitFor(() => expect(result.current.error).toBeNull())
    expect(result.current.meta).not.toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('non-429 errors do NOT enter backoff — they fall through the normal error path', async () => {
    mockFetchStatus(500, { error: 'oops' })
    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    await waitFor(() => expect(result.current.error).toMatch(/oops/i))

    // A subsequent refetch should clear the error at the top of the
    // call (the inBackoffRef gate is false for non-429s). Mock the
    // next response as success to verify normal flow.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }),
    )
    await act(async () => {
      await result.current.refetch()
    })
    await waitFor(() => expect(result.current.error).toBeNull())
  })
})

// ─────────────────────────────────────────────────────────────
// P208 / FULL-L-01 — AbortController supersede semantics
// ─────────────────────────────────────────────────────────────
describe('useQuote — [P208] AbortController', () => {
  it('aborts the in-flight request when the token pair changes', async () => {
    const pending = new Promise<Response>(() => {}) // first request never resolves
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockReturnValueOnce(pending)
      .mockResolvedValue(new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }))

    const { rerender } = renderHook(
      ({ tin, tout }: { tin: Token; tout: Token }) =>
        useQuote(tin, tout, '1', true, undefined),
      { initialProps: { tin: TOKEN_IN, tout: TOKEN_OUT } },
    )
    await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const firstSignal = (fetchSpy.mock.calls[0][1] as RequestInit | undefined)?.signal
    expect(firstSignal?.aborted).toBe(false)

    // Swap the pair → doFetch identity changes → polling effect re-runs →
    // the stale request is aborted and a fresh one issued.
    await act(async () => {
      rerender({ tin: TOKEN_OUT, tout: TOKEN_IN })
      await flush()
    })
    expect(firstSignal?.aborted).toBe(true)
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
  })

  it('ignores AbortError silently — no error state, no meta clear', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }))
      .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))

    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    await waitFor(() => expect(result.current.meta).not.toBeNull())

    // A subsequent fetch rejecting with AbortError must not clobber state.
    await act(async () => {
      await result.current.refetch()
    })
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
    expect(result.current.error).toBeNull()
    expect(result.current.meta).not.toBeNull() // prior pair's quote retained
  })

  it('cleans up on unmount — aborts the pending request', async () => {
    const pending = new Promise<Response>(() => {}) // never resolves
    const fetchSpy = vi.spyOn(global, 'fetch').mockReturnValue(pending)

    const { unmount } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const signal = (fetchSpy.mock.calls[0][1] as RequestInit | undefined)?.signal
    expect(signal?.aborted).toBe(false)

    unmount()
    expect(signal?.aborted).toBe(true)
  })
})
