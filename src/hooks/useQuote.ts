import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { parseUnits } from 'viem'
import { useAccount } from 'wagmi'
import { useDebounce } from './useDebounce'
import { type MetaQuoteResult } from '@/lib/api'
import { INPUT_DEBOUNCE_MS, QUOTE_REFRESH_MS } from '@/lib/constants'
import type { Token } from '@/lib/tokens'
import { logQuoteToSupabase } from '@/lib/analytics'
import { fetchJson } from '@/lib/fetch-json'
import { analyzeGasless } from '@/lib/gasless-engine'
import { useEthGasCost } from './useEthGasCost'
import { useQuoteChainId } from './useChainId'
import { isChainActive } from '@/lib/chains'
import {
  makeQuoteKey,
  parseQuoteEcho,
  sameQuoteKey,
  sameQuotePair,
  type QuoteIdentity,
  type QuoteKey,
} from '@/lib/quote-identity'
import { createSplitPollChannel, type PolledSplit, type SplitPollChannel } from '@/lib/split-poll'
import type { SplitBatch } from '@/lib/split-routing-types'

/**
 * Typed error carrying the /api/quote HTTP status. Lets the hook
 * distinguish a 429 rate-limit response from a generic failure without
 * inspecting the message string.
 */
class QuoteApiError extends Error {
  status: number
  /** The response's X-RateLimit-Reset (epoch ms, as sent), when it had one. */
  rateLimitReset: string | null
  /** The response's Date (the server's clock, whole seconds), when it had one. */
  date: string | null
  constructor(message: string, status: number, rateLimitReset: string | null = null, date: string | null = null) {
    super(message)
    this.name = 'QuoteApiError'
    this.status = status
    this.rateLimitReset = rateLimitReset
    this.date = date
  }
}

/** [fix/stale-quote-pair-flip] Identity fields /api/quote echoes alongside the quote. */
const QUOTE_ECHO_KEYS = ['tokenIn', 'tokenOut', 'chainId', 'decimalsIn', 'decimalsOut', 'amountIn'] as const

/** [hotfix] Backoff ceiling on consecutive 429s. */
const MAX_BACKOFF_MS = 120_000

/** [fix/quote-split-followups] Added to the server's reset time, so the retry lands after the window has freed. */
const RESET_MARGIN_MS = 1_000
/** A reset further ahead than this is not one of ours (the limiter's window is 60 s). */
const MAX_RESET_AHEAD_MS = 3_600_000

/**
 * [fix/quote-split-followups] The wait a 429's X-RateLimit-Reset asks for, capped at MAX_BACKOFF_MS. Null — the caller
 * then doubles, as before — when the header is missing or absurd: not a whole number, more than an hour ahead, or past
 * by RESET_MARGIN_MS or more. A reset that passed more recently than that freed while the answer was on its way.
 * [A109 S-2] The reset is the server's time, so it is read against the response's own `date`, never against this
 * device's clock (`now`) unless Date is missing or unparseable. Date drops the milliseconds, so the wait it gives is
 * up to 1 s longer than asked, never shorter.
 */
function waitFromReset(header: string | null, date: string | null, now: number): number | null {
  if (!header || !/^\d+$/.test(header)) return null
  const sentOn = Date.parse(date ?? '')
  const ahead = Number(header) - (Number.isNaN(sentOn) ? now : sentOn)
  if (!(ahead > -RESET_MARGIN_MS && ahead <= MAX_RESET_AHEAD_MS)) return null
  return Math.min(MAX_BACKOFF_MS, Math.max(0, ahead) + RESET_MARGIN_MS)
}

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
  // [fix/quote-rate-limit-normal-use] Also price the split analysis' sub-amounts, in this same request.
  withSplit?: boolean,
): Promise<MetaQuoteResult & { split?: SplitBatch }> {
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
  if (withSplit) {
    params.set('split', '1')
  }

  // [SPRINT-9X X3] Parse via fetchJson: an HTML platform error (e.g. a 504 from a maxDuration kill)
  // yields a CLEAN typed ServiceUnavailableError + one automatic retry — never the raw
  // 'Unexpected token <, "<!DOCTYPE"... is not valid JSON'. Real JSON envelopes (429/4xx/5xx) pass
  // through so the status-based handling below (and the 429 backoff) is unchanged.
  const { res, data } = await fetchJson<MetaQuoteResult & { error?: string }>(
    `/api/quote?${params}`,
    signal ? { signal } : undefined,
  )

  if (!res.ok) {
    throw new QuoteApiError(
      data.error || `Quote API error ${res.status}`,
      res.status,
      res.headers.get('x-ratelimit-reset'),
      res.headers.get('date'),
    )
  }

  return data as MetaQuoteResult
}

/** [fix/stale-quote-pair-flip] A quote tagged with the request it answered. `split` only when this poll fetched one. */
export type TaggedMetaQuote = MetaQuoteResult & { identity: QuoteIdentity; split?: PolledSplit }

interface UseQuoteResult {
  meta: TaggedMetaQuote | null
  loading: boolean
  error: string | null
  countdown: number
  /** [fix/quote-rate-limit-normal-use] Seconds until the next try while /api/quote is rate limiting us; else null. */
  retryIn: number | null
  /** [fix/quote-rate-limit-normal-use] Where useSplitRoute asks for its refresh to ride on this hook's poll. */
  splitPoll: SplitPollChannel
  refetch: () => void
  /** Manual quote refresh trigger. No-op if a fetch is already in flight.
   *  Resets the countdown to the current poll interval (respects backoff). */
  refresh: () => void
}

export interface UseQuoteOptions {
  /**
   * [fix/privacy-no-usage-tracking A78 S-1/S-4] Record this quote in the `quotes` log (token pair, amount, the sources'
   * answers; the wallet only when one is connected). Opt-in: the swap screen passes true, the landing page's preview
   * quote does not, so a visitor who never opens the app leaves no row.
   */
  logQuote?: boolean
}

export function useQuote(
  tokenIn: Token | null,
  tokenOut: Token | null,
  amountIn: string,
  enabled: boolean,
  excludeSources?: string[],
  options?: UseQuoteOptions,
): UseQuoteResult {
  const logQuote = options?.logQuote === true
  const { address } = useAccount()
  // [P219] Active chain — switching chains supersedes the current quote (the
  // AbortController in doFetch cancels the stale in-flight request). On mainnet
  // this never changes, so quote behaviour is unchanged. End-to-end chainId →
  // /api/quote threading is deferred to the Base-activation sprint (see FEEDBACK).
  // [feat/quote-before-wallet] useQuoteChainId (not useActiveChainId) — a disconnected
  // visitor's ChainSelector pick must drive the quote, not a silent mainnet fallback.
  const activeChainId = useQuoteChainId()
  const { estimate: estimateGasCost } = useEthGasCost()
  const [storedMeta, setMeta] = useState<TaggedMetaQuote | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(QUOTE_REFRESH_MS / 1000)
  // [fix/quote-rate-limit-normal-use] True from a 429 until a success, another error or a new selection.
  const [rateLimited, setRateLimited] = useState(false)
  const [splitPoll] = useState(createSplitPollChannel)
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

  // [hotfix] Backoff state for rate-limit responses.
  // `currentIntervalMsRef` holds the effective poll interval: QUOTE_REFRESH_MS
  // (15s) normally; after a 429, the wait the response's X-RateLimit-Reset
  // gives [fix/quote-split-followups], from the second refusal in a row no less
  // than the backoff step [A109 S-1]; with no usable header, the doubling below.
  // It snaps back to the normal cadence on the first successful fetch.
  // `inBackoffRef` gates the `setError(null)` reset at the top of every
  // doFetch — without it the error toggles null → "Rate limit…" → null
  // → "Rate limit…" every poll and floods the toast layer.
  const currentIntervalMsRef = useRef(QUOTE_REFRESH_MS)
  const inBackoffRef = useRef(false)
  /** 30s/60s/120s over consecutive 429s: the wait when the server names none. Kept apart from the waits it does name. */
  const doublingMsRef = useRef(QUOTE_REFRESH_MS)
  /** When the request now on the wire was sent; null when it has been answered. */
  const sentAtRef = useRef<number | null>(null)

  const debouncedAmount = useDebounce(amountIn, INPUT_DEBOUNCE_MS)
  // [fix/stale-quote-pair-flip] Latest raw (undebounced) amount, for the pending-debounce check in doFetch.
  const amountInRef = useRef(amountIn)
  useEffect(() => {
    amountInRef.current = amountIn
  }, [amountIn])
  // [hotfix] Stable string form of excludeSources for the dep array —
  // the caller in SwapBox already memoises the array, but a missing
  // useMemo there would have re-triggered the whole effect chain. The
  // join shape (`a,b` vs `b,a` is fine — order only matters for the
  // request URL) makes the dep cheap to compare and immune to upstream
  // array-identity changes.
  const excludeKey = excludeSources?.join(',') ?? ''

  // [fix/stale-quote-pair-flip] The identity of the CURRENT selection. `meta` is
  // only ever exposed when it was fetched for this exact chain/pair/decimals, so
  // the render right after a ⇅ flip or a token/chain change can never show the
  // previous pair's raw amounts under the new pair's decimals.
  const inAddr = tokenIn?.address
  const inDec = tokenIn?.decimals
  const outAddr = tokenOut?.address
  const outDec = tokenOut?.decimals
  const currentPair = useMemo<QuoteKey | null>(
    () =>
      inAddr !== undefined && inDec !== undefined && outAddr !== undefined && outDec !== undefined
        ? makeQuoteKey({
            chainId: activeChainId,
            tokenIn: inAddr,
            tokenOut: outAddr,
            amountRaw: '',
            decimalsIn: inDec,
            decimalsOut: outDec,
          })
        : null,
    [activeChainId, inAddr, inDec, outAddr, outDec],
  )
  // The pair PLUS the settled amount: what an arriving response must match.
  const currentKey = useMemo<QuoteKey | null>(() => {
    if (!currentPair || inDec === undefined || !debouncedAmount) return null
    try {
      return { ...currentPair, amountRaw: parseUnits(debouncedAmount, inDec).toString() }
    } catch {
      return null
    }
  }, [currentPair, inDec, debouncedAmount])
  const currentKeyRef = useRef<QuoteKey | null>(currentKey)
  useEffect(() => {
    currentKeyRef.current = currentKey
  }, [currentKey])

  // A flip / token / chain change drops the stored quote (not just hides it), so
  // flipping A→B→A can't resurrect the old A quote. Amount changes keep it: the
  // same pair's quote stays on screen until the re-quote lands (unchanged UX).
  // (Reset-on-key-change during render — React's documented alternative to an
  // effect that calls setState — so the flip commits with the old quote already gone.)
  const [metaPair, setMetaPair] = useState(currentPair)
  if (metaPair !== currentPair) {
    setMetaPair(currentPair)
    setMeta(null)
  }

  const meta = useMemo(
    () => (storedMeta && currentPair && sameQuotePair(storedMeta.identity, currentPair) ? storedMeta : null),
    [storedMeta, currentPair],
  )

  // [fix/quote-split-followups] What the poll timer runs. A wait the server names can be a second or two, shorter than
  // a slow answer: while backing off, the timer never supersedes a request younger than one normal poll interval (it
  // would abort every retry before it could answer). Outside a backoff it fetches on every tick, as before.
  const onPollTimer = useCallback(() => {
    const sentAt = sentAtRef.current
    if (inBackoffRef.current && sentAt !== null && Date.now() - sentAt < QUOTE_REFRESH_MS) return
    doFetchRef.current?.()
  }, [])

  // [hotfix] Tear down + rebuild the poll timer with the current
  // backoff interval. Called when entering or leaving backoff. Reads
  // from doFetchRef so the timer always uses the latest closure even
  // though this helper is invoked from inside doFetch's own body.
  // [fix/quote-poll-visibility] A backoff-triggering response can resolve
  // after the tab was hidden (in-flight fetches are never aborted on hide —
  // see the visibility effect below). In that case don't rearm the interval
  // — it would just be cleared again by the hide path having already run, or
  // worse, tick in the background. The visibilitychange handler restarts
  // polling (at whatever currentIntervalMsRef now holds) when the tab comes
  // back.
  const rearmPollTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    setCountdown(Math.ceil(currentIntervalMsRef.current / 1000))
    if (typeof document !== 'undefined' && document.hidden) return
    intervalRef.current = setInterval(onPollTimer, currentIntervalMsRef.current)
  }, [onPollTimer])

  const doFetch = useCallback(async () => {
    // [fix/stale-quote-pair-flip] A debounce is pending (the typed amount hasn't settled): the
    // settled amount is the PREVIOUS one, so a fetch now would quote it under the new pair's
    // decimals (⇅ flip: 1 000 000 USDC re-read as ETH) and cost a /api/quote hit (30/min/IP) for
    // a result we'd discard. The settle changes doFetch's identity and fetches exactly once.
    // Read via ref so this doesn't churn doFetch's identity on every keystroke.
    if (amountInRef.current !== debouncedAmount) return

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
    sentAtRef.current = startTime
    let requestKey: QuoteKey | null = null
    try {
      const rawAmount = parseUnits(debouncedAmount, tokenIn.decimals).toString()
      requestKey = makeQuoteKey({
        chainId: activeChainId,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountRaw: rawAmount,
        decimalsIn: tokenIn.decimals,
        decimalsOut: tokenOut.decimals,
      })
      const withSplit = splitPoll.wants(requestKey)
      const result = await fetchQuoteViaApi(
        tokenIn.address,
        tokenOut.address,
        rawAmount,
        tokenIn.decimals,
        tokenOut.decimals,
        excludeSources,
        activeChainId,
        signal,
        withSplit,
      )
      const receivedAt = Date.now()

      // [P94] Compute the gasless recommendation client-side so it uses the
      // current ETH price + gas price (the server doesn't have either).
      // The best non-CoW quote is what the user would otherwise execute,
      // so its gas estimate sets the savings figure. Read the latest
      // estimate via ref so this doesn't pull stale wagmi state.
      const bestNonCow = result.all.find((q) => q.source !== 'cowswap')
      const refGas = bestNonCow ? estimateGasCostRef.current(bestNonCow.estimatedGas) : null
      const refGasUsd = refGas?.usd ?? bestNonCow?.gasUsd ?? 0
      const gasless = analyzeGasless(result.all, refGasUsd)

      // [fix/stale-quote-pair-flip] The response states what it answers (echoed by
      // /api/quote). It is stored only if (a) it names a usable identity, (b) its
      // request was not superseded, and (c) that identity IS the current selection +
      // settled amount. Without (c) a late old-pair response repainted after a ⇅ flip.
      const responseKey = parseQuoteEcho(result)
      if (!responseKey) throw new QuoteApiError('Failed to fetch quotes', 502)
      if (signal.aborted || !currentKeyRef.current || !sameQuoteKey(responseKey, currentKeyRef.current)) {
        return
      }
      // The echo fields are routing metadata, not part of the quote itself.
      const quote: Record<string, unknown> = { ...result }
      for (const k of QUOTE_ECHO_KEYS) delete quote[k]
      delete quote.split
      const polled: PolledSplit | undefined = withSplit && result.split ? { ...result.split, receivedAt } : undefined
      setMeta({ ...(quote as unknown as MetaQuoteResult), gasless, identity: { ...responseKey, fetchedAt: result.fetchedAt }, ...(polled ? { split: polled } : {}) })
      // [hotfix] First success after backoff — snap back to the normal
      // cadence and clear the error in one shot (we skipped that reset
      // at the top of this call). If we weren't in backoff, the
      // countdown reset is the only side effect.
      if (inBackoffRef.current) {
        inBackoffRef.current = false
        currentIntervalMsRef.current = QUOTE_REFRESH_MS
        setError(null)
        setRateLimited(false)
        rearmPollTimer()
      }
      setCountdown(QUOTE_REFRESH_MS / 1000)

      // Swap-screen quotes only (see UseQuoteOptions.logQuote). Fire-and-forget; `wallet` is undefined when no wallet is
      // connected, so JSON.stringify drops the field and the row carries no identifier.
      if (logQuote) {
        logQuoteToSupabase({
          tokenIn,
          tokenOut,
          amountIn: rawAmount,
          meta: result,
          responseTimeMs: Date.now() - startTime,
          wallet: address,
        })
      }
    } catch (err) {
      // [P208] A superseded request — do nothing. A newer fetch is already
      // in flight and owns the error/meta/loading state. Crucially this must
      // NOT trigger backoff: an abort is not a rate limit.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      // [fix/quote-rate-limit-normal-use] Same rule when the refusal itself had already arrived: a failure for a request
      // that was superseded, or for a selection that is no longer on screen, must not start a backoff or paint an error.
      if (signal.aborted) return
      if (requestKey && (!currentKeyRef.current || !sameQuoteKey(requestKey, currentKeyRef.current))) return
      // [hotfix] Treat HTTP 429 distinctly: enter (or extend) backoff,
      // wait as long as the server says (never under the step below) — or
      // double, up to MAX_BACKOFF_MS, when it does not — and rearm the timer. Other
      // errors keep the normal cadence — backoff is reserved for
      // explicit rate limits.
      const rateLimit = err instanceof QuoteApiError && err.status === 429 ? err : null
      const isRateLimit = rateLimit !== null
      if (rateLimit) {
        const wasInBackoff = inBackoffRef.current
        inBackoffRef.current = true
        // [A109 S-1] The reset says when ONE slot frees, not when this tab is served: on a crowded address the others
        // take it, so a tab refused again must slow down whatever the header says. The step under this refusal is none
        // for the first in a row (a lone visitor recovers at the header's time), then 30, 60, 120 s: the doubling as
        // it stood after the refusal before this one.
        const stepMs = wasInBackoff ? doublingMsRef.current : 0
        doublingMsRef.current = Math.min(
          MAX_BACKOFF_MS,
          wasInBackoff ? doublingMsRef.current * 2 : QUOTE_REFRESH_MS * 2,
        )
        const askedMs = waitFromReset(rateLimit.rateLimitReset, rateLimit.date, Date.now())
        currentIntervalMsRef.current = askedMs === null ? doublingMsRef.current : Math.max(askedMs, stepMs)
        rearmPollTimer()
      } else if (inBackoffRef.current) {
        // Non-429 error during a prior backoff — clear the backoff
        // flag so a transient network blip doesn't leave us stuck at
        // a 120s cadence after the rate limit lifts.
        inBackoffRef.current = false
        currentIntervalMsRef.current = QUOTE_REFRESH_MS
        rearmPollTimer()
      }
      setRateLimited(isRateLimit)
      setError(err instanceof Error ? err.message : 'Failed to fetch quotes')
      setMeta(null)
    } finally {
      // [P208] Only the request that's still current clears the spinner. If
      // this request was superseded (signal aborted), the newer one owns the
      // loading flag — clearing it here would flip the spinner off mid-fetch.
      if (!signal.aborted) {
        sentAtRef.current = null
        setLoading(false)
      }
    }
  // [fix/quote-identity-loop] Keyed on the VALUES that actually change a quote —
  // address/decimals, not the token object references. getChainTokenList()
  // rebuilds token objects via .map() on every call for non-mainnet chains, so a
  // caller re-resolving an equivalent token (e.g. LandingPage's preview pair) was
  // handing this callback a new object identity every render. That churned
  // doFetch's identity, which re-ran the polling effect below (:302), which calls
  // doFetch() synchronously in its body — an unbounded fetch loop on any chain
  // whose token list isn't the stable DEFAULT_TOKENS array (see INC for the prod
  // incident this caused on Base/Arbitrum).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tokenIn?.address,
    tokenIn?.decimals,
    tokenOut?.address,
    tokenOut?.decimals,
    debouncedAmount,
    address,
    excludeKey,
    rearmPollTimer,
    activeChainId,
    logQuote,
    splitPoll,
  ])

  // [fix/quote-rate-limit-normal-use] What a rate-limit backoff belongs to: the chain, the pair and the SETTLED amount.
  // (Not the wallet or the source filter, which also rebuild doFetch.)
  const selection = `${activeChainId}|${inAddr}|${inDec}|${outAddr}|${outDec}|${debouncedAmount}`
  const selectionRef = useRef(selection)

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
      setRateLimited(false)
      return
    }

    // [fix/quote-rate-limit-normal-use] A new pair, amount or chain is a new question: drop the old one's backoff and its
    // error, so startTimers() below asks at once on the normal cadence. Before this, the wait (up to 120 s) and "Rate
    // limit exceeded" followed the user from pair to pair until the Swap tab was left.
    if (selectionRef.current !== selection) {
      selectionRef.current = selection
      if (inBackoffRef.current) {
        inBackoffRef.current = false
        currentIntervalMsRef.current = QUOTE_REFRESH_MS
        setCountdown(QUOTE_REFRESH_MS / 1000)
      }
      setRateLimited(false)
      setError(null)
    }

    // [fix/quote-poll-visibility] Quotes now render for anonymous visitors
    // (feat/quote-before-wallet), so this poll runs on the landing page for
    // every visitor, not just a connected wallet mid-swap. A hidden tab has
    // nobody reading the number, so both the poll and the 1s countdown
    // ticker (which exists purely to paint that number) are pure cost with
    // no payoff — start/stop both with the Page Visibility API rather than
    // a focus/mouse heuristic, which fires on unrelated events (e.g.
    // switching windows on a multi-monitor setup while still "looking" at
    // the tab isn't hidden; alt-tabbing away is).
    const stopTimers = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current)
        countdownRef.current = null
      }
    }

    // [fix/quote-poll-visibility] Idempotent: calls stopTimers() first so
    // two consecutive "visible" signals (e.g. a bfcache restore firing both
    // `visibilitychange` and `pageshow`) can't overwrite intervalRef/
    // countdownRef with fresh handles while the previous pair is still
    // running — that would orphan the old interval with no reference left
    // to clear it, doubling the poll permanently. Don't rely on the caller
    // only ever invoking this on a hidden→visible transition.
    const startTimers = () => {
      stopTimers()
      doFetchRef.current?.()
      intervalRef.current = setInterval(onPollTimer, currentIntervalMsRef.current)
      countdownRef.current = setInterval(() => {
        // [hotfix] Read the live interval so the countdown reflects the
        // current backoff window (rolling over to 120s when rate-limited).
        setCountdown((prev) => (prev <= 1
          ? Math.ceil(currentIntervalMsRef.current / 1000)
          : prev - 1))
      }, 1000)
    }

    // [fix/quote-poll-visibility] Resuming fetches IMMEDIATELY (not waiting
    // out the remaining interval) so a returning user never stares at a
    // stale quote. Thundering-herd note (FEEDBACK): this hook has no
    // client-side jitter on that resume fetch — coalescing already happens
    // server-side. /api/quote's process-local dampener (route.ts,
    // DAMPENER_TTL_MS=5s) coalesces concurrent requests for the same
    // (pair, amount, chain) key within a 5s window into one upstream call,
    // and the KV cache (12s TTL) serves identical requests beyond that
    // without hitting a source at all. Many tabs/devices for the same pair
    // waking at once collapses into that existing cache path — untouched
    // per the Do NOT list — rather than a new client-side stagger.
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopTimers()
      } else {
        startTimers()
      }
    }

    // [fix/quote-poll-visibility] This effect only runs client-side (React
    // effects never run during SSR), so `document` is always defined here —
    // unlike rearmPollTimer, which is also invoked synchronously from
    // inside doFetch and so keeps its own `typeof document` guard. No such
    // dead branch here: an `undefined` document would make the next line
    // (addEventListener) throw regardless, so a guard that skipped
    // startTimers() but not that call would be false safety.
    if (!document.hidden) {
      startTimers()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      stopTimers()
      // [P208] Cancel any pending request so an unmount (or enabled flip)
      // can't resolve into a state update on a torn-down hook.
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [doFetch, enabled, selection, onPollTimer])

  // Manual refresh: invoke the latest doFetch via the ref (matches the
  // timer's call site), and reset the countdown so the next visible tick
  // reflects "just refreshed". [P208] doFetch now aborts any in-flight
  // request and supersedes it, so a click always issues a fresh quote
  // rather than being dropped while one is on the wire.
  const refresh = useCallback(() => {
    doFetchRef.current?.()
    setCountdown(Math.ceil(currentIntervalMsRef.current / 1000))
  }, [])

  const retryIn = rateLimited && error ? countdown : null

  return { meta, loading, error, countdown, retryIn, splitPoll, refetch: doFetch, refresh }
}
