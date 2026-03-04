import { useState, useEffect, useCallback, useRef } from 'react'
import { parseUnits } from 'viem'
import { useDebounce } from './useDebounce'
import { type MetaQuoteResult } from '@/lib/api'
import { INPUT_DEBOUNCE_MS, QUOTE_REFRESH_MS } from '@/lib/constants'
import type { Token } from '@/lib/tokens'

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
): Promise<MetaQuoteResult> {
  const params = new URLSearchParams({
    src,
    dst,
    amount,
    srcDecimals: srcDecimals.toString(),
    dstDecimals: dstDecimals.toString(),
  })

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
): UseQuoteResult {
  const [meta, setMeta] = useState<MetaQuoteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(QUOTE_REFRESH_MS / 1000)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const debouncedAmount = useDebounce(amountIn, INPUT_DEBOUNCE_MS)

  const doFetch = useCallback(async () => {
    if (!tokenIn || !tokenOut || !debouncedAmount || Number(debouncedAmount) <= 0) {
      setMeta(null)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const rawAmount = parseUnits(debouncedAmount, tokenIn.decimals).toString()
      const result = await fetchQuoteViaApi(
        tokenIn.address,
        tokenOut.address,
        rawAmount,
        tokenIn.decimals,
        tokenOut.decimals,
      )
      setMeta(result)
      setCountdown(QUOTE_REFRESH_MS / 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch quotes')
      setMeta(null)
    } finally {
      setLoading(false)
    }
  }, [tokenIn, tokenOut, debouncedAmount])

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
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [doFetch, enabled])

  return { meta, loading, error, countdown, refetch: doFetch }
}
