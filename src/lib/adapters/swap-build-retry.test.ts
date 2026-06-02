/**
 * [SPRINT-9J J2] Swap-build retry/timeout wrapper.
 *
 * The /api/swap build step (adapter.fetchSwapData) had no timeout — a slow
 * upstream (e.g. Velora /transactions/{chainId}) let the serverless function
 * run past its limit, so the PLATFORM returned an HTML error page and the
 * client saw "Unexpected token '<' … not valid JSON".
 *
 * withSwapBuildRetry bounds each attempt with a timeout and retries ONLY
 * transient failures (timeout / network / 5xx / non-JSON upstream blip). The
 * build is idempotent — it generates calldata and does NOT broadcast a tx
 * (CoW order submission is a separate client-side step) — so a retry can never
 * double-submit. Deterministic failures (no route, insufficient liquidity,
 * 4xx) are NOT retried.
 */
import { describe, it, expect, vi } from 'vitest'
import { withSwapBuildRetry, isTransientSwapError } from './swap-build-retry'

const FAST = { timeoutMs: 40, maxAttempts: 2, backoffMs: 5 }

describe('isTransientSwapError [SPRINT-9J J2]', () => {
  it('treats timeout / network / 5xx / non-JSON as transient (retryable)', () => {
    for (const m of ['Timeout', 'Failed to fetch', 'NetworkError', 'velora: invalid response (non-JSON). API may be down.', 'HTTP 503', 'HTTP 502', 'ETIMEDOUT']) {
      expect(isTransientSwapError(new Error(m))).toBe(true)
    }
  })
  it('treats deterministic failures as NON-transient (no retry)', () => {
    for (const m of ['No route found for this pair', 'Insufficient liquidity', 'HTTP 400: bad request', 'Unknown source: foo']) {
      expect(isTransientSwapError(new Error(m))).toBe(false)
    }
  })
})

describe('withSwapBuildRetry [SPRINT-9J J2]', () => {
  it('returns the result on first success (no retry)', async () => {
    const fn = vi.fn(async () => 'ok')
    expect(await withSwapBuildRetry(fn, FAST)).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a transient failure then succeeds', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      n++
      if (n === 1) throw new Error('Timeout')
      return 'recovered'
    })
    expect(await withSwapBuildRetry(fn, FAST)).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting attempts on a persistent transient failure', async () => {
    const fn = vi.fn(async () => { throw new Error('HTTP 503') })
    await expect(withSwapBuildRetry(fn, FAST)).rejects.toThrow(/503/)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a deterministic failure (fails fast, single call)', async () => {
    const fn = vi.fn(async () => { throw new Error('No route found for this pair') })
    await expect(withSwapBuildRetry(fn, FAST)).rejects.toThrow(/no route/i)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('bounds a hanging upstream with a timeout and retries it (never hangs)', async () => {
    const fn = vi.fn(() => new Promise<string>(() => {})) // never resolves
    await expect(withSwapBuildRetry(fn, FAST)).rejects.toThrow(/timeout/i)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('ABORTS the signal when the per-attempt timeout fires (true cancellation)', async () => {
    let captured: AbortSignal | undefined
    const fn = vi.fn((signal: AbortSignal) => {
      captured = signal
      return new Promise<string>(() => {}) // relies on abort to settle
    })
    await expect(withSwapBuildRetry(fn, FAST)).rejects.toThrow(/timeout/i)
    expect(captured?.aborted).toBe(true)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('normalises an AbortError to a retryable timeout', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      n++
      if (n === 1) {
        const e = new Error('The operation was aborted')
        e.name = 'AbortError'
        throw e
      }
      return 'recovered'
    })
    expect(await withSwapBuildRetry(fn, FAST)).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
