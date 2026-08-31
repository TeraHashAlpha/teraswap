import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { parseUnits, formatUnits } from 'viem'
import type { MetaQuoteResult, NormalizedQuote } from '@/lib/api'
import type { Token } from '@/lib/tokens'
import { fetchSplitQuotes, findBestSplit } from '@/lib/split-router'
import { safeBigInt } from '@/lib/utils'
import { isExecutableSource } from '@/lib/executable-sources'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { isUsdStablecoin } from '@/lib/chains/stablecoins'
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
  // [CHORE-SUSHI-V7] Active chain — split legs EXECUTE per source, so a
  // quote-only source on this chain (no SC-04 selector / R1 decoder /
  // on-chain whitelist — e.g. Sushi v7/RedSnwapper) must not be offered as
  // a leg: one such leg would fail the whole split at the client selector
  // gate. Passed in (rather than read via wagmi) so the hook stays
  // renderable without a provider; SwapBox supplies useQuoteChainId()
  // [feat/quote-before-wallet] — the quote/browse chain, not just the wallet's.
  chainId: number = DEFAULT_CHAIN_ID,
): UseSplitRouteResult {
  const [splitResult, setSplitResult] = useState<SplitQuoteResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [useSplit, setUseSplit] = useState(false)
  const abortRef = useRef(0)

  // Estimate trade USD value using Chainlink
  const executionPriceUsd = useMemo(() => {
    if (!meta?.best || !tokenIn || !tokenOut || !amountIn) return null
    // [11-L-01] safeBigInt: malformed toAmount → fall back to 0 (price will compare as null/below-threshold).
    const outBig = safeBigInt(meta.best.toAmount)
    const outAmount = outBig !== null ? Number(formatUnits(outBig, tokenOut.decimals)) : 0
    const inAmount = Number(amountIn)
    if (inAmount <= 0) return null
    // [CHORE-STABLECOIN-CONSTANT] ~$1 membership is chain-keyed (single source of truth).
    // If output token is a stablecoin on this chain, output amount ≈ USD
    if (isUsdStablecoin(tokenOut.symbol, chainId)) return outAmount
    // If input token is a stablecoin on this chain, input amount ≈ USD
    if (isUsdStablecoin(tokenIn.symbol, chainId)) return inAmount
    return null
    // [fix/quote-identity-loop] Keyed on token VALUES, not object identity — see useQuote.ts.
    // This memo doesn't itself loop (its output is stable across equivalent-object renders,
    // so tradeAboveThreshold below never flips), but it's the same anti-pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, tokenIn?.symbol, tokenOut?.symbol, tokenOut?.decimals, amountIn, chainId])

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
            // [CHORE-SPLITROUTE-CHAINID] Price sub-legs on the ACTIVE chain.
            // Same P219 convention as useQuote (this endpoint's primary
            // caller): append the param only off-mainnet so the mainnet
            // request stays byte-identical — /api/quote's P217 default IS
            // chain 1. Omitting this priced Base sub-legs on MAINNET (502s
            // for Base-only addresses → split routing silently dead on Base;
            // mainnet-priced analyses for same-address tokens). Triage:
            // PR #262 (audit/splitroute-chain-awareness, W4-followup report).
            if (chainId !== DEFAULT_CHAIN_ID) params.set('chainId', String(chainId))
            const res = await fetch(`/api/quote?${params}`)
            if (!res.ok) return []
            const subMeta: MetaQuoteResult = await res.json()
            return subMeta.all.filter(q => SPLIT_ELIGIBLE_SOURCES.has(q.source) && isExecutableSource(q.source, chainId))
          } catch {
            return []
          }
        }

        const quoteMap = await fetchSplitQuotes(
          fetchQuoteAtAmount,
          rawAmount,
          // [CHORE-SUSHI-V7] Seed only with legs that can settle on this chain.
          currentMeta.all.filter(q => isExecutableSource(q.source, chainId)),
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
  }, [meta?.fetchedAt, tokenIn?.address, tokenOut?.address, amountIn, enabled, tradeAboveThreshold, chainId])

  return {
    splitResult,
    analyzing,
    splitRecommended: splitResult?.splitRecommended ?? false,
    useSplit,
    toggleSplit,
  }
}
