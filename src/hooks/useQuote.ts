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

  const res = await fetch(`/api/quote?${params}`)
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
}

export function useQuote(
  tokenIn: Token | null,
  tokenOut: Token | null,
  amountIn: string,
  enabled: boolean,
  excludeSources?: string[],
): UseQuoteResult {
  const { address } = useAccount()
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

  // [hotfix] In-flight guard: even if a future regression re-introduces
  // effect churn, only one network request can be on the wire at a
  // time. Belt-and-suspenders alongside the stable doFetch above.
  const inFlightRef = useRef(false)

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

    if (inFlightRef.current) return
    inFlightRef.current = true

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
      setLoading(false)
      inFlightRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenIn, tokenOut, debouncedAmount, address, excludeKey, rearmPollTimer])

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
    }
  }, [doFetch, enabled])

  return { meta, loading, error, countdown, refetch: doFetch }
}
