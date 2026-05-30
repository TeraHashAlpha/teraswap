import { useState, useEffect, useCallback, useRef } from 'react'
import { parseUnits } from 'viem'
import { useAccount } from 'wagmi'
import { useDebounce } from './useDebounce'
import { type MetaQuoteResult } from '@/lib/api'
import { INPUT_DEBOUNCE_MS, QUOTE_REFRESH_MS } from '@/lib/constants'
import type { Token } from '@/lib/tokens'
import { logQuoteToSupabase } from '@/lib/analytics'
import { analyzeGasless } from '@/lib/gasless-engine'
import { useEthGasCost } from './useEthGasCost'
import { useActiveChainId } from './useChainId'
import { isChainActive } from '@/lib/chains'

/**
 * Typed error carrying the /api/quote HTTP status. Lets the hook
 * distinguish a 429 rate-limit response from a generic failure without
 * inspecting the message string.
 */
class QuoteApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'QuoteApiError'
    this.status = status
  }
}

/** [hotfix] Backoff ceiling on consecutive 429s. */
const MAX_BACKOFF_MS = 120_000

/**
 * Fetch meta-quotes via the server-side API route.
 * This avoids browser CORS restrictions that block direct calls to
 * 1inch, Odos, 0x, Balancer, CoW and other DEX APIs.
 */
async function fetchQuoteViaApi(
  src: string,
  dst: string,
  amount: string,
  srcDecimals: number,
  dstDecimals: number,
  excludeSources?: string[],
  // [P219 review] Target chain — appended to the query only for non-mainnet
  // chains so the mainnet request is byte-identical to the pre-multi-chain one.
  chainId?: number,
  // [P208 / FULL-L-01] Lets the caller abort a superseded request when the
  // token pair or amount changes mid-flight. AbortError is swallowed by the
  // caller — it means a newer request already took over.
  signal?: AbortSignal,
): Promise<MetaQuoteResult> {
  const params = new URLSearchParams({
    src,
    dst,
    amount,
    srcDecimals: srcDecimals.toString(),
    dstDecimals: dstDecimals.toString(),
  })
  if (excludeSources && excludeSources.length > 0) {
    params.set('exclude', excludeSources.join(','))
  }
  if (chainId && chainId !== 1) {
    params.set('chainId', String(chainId))
  }

  const res = await fetch(`/api/quote?${params}`, signal ? { signal } : undefined)
  const data = await res.json()

  if (!res.ok) {
    throw new QuoteApiError(
      data.error || `Quote API error ${res.status}`,
      res.status,
    )
  }

  return data as MetaQuoteResult
}

interface UseQuoteResult {
  meta: MetaQuoteResult | null
  loading: boolean
  error: string | null
  countdown: number
  refetch: () => void
  /** Manual quote refresh trigger. No-op if a fetch is already in flight.
   *  Resets the countdown to the current poll interval (respects backoff). */
  refresh: () => void
}

export function useQuote(
  tokenIn: Token | null,
  tokenOut: Token | null,
  amountIn: string,
  enabled: boolean,
  excludeSources?: string[],
): UseQuoteResult {
  const { address } = useAccount()
  // [P219] Active chain — switching chains supersedes the current quote (the
  // AbortController in doFetch cancels the stale in-flight request). On mainnet
  // this never changes, so quote behaviour is unchanged. End-to-end chainId →
  // /api/quote threading is deferred to the Base-activation sprint (see FEEDBACK).
  const activeChainId = useActiveChainId()
  const { estimate: estimateGasCost } = useEthGasCost()
  const [meta, setMeta] = useState<MetaQuoteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(QUOTE_REFRESH_MS / 1000)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // [hotfix] Capture the latest estimateGasCost in a ref so doFetch's
  // identity doesn't churn every wagmi tick. `useEthGasCost` rebuilds
  // its `estimate` closure on every call (it captures live ethPrice +
  // gasPriceWei), so every wagmi refetch produced a new function ref.
  // That ref was in doFetch's useCallback deps → doFetch identity
  // changed → the polling useEffect re-ran → each re-run synchronously
  // calls doFetch() at the top of the effect body. Result in prod:
  // ~11 GET /api/quote requests in ~10s, all in flight, none debounced.
  //
  // Reading via a ref breaks the dependency chain — doFetch stays
  // stable across renders and the polling timer is built exactly once
  // per (tokens, amount, address, exclude) change.
  const estimateGasCostRef = useRef(estimateGasCost)
  useEffect(() => {
    estimateGasCostRef.current = estimateGasCost
  }, [estimateGasCost])

  // [P208 / FULL-L-01] AbortController for the in-flight quote request.
  // Replaces the old boolean drop-guard: instead of skipping a new fetch
  // while one is on the wire, we abort the stale request and immediately
  // supersede it. This removes the up-to-one-poll delay after a token/amount
  // change and prevents a late resolve from painting old-pair data.
  const abortControllerRef = useRef<AbortController | null>(null)

  // [hotfix] Exponential backoff state for rate-limit responses.
  // `currentIntervalMsRef` holds the effective poll interval: starts at
  // QUOTE_REFRESH_MS (15s), doubles to 30s/60s/120s on consecutive 429s,
  // and snaps back to the normal cadence on the first successful fetch.
  // `inBackoffRef` gates the `setError(null)` reset at the top of every
  // doFetch — without it the error toggles null → "Rate limit…" → null
  // → "Rate limit…" every poll and floods the toast layer.
  const currentIntervalMsRef = useRef(QUOTE_REFRESH_MS)
  const inBackoffRef = useRef(false)

  const debouncedAmount = useDebounce(amountIn, INPUT_DEBOUNCE_MS)
  // [hotfix] Stable string form of excludeSources for the dep array —
  // the caller in SwapBox already memoises the array, but a missing
  // useMemo there would have re-triggered the whole effect chain. The
  // join shape (`a,b` vs `b,a` is fine — order only matters for the
  // request URL) makes the dep cheap to compare and immune to upstream
  // array-identity changes.
  const excludeKey = excludeSources?.join(',') ?? ''

  // [hotfix] Tear down + rebuild the poll timer with the current
  // backoff interval. Called when entering or leaving backoff. Reads
  // from doFetchRef so the timer always uses the latest closure even
  // though this helper is invoked from inside doFetch's own body.
  const rearmPollTimer = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = setInterval(
      () => doFetchRef.current?.(),
      currentIntervalMsRef.current,
    )
    setCountdown(Math.ceil(currentIntervalMsRef.current / 1000))
  }, [])

  const doFetch = useCallback(async () => {
    if (!tokenIn || !tokenOut || !debouncedAmount || Number(debouncedAmount) <= 0) {
      setMeta(null)
      return
    }

    // [P223] No quotes on a "coming-soon" chain (FeeCollector not deployed) —
    // don't waste API calls. Mainnet is active, so this never skips on mainnet.
    if (!isChainActive(activeChainId)) {
      setMeta(null)
      return
    }

    // [P208] Abort any in-flight request and supersede it with this one.
    // The aborted request's fetch rejects with AbortError, which we swallow
    // in the catch below so it never touches error/meta state.
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller
    const { signal } = controller

    setLoading(true)
    // [hotfix] Only clear the error when we're NOT in a rate-limit
    // backoff window. Otherwise the null → error cycle on every retry
    // is what drives the toast flood (the SwapBox dedup is the second
    // line of defence, this is the first).
    if (!inBackoffRef.current) {
      setError(null)
    }

    const startTime = Date.now()
    try {
      const rawAmount = parseUnits(debouncedAmount, tokenIn.decimals).toString()
      const result = await fetchQuoteViaApi(
        tokenIn.address,
        tokenOut.address,
        rawAmount,
        tokenIn.decimals,
        tokenOut.decimals,
        excludeSources,
        activeChainId,
        signal,
      )

      // [P94] Compute the gasless recommendation client-side so it uses the
      // current ETH price + gas price (the server doesn't have either).
      // The best non-CoW quote is what the user would otherwise execute,
      // so its gas estimate sets the savings figure. Read the latest
      // estimate via ref so this doesn't pull stale wagmi state.
      const bestNonCow = result.all.find((q) => q.source !== 'cowswap')
      const refGas = bestNonCow ? estimateGasCostRef.current(bestNonCow.estimatedGas) : null
      const refGasUsd = refGas?.usd ?? bestNonCow?.gasUsd ?? 0
      const gasless = analyzeGasless(result.all, refGasUsd)

      setMeta({ ...result, gasless })
      // [hotfix] First success after backoff — snap back to the normal
      // cadence and clear the error in one shot (we skipped that reset
      // at the top of this call). If we weren't in backoff, the
      // countdown reset is the only side effect.
      if (inBackoffRef.current) {
        inBackoffRef.current = false
        currentIntervalMsRef.current = QUOTE_REFRESH_MS
        setError(null)
        rearmPollTimer()
      }
      setCountdown(QUOTE_REFRESH_MS / 1000)

      // Log quote analytics (fire-and-forget)
      logQuoteToSupabase({
        tokenIn,
        tokenOut,
        amountIn: rawAmount,
        meta: result,
        responseTimeMs: Date.now() - startTime,
        wallet: address,
      })
    } catch (err) {
      // [P208] A superseded request — do nothing. A newer fetch is already
      // in flight and owns the error/meta/loading state. Crucially this must
      // NOT trigger backoff: an abort is not a rate limit.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      // [hotfix] Treat HTTP 429 distinctly: enter (or extend) backoff
      // up to MAX_BACKOFF_MS, double the polling interval, and rearm
      // the timer. Other errors keep the normal cadence — backoff is
      // reserved for explicit rate limits.
      const isRateLimit = err instanceof QuoteApiError && err.status === 429
      if (isRateLimit) {
        const wasInBackoff = inBackoffRef.current
        inBackoffRef.current = true
        currentIntervalMsRef.current = Math.min(
          MAX_BACKOFF_MS,
          wasInBackoff ? currentIntervalMsRef.current * 2 : QUOTE_REFRESH_MS * 2,
        )
        rearmPollTimer()
      } else if (inBackoffRef.current) {
        // Non-429 error during a prior backoff — clear the backoff
        // flag so a transient network blip doesn't leave us stuck at
        // a 120s cadence after the rate limit lifts.
        inBackoffRef.current = false
        currentIntervalMsRef.current = QUOTE_REFRESH_MS
        rearmPollTimer()
      }
      setError(err instanceof Error ? err.message : 'Failed to fetch quotes')
      setMeta(null)
    } finally {
      // [P208] Only the request that's still current clears the spinner. If
      // this request was superseded (signal aborted), the newer one owns the
      // loading flag — clearing it here would flip the spinner off mid-fetch.
      if (!signal.aborted) {
        setLoading(false)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenIn, tokenOut, debouncedAmount, address, excludeKey, rearmPollTimer, activeChainId])

  // [hotfix] doFetchRef anchors the latest doFetch for the
  // setInterval callback in rearmPollTimer — without it the timer
  // would capture a stale closure across re-renders.
  const doFetchRef = useRef(doFetch)
  useEffect(() => {
    doFetchRef.current = doFetch
  }, [doFetch])

  useEffect(() => {
    if (!enabled) {
      setMeta(null)
      // [hotfix] Reset backoff so re-enabling (e.g. wallet reconnect)
      // starts at the normal cadence rather than a stale 120s window.
      inBackoffRef.current = false
      currentIntervalMsRef.current = QUOTE_REFRESH_MS
      return
    }

    doFetch()
    intervalRef.current = setInterval(doFetch, currentIntervalMsRef.current)
    countdownRef.current = setInterval(() => {
      // [hotfix] Read the live interval so the countdown reflects the
      // current backoff window (rolling over to 120s when rate-limited).
      setCountdown((prev) => (prev <= 1
        ? Math.ceil(currentIntervalMsRef.current / 1000)
        : prev - 1))
    }, 1000)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current)
        countdownRef.current = null
      }
      // [P208] Cancel any pending request so an unmount (or enabled flip)
      // can't resolve into a state update on a torn-down hook.
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [doFetch, enabled])

  // Manual refresh: invoke the latest doFetch via the ref (matches the
  // timer's call site), and reset the countdown so the next visible tick
  // reflects "just refreshed". [P208] doFetch now aborts any in-flight
  // request and supersedes it, so a click always issues a fresh quote
  // rather than being dropped while one is on the wire.
  const refresh = useCallback(() => {
    doFetchRef.current?.()
    setCountdown(Math.ceil(currentIntervalMsRef.current / 1000))
  }, [])

  return { meta, loading, error, countdown, refetch: doFetch, refresh }
}
