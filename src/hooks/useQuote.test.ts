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
let _estimateCallCount = 0
vi.mock('./useEthGasCost', () => ({
  useEthGasCost: vi.fn(() => ({
    ethPrice: 2000,
    gasPriceGwei: 20,
    estimate: () => {
      _estimateCallCount++
      return { eth: 0.001, usd: 2 }
    },
  })),
}))

// Skip the debounce in tests — passthrough so doFetch fires synchronously on input
// change. [fix/stale-quote-pair-flip] `realDebounce` switches in a real (timer-based)
// debounce for the flip+type request-count tests.
let realDebounce = false
vi.mock('./useDebounce', async () => {
  const { useState, useEffect } = await import('react')
  return {
    useDebounce: <T,>(v: T, ms: number) => {
      const [d, setD] = useState(v)
      useEffect(() => {
        if (!realDebounce) return
        const t = setTimeout(() => setD(v), ms)
        return () => clearTimeout(t)
      }, [v, ms])
      return realDebounce ? d : v
    },
  }
})

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
import { QUOTE_REFRESH_MS, INPUT_DEBOUNCE_MS } from '@/lib/constants'

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

/** [fix/stale-quote-pair-flip] The identity /api/quote echoes — here for WETH→USDC, 1 WETH, chain 1. */
function echoFor(
  tin: Token,
  tout: Token,
  amountIn: string,
  chainId = 1,
) {
  return {
    tokenIn: tin.address,
    tokenOut: tout.address,
    chainId,
    decimalsIn: tin.decimals,
    decimalsOut: tout.decimals,
    amountIn,
  }
}

const VALID_RESPONSE = {
  ...echoFor(TOKEN_IN, TOKEN_OUT, '1000000000000000000'),
  best: { source: '1inch', toAmount: '2950000000', estimatedGas: 150000, gasUsd: 5, routes: [] },
  all: [
    { source: '1inch', toAmount: '2950000000', estimatedGas: 150000, gasUsd: 5, routes: [] },
  ],
  fetchedAt: Date.now(),
}

beforeEach(() => {
  vi.clearAllMocks()
  _estimateCallCount = 0
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

  it('ignores AbortError silently — no error state, no meta clear (same pair)', async () => {
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
    expect(result.current.meta).not.toBeNull() // same pair's quote retained
  })

  it('[fix/stale-quote-pair-flip] a pair change does NOT retain the prior pair\'s quote (inverts the old "retained" expectation)', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }))
      .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))

    const { result, rerender } = renderHook(
      ({ tin, tout }: { tin: Token; tout: Token }) => useQuote(tin, tout, '1', true, undefined),
      { initialProps: { tin: TOKEN_IN, tout: TOKEN_OUT } },
    )
    await waitFor(() => expect(result.current.meta).not.toBeNull())

    await act(async () => {
      rerender({ tin: TOKEN_OUT, tout: TOKEN_IN })
      await flush()
    })
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
    expect(result.current.error).toBeNull()
    expect(result.current.meta).toBeNull()
  })

  it('[fix/quote-identity-loop, acceptance 2] does NOT refetch when a caller hands a structurally identical but newly-allocated token object', async () => {
    const fetchSpy = mockFetchSuccess()
    const { rerender } = renderHook(
      ({ tin, tout }: { tin: Token; tout: Token }) =>
        useQuote(tin, tout, '1', true, undefined),
      { initialProps: { tin: TOKEN_IN, tout: TOKEN_OUT } },
    )
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))

    // A fresh object with the SAME address/decimals — e.g. getChainTokenList()
    // rebuilding the catalog via .map() every call. Object identity differs;
    // the values that actually determine a quote do not.
    const equivalentTokenIn: Token = { ...TOKEN_IN }
    const equivalentTokenOut: Token = { ...TOKEN_OUT }
    expect(equivalentTokenIn).not.toBe(TOKEN_IN)

    for (let i = 0; i < 5; i++) {
      rerender({ tin: { ...equivalentTokenIn }, tout: { ...equivalentTokenOut } })
    }
    await flush()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
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

// ─────────────────────────────────────────────────────────────
// [fix/quote-poll-visibility] Page Visibility API — suspend/resume poll
// ─────────────────────────────────────────────────────────────
describe('useQuote — visibility-aware polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    // Restore jsdom's default so other describe blocks in this file (real
    // timers, no visibility overrides) aren't affected by a leaked stub.
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })

  function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  it('[acceptance 1] fires zero fetches across N poll intervals while the document is hidden', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    const fetchSpy = mockFetchSuccess()

    renderHook(() => useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTE_REFRESH_MS * 4)
    })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('[acceptance 2] becoming visible triggers exactly one immediate fetch, not zero and not two', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    const fetchSpy = mockFetchSuccess()

    renderHook(() => useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchSpy).not.toHaveBeenCalled()

    await act(async () => {
      setHidden(false)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Advancing less than a full interval must not add a second fetch —
    // the resume fetch does not also rearm an interval that fires again
    // immediately.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTE_REFRESH_MS - 1000)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('[acceptance 3] a quote already in flight when the tab hides still resolves and updates state', async () => {
    let resolveFetch: ((r: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    vi.spyOn(global, 'fetch').mockReturnValueOnce(pending)

    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.loading).toBe(true)

    // Hide the tab while the request is still on the wire — the in-flight
    // fetch is never aborted on hide, only future scheduling stops.
    await act(async () => {
      setHidden(true)
    })

    await act(async () => {
      resolveFetch?.(new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.meta).not.toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('[acceptance 4] a visible tab repeats polling every QUOTE_REFRESH_MS unchanged from today\'s cadence', async () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    const fetchSpy = mockFetchSuccess()

    renderHook(() => useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTE_REFRESH_MS)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTE_REFRESH_MS)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('does NOT double the poll interval when "visible" fires twice in a row (bfcache/pageshow path)', async () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    const fetchSpy = mockFetchSuccess()

    renderHook(() => useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Two consecutive hidden=false visibilitychange signals — e.g. a
    // bfcache restore firing both `visibilitychange` and `pageshow` mapped
    // to the same handler — must not stack a second interval on top of
    // the first.
    await act(async () => {
      setHidden(false)
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      setHidden(false)
      await vi.advanceTimersByTimeAsync(0)
    })

    fetchSpy.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTE_REFRESH_MS)
    })
    // A single active interval fires once per QUOTE_REFRESH_MS. A leaked
    // duplicate would fire twice.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('stops the poll interval and the countdown ticker (no discarded timers) once the tab hides', async () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    mockFetchSuccess()

    const { result } = renderHook(() =>
      useQuote(TOKEN_IN, TOKEN_OUT, '1', true, undefined),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.countdown).toBe(QUOTE_REFRESH_MS / 1000)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    const countdownAtHide = result.current.countdown
    expect(countdownAtHide).toBeLessThan(QUOTE_REFRESH_MS / 1000)

    await act(async () => {
      setHidden(true)
    })

    // Advancing time while hidden must not change the countdown — the
    // ticker itself is stopped, not just the fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.countdown).toBe(countdownAtHide)
  })
})

// ─────────────────────────────────────────────────────────────
// [fix/stale-quote-pair-flip] A quote carries its identity
// ─────────────────────────────────────────────────────────────
describe('useQuote — [fix/stale-quote-pair-flip] quote identity', () => {
  const flipProps = { tin: TOKEN_OUT, tout: TOKEN_IN }
  const baseProps = { tin: TOKEN_IN, tout: TOKEN_OUT }
  const render = (initial = baseProps, amount = '1') =>
    renderHook(
      ({ tin, tout }: { tin: Token; tout: Token }) => useQuote(tin, tout, amount, true, undefined),
      { initialProps: initial },
    )

  it('tags the stored quote with the request identity (chain, pair, raw amount, decimals)', async () => {
    mockFetchSuccess()
    const { result } = render()
    await waitFor(() => expect(result.current.meta).not.toBeNull())
    expect(result.current.meta?.identity).toMatchObject({
      chainId: 1,
      tokenIn: TOKEN_IN.address.toLowerCase(),
      tokenOut: TOKEN_OUT.address.toLowerCase(),
      amountRaw: '1000000000000000000',
      decimalsIn: 18,
      decimalsOut: 6,
    })
  })

  it('flip after a resolved quote → meta is null in the very next render (no stale number, no effect lag)', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }))
      .mockReturnValue(new Promise<Response>(() => {})) // the flipped pair's quote never lands
    const { result, rerender } = render()
    await waitFor(() => expect(result.current.meta).not.toBeNull())

    // No act/await: the render triggered by the flip must already hide the old quote.
    rerender(flipProps)
    expect(result.current.meta).toBeNull()
    await flush()
    expect(result.current.meta).toBeNull()
  })

  it('flipping back does NOT resurrect the earlier quote (cleared, not just hidden)', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }))
      .mockReturnValue(new Promise<Response>(() => {}))
    const { result, rerender } = render()
    await waitFor(() => expect(result.current.meta).not.toBeNull())

    await act(async () => {
      rerender(flipProps)
      await flush()
    })
    await act(async () => {
      rerender(baseProps)
      await flush()
    })
    expect(result.current.meta).toBeNull()
  })

  it('a LATE response for the old pair is ignored (even though the mocked fetch ignores the abort)', async () => {
    let resolveOld: ((r: Response) => void) | undefined
    const oldPair = new Promise<Response>((resolve) => { resolveOld = resolve })
    vi.spyOn(global, 'fetch')
      .mockReturnValueOnce(oldPair)
      .mockReturnValue(new Promise<Response>(() => {}))
    const { result, rerender } = render()
    await Promise.resolve()

    await act(async () => {
      rerender(flipProps)
      await flush()
    })
    await act(async () => {
      resolveOld?.(new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }))
      await flush()
    })
    expect(result.current.meta).toBeNull()
  })

  it('a same-pair re-quote IS rendered (refetch replaces the stored quote)', async () => {
    const first = { ...VALID_RESPONSE, best: { ...VALID_RESPONSE.best, toAmount: '2950000000' } }
    const second = { ...VALID_RESPONSE, best: { ...VALID_RESPONSE.best, toAmount: '2960000000' } }
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(first), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify(second), { status: 200 }))
    const { result } = render()
    await waitFor(() => expect(result.current.meta?.best.toAmount).toBe('2950000000'))

    await act(async () => {
      await result.current.refetch()
    })
    expect(result.current.meta?.best.toAmount).toBe('2960000000')
  })

  it('an amount change on the same pair keeps the current quote on screen until the re-quote lands', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }))
      .mockReturnValue(new Promise<Response>(() => {}))
    const { result, rerender } = renderHook(
      ({ amt }: { amt: string }) => useQuote(TOKEN_IN, TOKEN_OUT, amt, true, undefined),
      { initialProps: { amt: '1' } },
    )
    await waitFor(() => expect(result.current.meta).not.toBeNull())

    await act(async () => {
      rerender({ amt: '2' })
      await flush()
    })
    expect(result.current.meta).not.toBeNull()
  })

  it('a late response for a SUPERSEDED amount is ignored', async () => {
    let resolveOld: ((r: Response) => void) | undefined
    const oldAmount = new Promise<Response>((resolve) => { resolveOld = resolve })
    const newer = { ...VALID_RESPONSE, ...echoFor(TOKEN_IN, TOKEN_OUT, '2000000000000000000'), best: { ...VALID_RESPONSE.best, toAmount: '5900000000' } }
    vi.spyOn(global, 'fetch')
      .mockReturnValueOnce(oldAmount)
      .mockResolvedValue(new Response(JSON.stringify(newer), { status: 200 }))
    const { result, rerender } = renderHook(
      ({ amt }: { amt: string }) => useQuote(TOKEN_IN, TOKEN_OUT, amt, true, undefined),
      { initialProps: { amt: '1' } },
    )
    await Promise.resolve()
    await act(async () => {
      rerender({ amt: '2' })
      await flush()
    })
    await waitFor(() => expect(result.current.meta?.best.toAmount).toBe('5900000000'))

    await act(async () => {
      resolveOld?.(new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }))
      await flush()
    })
    expect(result.current.meta?.best.toAmount).toBe('5900000000')
  })

  it('[commit 2] keys the quote from the SERVER echo: a response that echoes a different pair than the current selection is ignored', async () => {
    // The server answers for USDC→WETH although the client asked WETH→USDC (or the
    // request was re-pointed mid-flight): the echoed identity, not the request, decides.
    const wrong = { ...VALID_RESPONSE, ...echoFor(TOKEN_OUT, TOKEN_IN, '1000000') }
    mockFetchSuccess(wrong)
    const { result } = render()
    await flush()
    expect(result.current.meta).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('[commit 2] a response with NO echo is unusable → clean error, no quote (fail closed)', async () => {
    const { tokenIn: _a, tokenOut: _b, chainId: _c, decimalsIn: _d, decimalsOut: _e, amountIn: _f, ...noEcho } = VALID_RESPONSE
    mockFetchSuccess(noEcho)
    const { result } = render()
    await waitFor(() => expect(result.current.error).toMatch(/failed to fetch quotes/i))
    expect(result.current.meta).toBeNull()
  })

  it('[commit 2] the stored identity is the echoed one and the echo fields are stripped from the quote object', async () => {
    mockFetchSuccess()
    const { result } = render()
    await waitFor(() => expect(result.current.meta).not.toBeNull())
    expect(result.current.meta?.identity).toMatchObject({ chainId: 1, decimalsIn: 18, decimalsOut: 6, amountRaw: '1000000000000000000' })
    for (const k of ['tokenIn', 'tokenOut', 'chainId', 'decimalsIn', 'decimalsOut', 'amountIn']) {
      expect(result.current.meta).not.toHaveProperty(k)
    }
  })

  describe('requests per flip + type [commit 4]', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      realDebounce = true
    })
    afterEach(() => {
      realDebounce = false
      vi.useRealTimers()
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    })

    const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(INPUT_DEBOUNCE_MS) })

    it('a ⇅ flip then typing a new amount costs ONE /api/quote request (was two: an immediate refetch with the old debounced amount, then the settle)', async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      const fetchSpy = mockFetchSuccess()
      const { rerender } = renderHook(
        ({ tin, tout, amt }: { tin: Token; tout: Token; amt: string }) => useQuote(tin, tout, amt, true, undefined),
        { initialProps: { tin: TOKEN_IN, tout: TOKEN_OUT, amt: '1' } },
      )
      await settle()
      expect(fetchSpy).toHaveBeenCalledTimes(1) // the initial quote
      fetchSpy.mockClear()

      // ⇅ — SwapBox swaps the tokens AND clears the amount in the same render.
      await act(async () => { rerender({ tin: TOKEN_OUT, tout: TOKEN_IN, amt: '' }) })
      expect(fetchSpy).not.toHaveBeenCalled() // no immediate refetch on the stale debounced amount
      await settle()
      expect(fetchSpy).not.toHaveBeenCalled() // an empty amount never fetches

      // The user types the new amount.
      await act(async () => { rerender({ tin: TOKEN_OUT, tout: TOKEN_IN, amt: '5' }) })
      expect(fetchSpy).not.toHaveBeenCalled() // still debouncing
      await settle()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const url = String(fetchSpy.mock.calls[0][0])
      expect(url).toContain(`src=${TOKEN_OUT.address}`)
      expect(url).toContain('amount=5000000') // 5 USDC at the NEW tokenIn decimals (6), never the old 1e18-scale amount
    })

    it('a poll tick while a typed amount is still debouncing does not fetch', async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      const fetchSpy = mockFetchSuccess()
      const { rerender } = renderHook(
        ({ amt }: { amt: string }) => useQuote(TOKEN_IN, TOKEN_OUT, amt, true, undefined),
        { initialProps: { amt: '1' } },
      )
      await settle()
      fetchSpy.mockClear()
      // Type, then let the interval fire before the debounce settles: advance to 1ms before the
      // poll tick, type, and cross the tick while the 500ms debounce is still pending.
      await act(async () => { await vi.advanceTimersByTimeAsync(QUOTE_REFRESH_MS - INPUT_DEBOUNCE_MS - 1 - 100) })
      await act(async () => { rerender({ amt: '2' }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(INPUT_DEBOUNCE_MS - 1) })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('typing on a stable pair still fetches exactly once per settled amount', async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      const fetchSpy = mockFetchSuccess()
      const { rerender } = renderHook(
        ({ amt }: { amt: string }) => useQuote(TOKEN_IN, TOKEN_OUT, amt, true, undefined),
        { initialProps: { amt: '1' } },
      )
      await settle()
      fetchSpy.mockClear()
      for (const a of ['2', '23', '234']) {
        await act(async () => { rerender({ amt: a }) })
        await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      }
      expect(fetchSpy).not.toHaveBeenCalled()
      await settle()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })
})
