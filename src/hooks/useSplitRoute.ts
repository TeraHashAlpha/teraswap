import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { parseUnits, formatUnits } from 'viem'
import type { MetaQuoteResult, NormalizedQuote } from '@/lib/api'
import type { Token } from '@/lib/tokens'
import { fetchSplitQuotes, findBestSplit } from '@/lib/split-router'
import {
  type SplitQuoteResult,
  SPLIT_MIN_USD,
  SPLIT_MIN_IMPROVEMENT_BPS,
  SPLIT_ELIGIBLE_SOURCES,
} from '@/lib/split-routing-types'

interface UseSplitRouteResult {
  /** The split analysis result (null if not analyzed yet or trade too small) */
  splitResult: SplitQuoteResult | null
  /** Whether split analysis is in progress */
  analyzing: boolean
  /** Whether split is recommended */
  splitRecommended: boolean
  /** User's choice: use split or single */
  useSplit: boolean
  /** Toggle split on/off */
  toggleSplit: () => void
}

/**
 * Analyzes whether splitting the trade across multiple DEXes yields better output.
 * Only activates for trades above SPLIT_MIN_USD threshold.
 *
 * @param meta — existing MetaQuoteResult from useQuote
 * @param tokenIn — sell token
 * @param tokenOut — buy token
 * @param amountIn — human-readable amount
 * @param enabled — whether to analyze (connected, correct chain, etc.)
 */
export function useSplitRoute(
  meta: MetaQuoteResult | null,
  tokenIn: Token | null,
  tokenOut: Token | null,
  amountIn: string,
  enabled: boolean,
): UseSplitRouteResult {
  const [splitResult, setSplitResult] = useState<SplitQuoteResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [useSplit, setUseSplit] = useState(false)
  const abortRef = useRef(0)

  // Estimate trade USD value using Chainlink
  const executionPriceUsd = useMemo(() => {
    if (!meta?.best || !tokenIn || !tokenOut || !amountIn) return null
    const outAmount = Number(formatUnits(BigInt(meta.best.toAmount), tokenOut.decimals))
    const inAmount = Number(amountIn)
    if (inAmount <= 0) return null
    // If output token is a stablecoin, output amount ≈ USD
    if (['USDC', 'USDT', 'DAI'].includes(tokenOut.symbol)) return outAmount
    // If input token is a stablecoin, input amount ≈ USD
    if (['USDC', 'USDT', 'DAI'].includes(tokenIn.symbol)) return inAmount
    return null
  }, [meta, tokenIn, tokenOut, amountIn])

  const tradeAboveThreshold = executionPriceUsd !== null && executionPriceUsd >= SPLIT_MIN_USD

  const toggleSplit = useCallback(() => {
    setUseSplit(prev => !prev)
  }, [])

  // Analyze split routing when meta changes and trade is large enough
  useEffect(() => {
    if (!enabled || !meta || !tokenIn || !tokenOut || !amountIn || !tradeAboveThreshold) {
      setSplitResult(null)
      setUseSplit(false)
      return
    }

    const runId = ++abortRef.current
    let rawAmount: string
    try {
      rawAmount = parseUnits(amountIn, tokenIn.decimals).toString()
    } catch {
      setSplitResult(null)
      return
    }
    // Capture current values to avoid null checks inside async
    const currentMeta = meta
    const currentTokenIn = tokenIn
    const currentTokenOut = tokenOut

    async function analyze() {
      setAnalyzing(true)
      try {
        // Fetch quotes at sub-amounts by calling fetchMetaQuote at reduced amounts
        const fetchQuoteAtAmount = async (subAmount: string): Promise<NormalizedQuote[]> => {
          try {
            const params = new URLSearchParams({
              src: currentTokenIn.address,
              dst: currentTokenOut.address,
              amount: subAmount,
              srcDecimals: currentTokenIn.decimals.toString(),
              dstDecimals: currentTokenOut.decimals.toString(),
            })
            const res = await fetch(`/api/quote?${params}`)
            if (!res.ok) return []
            const subMeta: MetaQuoteResult = await res.json()
            return subMeta.all.filter(q => SPLIT_ELIGIBLE_SOURCES.has(q.source))
          } catch {
            return []
          }
        }

        const quoteMap = await fetchSplitQuotes(
          fetchQuoteAtAmount,
          rawAmount,
          currentMeta.all,
        )

        if (runId !== abortRef.current) return // stale

        const bestSplit = findBestSplit(quoteMap, rawAmount, currentMeta.best)

        const result: SplitQuoteResult = {
          bestSingle: currentMeta.best,
          bestSplit,
          allSingles: currentMeta.all,
          splitRecommended: bestSplit.isSplit && bestSplit.improvementBps >= SPLIT_MIN_IMPROVEMENT_BPS,
          fetchedAt: Date.now(),
        }

        setSplitResult(result)

        // Auto-enable split if recommended
        if (result.splitRecommended) {
          setUseSplit(true)
        }
      } catch {
        if (runId === abortRef.current) {
          setSplitResult(null)
        }
      } finally {
        if (runId === abortRef.current) {
          setAnalyzing(false)
        }
      }
    }

    analyze()
  }, [meta?.fetchedAt, tokenIn?.address, tokenOut?.address, amountIn, enabled, tradeAboveThreshold])

  return {
    splitResult,
    analyzing,
    splitRecommended: splitResult?.splitRecommended ?? false,
    useSplit,
    toggleSplit,
  }
}
