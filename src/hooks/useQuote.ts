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
    throw new Error(data.error || `Quote API error ${res.status}`)
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

  const debouncedAmount = useDebounce(amountIn, INPUT_DEBOUNCE_MS)
  // [hotfix] Stable string form of excludeSources for the dep array —
  // the caller in SwapBox already memoises the array, but a missing
  // useMemo there would have re-triggered the whole effect chain. The
  // join shape (`a,b` vs `b,a` is fine — order only matters for the
  // request URL) makes the dep cheap to compare and immune to upstream
  // array-identity changes.
  const excludeKey = excludeSources?.join(',') ?? ''

  const doFetch = useCallback(async () => {
    if (!tokenIn || !tokenOut || !debouncedAmount || Number(debouncedAmount) <= 0) {
      setMeta(null)
      return
    }

    if (inFlightRef.current) return
    inFlightRef.current = true

    setLoading(true)
    setError(null)

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
      setError(err instanceof Error ? err.message : 'Failed to fetch quotes')
      setMeta(null)
    } finally {
      setLoading(false)
      inFlightRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenIn, tokenOut, debouncedAmount, address, excludeKey])

  useEffect(() => {
    if (!enabled) {
      setMeta(null)
      return
    }

    doFetch()
    intervalRef.current = setInterval(doFetch, QUOTE_REFRESH_MS)
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? QUOTE_REFRESH_MS / 1000 : prev - 1))
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
