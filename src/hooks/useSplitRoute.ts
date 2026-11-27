import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { parseUnits, formatUnits } from 'viem'
import type { MetaQuoteResult, NormalizedQuote } from '@/lib/api'
import type { Token } from '@/lib/tokens'
import { fetchSplitQuotes, findBestSplit } from '@/lib/split-router'
import { safeBigInt } from '@/lib/utils'
import { isExecutableSource } from '@/lib/executable-sources'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { isUsdStablecoin } from '@/lib/chains/stablecoins'
import { makeQuoteKey, sameQuoteKey, type QuoteKey } from '@/lib/quote-identity'
import type { PolledSplit, SplitPollChannel } from '@/lib/split-poll'
import {
  type SplitBatch,
  type SplitQuoteResult,
  SPLIT_MIN_USD,
  SPLIT_MIN_IMPROVEMENT_BPS,
  SPLIT_ELIGIBLE_SOURCES,
  SPLIT_SETTLE_MS,
  SPLIT_UNSELECTED_REFRESH_MS,
  isSplitQuoteStale,
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
  /**
   * [fix/quote-rate-limit-normal-use] Swap found the split sub-quotes too old to execute: select the single route, and
   * keep a later recommendation for this same trade from re-selecting the split (the user still can).
   */
  fallBackToSingle: () => void
}

/** The quote useSplitRoute is given: tagged with what it answers, and carrying a split batch when its poll fetched one. */
type SeedQuote = MetaQuoteResult & { identity?: QuoteKey; split?: PolledSplit }

/** A split batch and when it reached the browser (the age Swap checks is measured from this). */
interface LoadedBatch {
  batch: SplitBatch
  receivedAt: number
}

/** The cadence bookkeeping of ONE trade (chain, pair, amount). A new trade gets a new object. */
interface TradeRun {
  /** When the last analysis attempt ended; 0 = none yet. */
  ranAt: number
  /** The split bucket was spent: do not ask before this. 0 = no wait. */
  retryAt: number
  inFlight: boolean
  /** The newest attempt: an older one that ends later is dropped. */
  sequence: number
  /** The poll batch already consumed. */
  polledAt: number
  /** Switched off by hand, or by Swap's fallback to the single route: do not auto-select the split again for this trade. */
  heldOff: boolean
}

const newTradeRun = (): TradeRun => ({ ranAt: 0, retryAt: 0, inFlight: false, sequence: 0, polledAt: 0, heldOff: false })

/**
 * Analyzes whether splitting the trade across multiple DEXes yields better output.
 * Only activates for trades above SPLIT_MIN_USD threshold.
 *
 * [fix/quote-rate-limit-normal-use] An analysis costs ONE /api/quote request (`split=1`; it used to be 11, on every new
 * quote). It runs when the pair or the settled amount has held SPLIT_SETTLE_MS, on a quote that answers exactly that
 * trade. After that, while a split is the selected route its refresh rides on every quote poll (`splitPoll`), so the
 * sub-quotes Swap executes are never older than one poll. While none is selected, it is a request of its own, at most
 * once per SPLIT_UNSELECTED_REFRESH_MS [fix/quote-split-followups, A108 S-1]: the screen's quote poll never waits for
 * split work nobody selected. The quotes, the router and the execution path are unchanged.
 *
 * @param meta — existing MetaQuoteResult from useQuote
 * @param tokenIn — sell token
 * @param tokenOut — buy token
 * @param amountIn — human-readable amount
 * @param enabled — whether to analyze (connected, correct chain, etc.)
 */
export function useSplitRoute(
  meta: SeedQuote | null,
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
  /** useQuote's channel, for a selected split. Without one, every due refresh is asked for on its own on a new quote. */
  splitPoll?: SplitPollChannel,
): UseSplitRouteResult {
  // The trade an analysis belongs to. Null while disabled or while the amount is not a number.
  const tradeKey = useMemo<QuoteKey | null>(() => {
    if (!enabled || !tokenIn || !tokenOut || !amountIn) return null
    try {
      const amountRaw = parseUnits(amountIn, tokenIn.decimals).toString()
      return makeQuoteKey({ chainId, tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountRaw, decimalsIn: tokenIn.decimals, decimalsOut: tokenOut.decimals })
    } catch {
      return null
    }
    // [fix/quote-identity-loop] Keyed on token VALUES, not object identity — see useQuote.ts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tokenIn?.address, tokenIn?.decimals, tokenOut?.address, tokenOut?.decimals, amountIn, chainId])
  const tradeId = tradeKey ? Object.values(tradeKey).join('|') : null

  // A quote is analysed only if it answers THIS trade. v1 keeps the previous amount's quote on screen while a new
  // amount is typed: read as this trade's, it sized the new amount by the old output and sent 11 requests a keystroke.
  // (useQuote tags every quote; an untagged one has nothing to compare.)
  const seed = meta && tradeKey && (!meta.identity || sameQuoteKey(meta.identity, tradeKey)) ? meta : null

  // Estimate trade USD value using Chainlink
  const executionPriceUsd = useMemo(() => {
    if (!seed?.best || !tokenIn || !tokenOut || !amountIn) return null
    // [11-L-01] safeBigInt: malformed toAmount → fall back to 0 (price will compare as null/below-threshold).
    const outBig = safeBigInt(seed.best.toAmount)
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
  }, [seed, tokenIn?.symbol, tokenOut?.symbol, tokenOut?.decimals, amountIn, chainId])

  const tradeAboveThreshold = executionPriceUsd !== null && executionPriceUsd >= SPLIT_MIN_USD

  const [analysis, setAnalysis] = useState<{ tradeId: string; result: SplitQuoteResult } | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [useSplit, setUseSplit] = useState(false)
  /** The trade that has held SPLIT_SETTLE_MS. */
  const [settledId, setSettledId] = useState<string | null>(null)

  // A new trade drops the old analysis and selection in the same render (never a split of another pair or amount).
  const [stateTradeId, setStateTradeId] = useState(tradeId)
  if (stateTradeId !== tradeId) {
    setStateTradeId(tradeId)
    setAnalysis(null)
    setAnalyzing(false)
    setUseSplit(false)
    setSettledId(null)
  }

  const splitResult = analysis && analysis.tradeId === tradeId && seed && tradeAboveThreshold ? analysis.result : null

  const runRef = useRef<TradeRun>(newTradeRun())
  const selectedRef = useRef(useSplit)
  // What the poll channel and the click handlers read: the state as last committed.
  const latestRef = useRef({ tradeKey, tradeId, seed, tradeAboveThreshold, analysis, eligible: false })
  useEffect(() => {
    selectedRef.current = useSplit
    // `eligible` is only re-judged on a quote: one that drops out for a poll does not change the trade's size.
    const sameTrade = latestRef.current.tradeId === tradeId
    const eligible = seed ? tradeAboveThreshold : sameTrade && latestRef.current.eligible
    latestRef.current = { tradeKey, tradeId, seed, tradeAboveThreshold, analysis, eligible }
  })

  useEffect(() => {
    runRef.current = newTradeRun()
    if (!tradeId) return
    const timer = setTimeout(() => setSettledId(tradeId), SPLIT_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [tradeId])

  /** One analysis of `seedQuote`, with the sub-amount quotes `load` brings. Same router, same filters as before. */
  const analyse = useCallback(
    async (id: string, amountRaw: string, seedQuote: SeedQuote, load: () => Promise<LoadedBatch | null>) => {
      const run = runRef.current
      const sequence = ++run.sequence
      const current = () => runRef.current === run && run.sequence === sequence
      run.inFlight = true
      setAnalyzing(true)
      // The router asks per sub-amount; the first ask loads the one batch, the rest read from it.
      let loading: Promise<LoadedBatch | null> | null = null
      const batch = () => (loading ??= load().catch(() => null))
      try {
        const quoteMap = await fetchSplitQuotes(
          async (subAmount: string): Promise<NormalizedQuote[]> => {
            const loaded = await batch()
            if (loaded?.batch.status !== 'ok') return []
            return (loaded.batch.quotes[subAmount] ?? []).filter(q => SPLIT_ELIGIBLE_SOURCES.has(q.source) && isExecutableSource(q.source, chainId))
          },
          amountRaw,
          // [CHORE-SUSHI-V7] Seed only with legs that can settle on this chain.
          seedQuote.all.filter(q => isExecutableSource(q.source, chainId)),
        )
        const loaded = loading ? await (loading as Promise<LoadedBatch | null>) : undefined

        if (!current()) return // stale

        run.ranAt = Date.now()
        // Refused or failed: nothing was priced, so the last analysis stays (and ages). Not a "no split" answer.
        // A deferral's wait is used up either way: left behind, it would make every later quote look overdue.
        if (loaded === null) {
          run.retryAt = 0
          return
        }
        if (loaded?.batch.status === 'deferred') {
          run.retryAt = loaded.receivedAt + loaded.batch.retryAfterMs
          return
        }
        run.retryAt = 0

        const bestSplit = findBestSplit(quoteMap, amountRaw, seedQuote.best)

        const result: SplitQuoteResult = {
          bestSingle: seedQuote.best,
          bestSplit,
          allSingles: seedQuote.all,
          splitRecommended: bestSplit.isSplit && bestSplit.improvementBps >= SPLIT_MIN_IMPROVEMENT_BPS,
          fetchedAt: loaded?.receivedAt ?? Date.now(),
        }

        setAnalysis({ tradeId: id, result })

        // Auto-enable split if recommended
        if (result.splitRecommended && !run.heldOff) {
          selectedRef.current = true
          setUseSplit(true)
        }
      } catch {
        if (current()) {
          run.ranAt = Date.now()
          setAnalysis(null)
        }
      } finally {
        if (current()) {
          run.inFlight = false
          setAnalyzing(false)
        }
      }
    },
    [chainId],
  )

  /** The batch as a request of its own: the analysis of a new trade, or a refresh no poll can carry. */
  const requestBatch = useCallback(
    async (key: QuoteKey): Promise<LoadedBatch | null> => {
      if (!tokenIn || !tokenOut) return null
      const params = new URLSearchParams({
        src: tokenIn.address,
        dst: tokenOut.address,
        amount: key.amountRaw,
        srcDecimals: tokenIn.decimals.toString(),
        dstDecimals: tokenOut.decimals.toString(),
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
      params.set('split', '1')
      const res = await fetch(`/api/quote?${params}`)
      if (!res.ok) return null
      const body: { split?: SplitBatch } = await res.json()
      return body.split ? { batch: body.split, receivedAt: Date.now() } : null
    },
    // [fix/quote-identity-loop] Keyed on token VALUES, not object identity — see useQuote.ts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tokenIn?.address, tokenIn?.decimals, tokenOut?.address, tokenOut?.decimals, chainId],
  )

  /** Is a split the route Swap would execute? */
  const splitSelected = useCallback(
    (): boolean => selectedRef.current && latestRef.current.analysis?.result.bestSplit.isSplit === true,
    [],
  )

  /** Is a refresh due? The rule behind both ways a refresh can happen. */
  const refreshDue = useCallback((): boolean => {
    const run = runRef.current
    if (run.inFlight || run.ranAt === 0) return false // a trade's first analysis is the hook's own request
    if (run.retryAt) return Date.now() >= run.retryAt
    return splitSelected() || Date.now() - run.ranAt >= SPLIT_UNSELECTED_REFRESH_MS
  }, [splitSelected])

  // While a split is SELECTED, the next quote poll for this very trade carries the refresh when one is due. Otherwise no
  // poll does: it would answer only after the slowest sub-amount [fix/quote-split-followups, A108 S-1].
  useEffect(
    () =>
      splitPoll?.register((key) => {
        const now = latestRef.current
        return !!now.tradeKey && now.eligible && sameQuoteKey(key, now.tradeKey) && splitSelected() && refreshDue()
      }),
    [splitPoll, splitSelected, refreshDue],
  )

  useEffect(() => {
    if (!tradeId || !tradeKey || !seed || !tradeAboveThreshold) return
    const run = runRef.current
    const polled = seed.split
    if (polled && polled.receivedAt !== run.polledAt) {
      run.polledAt = polled.receivedAt
      analyse(tradeId, tradeKey.amountRaw, seed, async () => ({ batch: polled, receivedAt: polled.receivedAt }))
      return
    }
    if (settledId !== tradeId || run.inFlight) return
    // A due refresh is asked for here, on a new quote, unless a poll is the one to carry it.
    if (run.ranAt === 0 || (!(splitPoll && splitSelected()) && refreshDue())) {
      analyse(tradeId, tradeKey.amountRaw, seed, () => requestBatch(tradeKey))
    }
    // Runs once per settled trade and once per new quote (`seed` is a new object every render in some callers).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeId, settledId, seed?.fetchedAt, seed?.split?.receivedAt, tradeAboveThreshold])

  const toggleSplit = useCallback(() => {
    const next = !selectedRef.current
    selectedRef.current = next
    setUseSplit(next)
    const run = runRef.current
    // [fix/quote-split-followups] A choice made by hand holds for this trade: switched off, no later recommendation
    // switches it back on. A new pair or amount is a new `run`, so the choice resets with it.
    run.heldOff = !next
    if (!next) return
    // Selected on an analysis too old to execute: refresh it now rather than at the next poll (not while a deferral runs).
    const now = latestRef.current
    if (now.tradeKey && now.tradeId && now.seed && now.analysis && !run.inFlight && Date.now() >= run.retryAt && isSplitQuoteStale(now.analysis.result)) {
      const key = now.tradeKey
      analyse(now.tradeId, key.amountRaw, now.seed, () => requestBatch(key))
    }
  }, [analyse, requestBatch])

  const fallBackToSingle = useCallback(() => {
    runRef.current.heldOff = true
    selectedRef.current = false
    setUseSplit(false)
  }, [])

  return {
    splitResult,
    analyzing,
    splitRecommended: splitResult?.splitRecommended ?? false,
    useSplit,
    toggleSplit,
    fallBackToSingle,
  }
}
