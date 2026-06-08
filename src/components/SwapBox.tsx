'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAccount, useBalance } from 'wagmi'
import { formatUnits, parseUnits } from 'viem'
import TokenSelector from './TokenSelector'
import QuoteBreakdown from './QuoteBreakdown'
import SwapButton from './SwapButton'
import TransactionPreview from './TransactionPreview'
import SplitReviewModal from './SplitReviewModal'
import CowOrderReviewModal from './CowOrderReviewModal'
import SlippageModal, { calculateAutoSlippage } from './SlippageModal'
import SourceToggle from './SourceToggle'
import { shouldShowSourceToggle } from '@/lib/ui/source-toggle-visibility'
import ActiveApprovals from './ActiveApprovals'
import { useQuote } from '@/hooks/useQuote'
import { useSwap, type SwapStatus } from '@/hooks/useSwap'
import { orderFallbackSources } from '@/lib/swap-fallback'
import { useApproval } from '@/hooks/useApproval'
import Permit2EducationModal from '@/components/Permit2EducationModal'
import TokenAddressBadge from '@/components/TokenAddressBadge'
import DigitRoller from '@/components/DigitRoller'
import { useChainlinkPrice } from '@/hooks/useChainlinkPrice'
import { useDepegCheck } from '@/hooks/useDepegCheck'
import { evaluatePriceGate } from '@/lib/price-gate'
import { evaluatePairOracle } from '@/lib/chainlink'
import InfoTooltip from '@/components/InfoTooltip'
import { useSwapHistory } from '@/hooks/useSwapHistory'
import { setParticleTurbo } from './ParticleNetwork'
// analytics-tracker removed (dead code — server-side /api/analytics is the source of truth)
// Security tracking moved server-side — events are recorded by /api/log-swap
import { useActiveApprovals } from '@/hooks/useActiveApprovals'
import { useSplitRoute } from '@/hooks/useSplitRoute'
import { useSplitSwap } from '@/hooks/useSplitSwap'
import SplitRouteVisualizer from './SplitRouteVisualizer'
import { findToken, isNativeETH, type Token } from '@/lib/tokens'
import { DEFAULT_SLIPPAGE, ETHERSCAN_TX, COW_VAULT_RELAYER, AGGREGATOR_META, UNVERIFIED_SWAP_WARN_USD, UNVERIFIED_SWAP_BLOCK_USD, MEV_PREFERENCE_THRESHOLD, PRICE_IMPACT_CONSENT_TOLERANCE, DEPEG_CONSENT_TOLERANCE } from '@/lib/constants'
import { isTrustedSpender } from '@/lib/trusted-addresses'
import { useActiveChainId } from '@/hooks/useChainId'
import { isChainActive, getChainConfig, remapTokenToChain } from '@/lib/chains'
import { estimateMevSavings } from '@/lib/mev-savings'
import { selectBestWithMevPreference } from '@/lib/mev-preference'
import { updateSwapStatus } from '@/lib/analytics'
import { formatWithSeparator, stripSeparator, formatDisplay } from '@/lib/format'
import { safeBigInt } from '@/lib/utils'
import { playSwapConfirmMP3, playCancelOrderMP3, playQuoteReceived, startWaitingSound, stopWaitingSound } from '@/lib/sounds'
import { useToast } from '@/components/ToastProvider'
import { QuoteBreakdownSkeleton } from '@/components/Skeleton'
import { useEthGasCost } from '@/hooks/useEthGasCost'
import { trackWalletActivity } from '@/lib/wallet-activity-tracker'
import BetaDisclaimer from './BetaDisclaimer'

export default function SwapBox() {
  const [tokenIn, setTokenIn] = useState<Token | null>(findToken('ETH') ?? null)
  const [tokenOut, setTokenOut] = useState<Token | null>(findToken('USDC') ?? null)
  const [displayAmountIn, setDisplayAmountIn] = useState('')
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE)
  const [isAutoSlippage, setIsAutoSlippage] = useState(true)
  const [showSlippage, setShowSlippage] = useState(false)
  const [spender, setSpender] = useState<`0x${string}` | undefined>()
  const [mevProtected, setMevProtected] = useState(false)
  // [hotfix-ui] Dismissal flag for the MEV-exposure hint below the swap
  // button. Persisted in localStorage so a user who's already decided
  // they don't want MEV protection isn't pestered every session.
  const MEV_HINT_DISMISSED_KEY = 'teraswap:mev-hint-dismissed'
  const [mevHintDismissed, setMevHintDismissed] = useState(false)
  useEffect(() => {
    // localStorage read happens in a useEffect so SSR doesn't crash on
    // the missing `window`. Default to "not dismissed" until we know.
    try {
      if (localStorage.getItem(MEV_HINT_DISMISSED_KEY) === '1') {
        setMevHintDismissed(true)
      }
    } catch {
      // Storage disabled / private mode — treat as not dismissed.
    }
  }, [])
  const dismissMevHint = useCallback(() => {
    setMevHintDismissed(true)
    try {
      localStorage.setItem(MEV_HINT_DISMISSED_KEY, '1')
    } catch {
      // Persisting failed — session-only dismissal is still useful.
    }
  }, [])
  const [excludedSources, setExcludedSources] = useState<Set<string>>(new Set())
  // Tracks whether priceCheck data is stale relative to the current sell amount.
  // Set true when the amount changes; cleared once a fresh `meta` (quote) resolves.
  // Used to suppress the price-deviation banner from flashing on stale data.
  const [priceCheckStale, setPriceCheckStale] = useState(false)
  // [SPRINT-9J J1] Informed consent for a price-impact deviation. A healthy-oracle
  // deviation is the trade's OWN price impact (slippage the user accepts), not an
  // oracle-safety event — so it is acceptable via this checkbox rather than an
  // indefinite block. [review F1] We store the ACCEPTED deviation (not a bare
  // boolean) so consent auto-arms again if a quote refresh escalates the impact
  // beyond what the user accepted. Reset to null on every trade-parameter change.
  const [acceptedDeviation, setAcceptedDeviation] = useState<number | null>(null)

  // [SPRINT-9W-oracle] Informed consent for a cbETH depeg (market-vs-exchange-rate divergence) — a
  // SECOND, independent verdict alongside acceptedDeviation. Same shape (store the ACCEPTED
  // divergence so consent auto-arms again if it worsens) and same reset-on-trade-param-change rule.
  const [acceptedDepeg, setAcceptedDepeg] = useState<number | null>(null)

  const handleSourceToggle = useCallback((source: string) => {
    setExcludedSources(prev => {
      const next = new Set(prev)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })
  }, [])

  // Recalculate auto-slippage when token pair changes
  useEffect(() => {
    if (isAutoSlippage && tokenIn && tokenOut) {
      setSlippage(calculateAutoSlippage(tokenIn.symbol, tokenOut.symbol))
    }
  }, [isAutoSlippage, tokenIn?.symbol, tokenOut?.symbol])

  // Raw amount without separators — used for all calculations
  const amountIn = stripSeparator(displayAmountIn)

  const { address, isConnected, chain } = useAccount()
  // [Sprint 45] "Correct chain" = the wallet is on a SUPPORTED + ACTIVE chain
  // (one whose FeeCollector is deployed), not strictly mainnet. This lets Base —
  // and any future activated L2 — drive quotes/balances instead of forcing
  // "Switch to Ethereum". On a coming-soon chain isChainActive is false, so the
  // existing coming-soon UX (banner + disabled swap) is preserved unchanged.
  const isCorrectChain = !!chain && isChainActive(chain.id)

  // [SPRINT-9F bug4] Active chain id — also feeds the chain-aware spender
  // allowlist + token remap below. Declared here so the balance query targets
  // the chain the user is actually on; switching networks now re-reads the
  // correct balance instead of the stale connected-by-default (mainnet) one.
  const activeChainId = useActiveChainId()

  const { data: balanceIn } = useBalance({
    address,
    chainId: activeChainId,
    token: tokenIn && !isNativeETH(tokenIn) ? tokenIn.address : undefined,
    query: { enabled: isConnected && isCorrectChain && !!tokenIn },
  })

  const excludeArray = useMemo(() => excludedSources.size > 0 ? Array.from(excludedSources) : undefined, [excludedSources])
  const { meta: rawMeta, loading: quoteLoading, error: quoteError, countdown, refresh: refreshQuote } =
    useQuote(tokenIn, tokenOut, amountIn, isConnected && isCorrectChain, excludeArray)

  // [LP-04 / P140] Smart MEV routing — logic extracted to
  // src/lib/mev-preference.ts for direct unit testing.
  const { meta, smartMevApplied, mevExposedBest } = useMemo(
    () => selectBestWithMevPreference(rawMeta ?? null, mevProtected, AGGREGATOR_META, MEV_PREFERENCE_THRESHOLD),
    [rawMeta, mevProtected],
  )

  // [SPRINT-9E] Re-resolve the selected tokens to the ACTIVE chain's addresses
  // whenever the chain changes. The defaults (findToken) are mainnet addresses;
  // without this, Base would quote e.g. MAINNET USDC (0xA0b8…) on chainId 8453 →
  // every source rejects it ("1inch 400: not valid token") → "No valid quotes".
  // remapTokenToChain is a no-op on mainnet (same address) so mainnet is unchanged.
  useEffect(() => {
    setTokenIn((t) => remapTokenToChain(t, activeChainId))
    setTokenOut((t) => remapTokenToChain(t, activeChainId))
    // [review F1] A chain switch is a new trade — drop any prior price-impact consent.
    setAcceptedDeviation(null)
    setAcceptedDepeg(null) // [SPRINT-9W-oracle] drop depeg consent too
  }, [activeChainId])
  // [P223] Swap activation guard. A chain is "coming soon" until its
  // FeeCollector is deployed (config.contracts.feeCollector !== null). Mainnet
  // is active, so chainActive is always true there and nothing below changes.
  const chainActive = isChainActive(activeChainId)
  const chainName = (() => {
    try { return getChainConfig(activeChainId).name } catch { return 'this network' }
  })()

  // Play subtle sound when a new quote arrives
  // [BUGFIX] Use AbortController to cancel stale spender fetch on rapid source changes
  useEffect(() => {
    if (meta?.best.source) {
      playQuoteReceived()
      const controller = new AbortController()
      fetch(`/api/spender?source=${meta.best.source}${activeChainId !== 1 ? `&chainId=${activeChainId}` : ''}`, { signal: controller.signal })
        .then(r => r.json())
        .then(data => {
          if (data.spender) {
            // [FULL-H-02] Validate the spender against the client-side
            // allowlist before trusting it. A compromised /api/spender
            // response must never let the user approve an attacker address.
            if (!isTrustedSpender(data.spender, activeChainId)) {
              console.error('[Security] Untrusted spender address from /api/spender:', data.spender)
              setSpender(undefined)
              toast({ type: 'error', title: 'Swap unavailable', description: 'Spender validation failed. Please try again or choose another route.' })
              return // Do NOT set the spender state
            }
            setSpender(data.spender as `0x${string}`)
          }
        }).catch(() => {})
      return () => controller.abort()
    } else {
      // [BUGFIX] Clear spender when MEV filter nullifies meta
      setSpender(undefined)
    }
  }, [meta?.best.source, activeChainId])

  const { plan: approvalPlan, status: approvalStatus, error: approvalError, approve, isReady: approvalReady, needsPermit2Education, confirmPermit2Education, cancelPermit2Education } =
    useApproval(tokenIn, amountIn, spender)

  // [P104] We pass the raw adapter gasUsd from the best non-CoW quote
  // rather than the engine-computed gasSavingsUsd — the server clamps it
  // (max $500) and computes the persisted gas_savings_usd from there.
  const bestNonCowGasUsd = meta?.all.find((q) => q.source !== 'cowswap')?.gasUsd
  const { status: swapStatus, txHash, errorMessage: swapError, priceGuardBlocked, priceGuardDeviation, simulationPassed, simulationSkipped, fallbackNotice, pendingSwap, pendingCowOrder, mevSurplusActualWei, execute: executeSwap, confirmSwap, confirmCowOrder, reset: resetSwap } =
    useSwap(tokenIn, tokenOut, amountIn, slippage, meta?.best.toAmount, bestNonCowGasUsd)

  // [SPRINT-9S S2] Direction-agnostic execution price. Derive the USD price of the NON-stable
  // side from the stable side (≈$1): tokenOut stable → price of tokenIn (out/in); tokenIn stable
  // → price of tokenOut (in/out). The latter is NEW — it makes SELLING a stablecoin run the same
  // oracle deviation check as BUYING it (previously only the stablecoin-OUT direction was checked).
  const { execIn, execOut } = meta?.best && tokenIn && tokenOut
    ? (() => {
        // [11-L-01] safeBigInt: malformed toAmount → skip price computation.
        const outBig = safeBigInt(meta.best.toAmount)
        if (outBig === null) return { execIn: null, execOut: null }
        const outAmount = Number(formatUnits(outBig, tokenOut.decimals))
        const inAmount = Number(amountIn)
        if (inAmount <= 0 || outAmount <= 0) return { execIn: null, execOut: null }
        const STABLE = ['USDC', 'USDT', 'DAI', 'USDbC']
        return {
          execIn: STABLE.includes(tokenOut.symbol) ? outAmount / inAmount : null,
          execOut: STABLE.includes(tokenIn.symbol) ? inAmount / outAmount : null,
        }
      })()
    : { execIn: null, execOut: null }

  const priceCheck = useChainlinkPrice(tokenIn?.address, execIn)
  // [LP-05] Output-token USD price for converting MEV surplus to a $ figure in the success toast.
  // [SPRINT-9S S2] Now also carries execOut so a stablecoin-IN swap gets a real deviation check.
  const tokenOutPriceCheck = useChainlinkPrice(tokenOut?.address, execOut)
  // [SPRINT-9S S2] Direction-agnostic oracle verdict over BOTH tokens' feeds — symmetric, and
  // warns naming whichever side lacks a feed. Drives the price gate + the QuoteBreakdown notice.
  const pairCheck = evaluatePairOracle(priceCheck, tokenOutPriceCheck, tokenIn?.symbol ?? '', tokenOut?.symbol ?? '')
  // [SPRINT-9W-oracle] cbETH depeg circuit-breaker verdict (market-vs-ER divergence). mode 'ok'
  // when neither token has an exchange-rate pair, or when either feed is stale (fail-open).
  const depegCheck = useDepegCheck(tokenIn?.address, tokenOut?.address)
  const { addRecord } = useSwapHistory()
  const { addApproval } = useActiveApprovals()
  const { splitResult, analyzing: splitAnalyzing, useSplit, toggleSplit } =
    useSplitRoute(meta, tokenIn, tokenOut, amountIn, isConnected && isCorrectChain)

  const {
    status: splitSwapStatus,
    legs: splitLegs,
    completedLegs: splitCompleted,
    totalLegs: splitTotal,
    errorMessage: splitSwapError,
    plannedLegs: splitPlannedLegs,
    execute: executeSplitSwap,
    confirmPlan: confirmSplitPlan,
    reset: resetSplitSwap,
  } = useSplitSwap(tokenIn, tokenOut, amountIn, slippage)

  // Unified status: use split swap status when split is active, else single swap
  const isSplitActive = useSplit && splitResult?.bestSplit.isSplit
  // Map SplitSwapStatus → SwapStatus for unified UI handling
  const splitStatusMap: Record<string, SwapStatus> = {
    idle: 'idle', executing: 'swapping', success: 'success',
    error: 'error', partial: 'error',
    // [SPRINT-9R R1] Phase A (building the plan) reads as 'swapping' (busy);
    // 'awaiting-review' maps to 'confirming' so the button reflects the open review modal.
    planning: 'swapping', 'awaiting-review': 'confirming',
  }
  const effectiveSwapStatus: SwapStatus = isSplitActive
    ? (splitStatusMap[splitSwapStatus] ?? 'idle')
    : swapStatus
  const effectiveError = isSplitActive ? splitSwapError : swapError

  const { estimate: gasEstimateFn } = useEthGasCost()
  const { toast, dismiss } = useToast()
  const swapToastId = useRef<string | null>(null)
  // [hotfix] Track the last quote-error string we toasted. The
  // useQuote → setError(null) → setError(msg) churn on every poll cycle
  // would otherwise drive a new identical toast every 15 seconds; this
  // ref short-circuits the duplicate before it reaches the toast layer
  // (the dedupKey on the toast itself is the second line of defence).
  const lastQuoteErrorRef = useRef<string | null>(null)

  // ── Particle turbo mode during active swap ──
  useEffect(() => {
    const isSwapping = effectiveSwapStatus === 'swapping' || effectiveSwapStatus === 'cow_signing' || effectiveSwapStatus === 'cow_pending'
    setParticleTurbo(isSwapping)
    return () => setParticleTurbo(false)
  }, [effectiveSwapStatus])

  // ── Toast: swap initiated (loading) ──
  useEffect(() => {
    if (swapStatus === 'swapping' || swapStatus === 'cow_signing' || swapStatus === 'cow_pending') {
      const msg = swapStatus === 'cow_signing' ? 'Signing CoW order...'
        : swapStatus === 'cow_pending' ? 'CoW order submitted — waiting for settlement...'
        : 'Transaction pending...'
      swapToastId.current = toast({ type: 'loading', title: msg, description: `${tokenIn?.symbol} → ${tokenOut?.symbol}` })
    }
  }, [swapStatus])

  // ── Track swap success: history + approvals ──
  useEffect(() => {
    if (swapStatus === 'success' && txHash && tokenIn && tokenOut && meta?.best) {
      stopWaitingSound()
      playSwapConfirmMP3()
      // Dismiss loading toast → fire fresh success with Etherscan link
      if (swapToastId.current) {
        dismiss(swapToastId.current)
      }

      // [LP-05] MEV-savings — both pre-swap estimate (CoW vs non-CoW median)
      // and post-swap realised surplus (CoW solver delivered > quoted).
      // The toast appends a "you saved ~$X" line only when there is positive
      // realised surplus AND the source was CoW; we don't display the
      // estimate alone post-swap to avoid implying we measured what we
      // didn't. Both values are still logged to analytics regardless.
      const mevEstimate = estimateMevSavings(meta)
      const isCowSuccess = meta.best.source === 'cowswap'
      const realisedSurplusWei = isCowSuccess && mevSurplusActualWei && mevSurplusActualWei > 0n
        ? mevSurplusActualWei
        : null

      let savingsLine = ''
      if (realisedSurplusWei) {
        const surplusTok = Number(formatUnits(realisedSurplusWei, tokenOut.decimals))
        const tokenPriceUsd = tokenOutPriceCheck.chainlinkPrice
        if (tokenPriceUsd != null && surplusTok * tokenPriceUsd >= 0.01) {
          savingsLine = ` · You saved ~$${(surplusTok * tokenPriceUsd).toFixed(2)} vs public-mempool execution`
        } else if (surplusTok > 0) {
          savingsLine = ` · You saved ~${formatDisplay(surplusTok, 4)} ${tokenOut.symbol} vs public-mempool execution`
        }
      }

      // [11-L-01] safeBigInt: malformed toAmount → fall back to "—" in toast / "0" in history.
      const successOutBig = safeBigInt(meta.best.toAmount)
      const successOutNum = successOutBig !== null
        ? Number(formatUnits(successOutBig, tokenOut.decimals))
        : null
      const successOutDisplay = successOutNum !== null ? formatDisplay(successOutNum, 4) : '—'
      toast({ type: 'success', title: 'Swap confirmed!', description: `${amountIn} ${tokenIn.symbol} → ${successOutDisplay} ${tokenOut.symbol}${savingsLine}`, txHash, duration: 10000 })
      swapToastId.current = null

      const outAmount = successOutNum !== null ? successOutNum.toFixed(4) : '0'
      addRecord({
        id: txHash,
        date: new Date().toLocaleDateString('en-GB'),
        tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amountIn,
        amountOut: outAmount,
        txHash, status: 'confirmed',
        chainId: activeChainId, // [SPRINT-9S S3] chain-aware explorer link in history
      })

      // [LP-05] Patch the swap row with MEV-savings telemetry. Fire-and-forget;
      // the swap-status update from useSwap already fired with the basic
      // confirmed status, so this is additive — only sets the two new
      // numeric columns when we have data for them.
      if (address && (mevEstimate || realisedSurplusWei)) {
        updateSwapStatus({
          txHash,
          status: 'confirmed',
          wallet: address,
          mevSavingsEstimate: mevEstimate ? mevEstimate.amountWei.toString() : undefined,
          mevSavingsActual: realisedSurplusWei ? realisedSurplusWei.toString() : undefined,
        })
      }

      // Analytics: server-side /api/log-swap handles tracking (Q2 — removed client-side analytics-tracker)

      // Security tracking is handled server-side by /api/log-swap

      // Track approval for revoke — only if it leaves a residual allowance
      const source = meta.best.source
      const isCow = source === 'cowswap'

      if (isCow && tokenIn && !isNativeETH(tokenIn)) {
        // [FULL-L-04] CoW approvals are exact: useApproval forces an exact
        // approve to the VaultRelayer and the solver pulls exactly the sell
        // amount, leaving no residual allowance. Record it accurately and do
        // NOT show the old (misleading) "infinite allowance" revoke warning.
        addApproval({
          tokenAddress: tokenIn.address,
          tokenSymbol: tokenIn.symbol,
          spenderAddress: COW_VAULT_RELAYER,
          spenderLabel: 'CoW VaultRelayer',
          source: 'cowswap',
          method: 'exact',
          timestamp: Date.now(),
          needsRevoke: false,
        })
      }
    }
  }, [swapStatus, txHash])

  // Play error sound + toast on swap failure
  useEffect(() => {
    if (swapStatus === 'error') {
      stopWaitingSound()
      playCancelOrderMP3()
      if (swapToastId.current) { dismiss(swapToastId.current) }
      toast({ type: 'error', title: 'Swap failed', description: swapError || 'Transaction was rejected or failed.' })
      swapToastId.current = null
    }
  }, [swapStatus])

  // Split swap toasts
  useEffect(() => {
    if (splitSwapStatus === 'success') {
      stopWaitingSound()
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'Split swap complete!', description: `All ${splitTotal} legs executed successfully.`, duration: 10000 })
    } else if (splitSwapStatus === 'partial') {
      stopWaitingSound()
      playCancelOrderMP3()
      toast({ type: 'warning', title: 'Split swap partially complete', description: splitSwapError || `${splitCompleted}/${splitTotal} legs succeeded.`, duration: 10000 })
    } else if (splitSwapStatus === 'error') {
      stopWaitingSound()
      playCancelOrderMP3()
      toast({ type: 'error', title: 'Split swap failed', description: splitSwapError || 'Transaction was rejected or failed.' })
    }
  }, [splitSwapStatus])

  // ── Toast: approval error ──
  useEffect(() => {
    if (approvalError) {
      toast({ type: 'error', title: 'Approval failed', description: approvalError })
    }
  }, [approvalError])

  // ── Toast: quote error (warning, less intrusive) ──
  //
  // [hotfix] Two layers of dedup so a 429 storm can't flood the tray:
  //   1. lastQuoteErrorRef short-circuits identical strings before we
  //      even hit the toast layer (the common case during rate-limit
  //      backoff is the same "Rate limit exceeded…" message every poll).
  //   2. dedupKey: 'quote-error' on the toast call asks the provider to
  //      replace any prior toast carrying the same key, so a *changed*
  //      error message still updates in place instead of stacking.
  // When the error clears, we reset the ref so the next genuine error
  // re-surfaces normally.
  useEffect(() => {
    if (!quoteError) {
      lastQuoteErrorRef.current = null
      return
    }
    if (quoteError === lastQuoteErrorRef.current) return
    lastQuoteErrorRef.current = quoteError
    toast({
      type: 'warning',
      title: 'Quote unavailable',
      description: quoteError,
      duration: 6000,
      dedupKey: 'quote-error',
    })
  }, [quoteError, toast])

  const hasAmount = !!amountIn && Number(amountIn) > 0
  // [BUGFIX] Wrap parseUnits in try/catch — malformed input (e.g. "1.2.3") would crash
  const hasSufficientBalance = !hasAmount || !balanceIn || !tokenIn || (() => {
    try { return parseUnits(amountIn, tokenIn.decimals) <= balanceIn.value } catch { return false }
  })()
  // [11-L-01] safeBigInt: malformed toAmount → display "—" instead of crashing.
  const outputDisplay = meta?.best && tokenOut
    ? (() => {
        const v = safeBigInt(meta.best.toAmount)
        return v !== null ? formatDisplay(Number(formatUnits(v, tokenOut.decimals)), 4) : '—'
      })()
    : '0.0'

  // Format balance with separators
  const balanceDisplay = balanceIn
    ? formatDisplay(Number(formatUnits(balanceIn.value, balanceIn.decimals)), 4)
    : null

  function handleAmountChange(raw: string) {
    // Strip existing separators, allow only digits and one decimal
    const clean = raw.replace(/\s/g, '')
    if (clean === '' || /^\d*\.?\d*$/.test(clean)) {
      setDisplayAmountIn(formatWithSeparator(clean))
      setPriceCheckStale(true)
      setAcceptedDeviation(null)
      setAcceptedDepeg(null) // [SPRINT-9W-oracle]
      if (swapStatus !== 'idle') resetSwap()
      if (splitSwapStatus !== 'idle') resetSplitSwap()
    }
  }

  function handleInvert() {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setDisplayAmountIn('')
    setPriceCheckStale(true)
    setAcceptedDeviation(null)
    setAcceptedDepeg(null) // [SPRINT-9W-oracle]
    resetSwap()
    resetSplitSwap()
  }

  function handleSetAmount(value: string) {
    setDisplayAmountIn(formatWithSeparator(value))
    setPriceCheckStale(true)
    setAcceptedDeviation(null)
    setAcceptedDepeg(null) // [SPRINT-9W-oracle]
  }

  // Clear the stale flag whenever a fresh quote (`meta`) resolves — at that
  // point `priceCheck` reflects the current sell amount and any deviation
  // banner is safe to display.
  useEffect(() => {
    if (meta?.best?.toAmount) setPriceCheckStale(false)
  }, [meta?.best?.toAmount])

  // ── Security: Chainlink price gate [SPRINT-9J J1] ──
  // Separate a genuine ORACLE-INTEGRITY failure (stale / invalid round → hard
  // block, cannot be overridden) from a healthy-oracle DEVIATION, which is the
  // trade's OWN price impact (slippage the user already accepts → informed
  // consent). The deviation no longer indefinitely pauses legit illiquid swaps.
  // Genuine cross-source manipulation is still hard-blocked by the SERVER-side
  // DefiLlama guard (priceGuardBlocked, cannot be overridden) and the on-chain
  // minimumOutput caps realised loss. oracleUnavailable → tiered USD gate below.
  const priceGate = evaluatePriceGate(pairCheck)
  // [review F2] mode 'block' = oracle-integrity failure OR an extreme deviation
  // (beyond plausible price impact). Both are HARD blocks (no click-through).
  const oracleIntegrityBlocked = priceGate.mode === 'block'
  const isExtremeBlock = oracleIntegrityBlocked && priceGate.reason === 'extreme-deviation'
  const priceImpactConsentNeeded = priceGate.mode === 'consent'
  // [review F1] Consent stays valid only while the live deviation hasn't worsened
  // past the accepted level (+tolerance). A quote refresh that escalates the impact
  // re-arms the checkbox so the user re-accepts the worse price.
  const priceImpactAccepted =
    acceptedDeviation != null && pairCheck.deviation <= acceptedDeviation + PRICE_IMPACT_CONSENT_TOLERANCE
  const priceImpactBlocking = priceImpactConsentNeeded && !priceImpactAccepted
  // Security-class block (Chainlink gate), as opposed to the oracle-unavailable gate.
  const priceGateBlocked = oracleIntegrityBlocked || priceImpactBlocking

  // [SPRINT-9W-oracle] cbETH depeg circuit-breaker — a SECOND, independent verdict. Mirrors the 9J
  // consent state machine: WARN..BLOCK band → informed consent (auto-revokes if divergence worsens
  // past accepted+tolerance); ≥BLOCK → hard block (no click-through). 'ok' (incl. a stale feed)
  // adds no friction. The swap-price reference is unchanged.
  const depegConsentNeeded = depegCheck.mode === 'consent'
  const depegAccepted = acceptedDepeg != null && depegCheck.divergence <= acceptedDepeg + DEPEG_CONSENT_TOLERANCE
  const depegConsentBlocking = depegConsentNeeded && !depegAccepted
  const depegHardBlocked = depegCheck.mode === 'block'
  const depegBlocking = depegHardBlocked || depegConsentBlocking

  // ── Security: block large swaps on tokens without Chainlink oracle ──
  // Estimate USD value of the swap input (only reliable when input is a stablecoin or ETH)
  const estimatedInputUsd = useMemo(() => {
    if (!tokenIn || !amountIn || Number(amountIn) <= 0) return 0
    if (['USDC', 'USDT', 'DAI', 'USDe'].includes(tokenIn.symbol)) return Number(amountIn)
    // If we have a Chainlink price for the input token, use it
    if (priceCheck.chainlinkPrice != null) return Number(amountIn) * priceCheck.chainlinkPrice
    // For ETH without a loaded price yet, use a conservative estimate
    if (isNativeETH(tokenIn) || tokenIn.symbol === 'WETH') return Number(amountIn) * 2000
    return 0 // unknown — can't estimate
  }, [tokenIn, amountIn, priceCheck.chainlinkPrice])

  const oracleUnavailable = pairCheck.oracleUnavailable
  const oracleWarnThreshold = oracleUnavailable && estimatedInputUsd > UNVERIFIED_SWAP_WARN_USD
  const oracleBlocked = oracleUnavailable && estimatedInputUsd > UNVERIFIED_SWAP_BLOCK_USD
  const anyBlocked = priceGateBlocked || oracleBlocked || depegBlocking

  const handleApproveAndSwap = useCallback(async () => {
    if (!chainActive) return // [P223] swaps disabled on coming-soon chains
    if (anyBlocked) {
      // [Wallet Activity] Track security block
      if (address) {
        trackWalletActivity(address, {
          category: 'ui',
          action: priceGateBlocked ? 'swap_blocked_security' : 'swap_blocked_oracle',
          token_in: tokenIn?.symbol, token_out: tokenOut?.symbol,
          metadata: {
            reason: priceGateBlocked ? `price_gate_${priceGate.reason}` : 'oracle_unavailable_large_swap',
            deviation: pairCheck.deviation,
            estimatedUsd: estimatedInputUsd,
          },
        })
      }
      return // hard block — never execute above deviation threshold or unverified large swap
    }
    startWaitingSound()
    if (!approvalReady) { await approve(); return }

    if (isSplitActive && splitResult?.bestSplit) {
      executeSplitSwap(splitResult.bestSplit)
    } else if (meta?.best.source) {
      // [SPRINT-9O Part B] Pass ranked fallbacks so a best route that reverts
      // pre-swap simulation auto-switches to the next working source.
      executeSwap(meta.best.source, orderFallbackSources(meta, meta.best.source))
    }
  }, [approvalReady, approve, meta, executeSwap, anyBlocked, isSplitActive, splitResult, executeSplitSwap, chainActive])

  const handleSwap = useCallback(() => {
    if (!chainActive) return // [P223] swaps disabled on coming-soon chains
    if (anyBlocked) {
      if (address) {
        trackWalletActivity(address, {
          category: 'ui',
          action: priceGateBlocked ? 'swap_blocked_security' : 'swap_blocked_oracle',
          token_in: tokenIn?.symbol, token_out: tokenOut?.symbol,
          metadata: {
            reason: priceGateBlocked ? `price_gate_${priceGate.reason}` : 'oracle_unavailable_large_swap',
            deviation: pairCheck.deviation,
            estimatedUsd: estimatedInputUsd,
          },
        })
      }
      return // hard block
    }
    startWaitingSound()
    if (isSplitActive && splitResult?.bestSplit) {
      executeSplitSwap(splitResult.bestSplit)
    } else if (meta?.best.source) {
      // [SPRINT-9O Part B] Pass ranked fallbacks so a best route that reverts
      // pre-swap simulation auto-switches to the next working source.
      executeSwap(meta.best.source, orderFallbackSources(meta, meta.best.source))
    }
  }, [meta, executeSwap, anyBlocked, isSplitActive, splitResult, executeSplitSwap, chainActive])

  return (
    <>
      <div className="mx-auto w-full max-w-[calc(100vw-2rem)] rounded-2xl border border-cream-08 bg-surface-secondary/85 px-3 py-4 shadow-xl shadow-black/20 backdrop-blur-lg sm:max-w-[460px] sm:p-5">
        {/* Sell */}
        <div className="mb-1">
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[1.5px] text-cream-35">Sell</label>
          <div className="flex items-center gap-2 rounded-xl border border-cream-08 bg-surface-tertiary p-3 transition-colors focus-within:border-cream-35">
            <input
              type="text" inputMode="decimal" placeholder="0.0" value={displayAmountIn}
              onChange={(e) => handleAmountChange(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-lg font-semibold text-cream outline-none placeholder:text-cream-35 sm:text-2xl"
            />
            <TokenSelector selected={tokenIn} onSelect={(t) => { setTokenIn(t); setAcceptedDeviation(null); setAcceptedDepeg(null); resetSwap(); resetSplitSwap() }} disabledAddress={tokenOut?.address} />
          </div>
          {tokenIn && (
            <div className="mt-1 flex items-center justify-between px-1 text-xs text-cream-35">
              {balanceIn ? (
                <span>Balance: {balanceDisplay} {tokenIn.symbol}</span>
              ) : (
                <TokenAddressBadge address={tokenIn.address} size="sm" showExplorerLink={false} />
              )}
              {balanceIn && (
                <div className="-my-2 flex gap-2 sm:my-0">
                  <button onClick={() => handleSetAmount(formatUnits(balanceIn.value / 2n, balanceIn.decimals))} className="inline-flex min-h-[44px] items-center px-1 text-[11px] font-semibold uppercase text-cream-65 transition hover:text-cream sm:min-h-0 sm:px-0">50%</button>
                  <button onClick={() => handleSetAmount(formatUnits(balanceIn.value, balanceIn.decimals))} className="inline-flex min-h-[44px] items-center px-1 text-[11px] font-semibold uppercase text-cream-65 transition hover:text-cream sm:min-h-0 sm:px-0">MAX</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Invert */}
        <div className="relative z-10 -my-2 flex justify-center">
          <button onClick={handleInvert} className="flex h-11 w-11 items-center justify-center rounded-xl border border-cream-15 bg-surface-secondary text-cream-65 transition-all hover:border-cream-50 hover:text-cream hover:rotate-180">&#8645;</button>
        </div>

        {/* Receive */}
        <div className="mb-4 mt-1">
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-[11px] font-semibold uppercase tracking-[1.5px] text-cream-35">Receive</label>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-cream-08 bg-surface-tertiary p-3">
            <span className="min-w-0 flex-1 text-2xl font-semibold text-cream-65">
              {meta?.best
                ? <DigitRoller value={outputDisplay} prefix="~" />
                : quoteLoading
                  ? <span className="inline-block animate-pulse text-cream-35">...</span>
                  : null}
            </span>
            <TokenSelector selected={tokenOut} onSelect={(t) => { setTokenOut(t); setAcceptedDeviation(null); setAcceptedDepeg(null); resetSwap(); resetSplitSwap() }} disabledAddress={tokenIn?.address} />
          </div>
          {shouldShowSourceToggle(meta?.all.length ?? null, excludedSources.size) && (
            <div className="mt-1 flex items-center justify-between px-1">
              <SourceToggle excludedSources={excludedSources} onToggle={handleSourceToggle} />
              {meta && <span className="text-[10px] text-cream-35">{meta.all.length} sources queried</span>}
            </div>
          )}
        </div>

        {/* Force MEV Protection toggle (smart preference is the default —
            this toggle is the manual override for users who want CoW only) */}
        <div className="mb-3 flex items-center justify-between rounded-lg border border-cream-08 bg-surface-tertiary/50 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-cream-65">
              Force MEV Protection
            </span>
            <InfoTooltip
              className="text-[10px]"
              label="MEV protection info"
              content="Always route through CoW Protocol regardless of price. When off, TeraSwap automatically prefers MEV-protected routes when pricing is competitive."
            />
          </div>
          <button
            onClick={() => setMevProtected(!mevProtected)}
            className="relative flex h-6 w-10 items-center rounded-full transition-colors"
            style={{ backgroundColor: mevProtected ? '#C8B89A' : 'rgba(200,184,154,0.15)' }}
            aria-label="Toggle force MEV protection"
          >
            {/* [P135] Invisible hit-area extender on mobile — pushes the
                tap region out to ~44px on every side without changing the
                painted track. Children events bubble back to the button. */}
            <span aria-hidden="true" className="absolute -inset-2 sm:inset-0" />
            <span
              className="h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-200"
              style={{ marginLeft: mevProtected ? '20px' : '4px' }}
            />
          </button>
        </div>

        {/* No MEV-safe quote warning (force mode only) */}
        {mevProtected && !meta && rawMeta && !quoteLoading && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
            No MEV-protected quote available. CoW Protocol may be temporarily unavailable. Try disabling Force MEV Protection or wait a moment.
          </div>
        )}

        {/* Quote Breakdown */}
        {meta && tokenIn && tokenOut && hasAmount && (
          <div id="quote-breakdown" className="mb-4">
            {smartMevApplied && (
              <p className="mb-2 text-[11px] text-cream-50">
                ✦ Smart-routed via CoW{' '}
                {meta.gasless && meta.gasless.gasSavingsUsd >= 0.5
                  ? `(gasless, ~$${meta.gasless.gasSavingsUsd.toFixed(2)} saved)`
                  : '(MEV protected)'}
              </p>
            )}
            <QuoteBreakdown meta={meta} tokenIn={tokenIn} tokenOut={tokenOut} amountIn={amountIn} slippage={slippage} countdown={countdown} priceCheck={pairCheck} approvalPlan={approvalPlan} onEditSlippage={() => setShowSlippage(true)} gasEstimate={gasEstimateFn} smartMevApplied={smartMevApplied} mevExposedBest={mevExposedBest} onUseGasless={() => setMevProtected(true)} onRefresh={refreshQuote} refreshing={quoteLoading} />
          </div>
        )}
        {/* Quote loading skeleton */}
        {!meta && quoteLoading && hasAmount && (
          <div className="mb-4">
            <QuoteBreakdownSkeleton />
          </div>
        )}

        {/* Split Route Visualizer */}
        {splitResult && splitResult.bestSplit.isSplit && tokenOut && (
          <div className="mb-4">
            <SplitRouteVisualizer
              splitResult={splitResult}
              tokenOut={tokenOut}
              useSplit={useSplit}
              onToggle={toggleSplit}
              analyzing={splitAnalyzing}
            />
          </div>
        )}

        {/* Split Swap Progress */}
        {isSplitActive && splitSwapStatus !== 'idle' && (
          <div className="mb-4 rounded-xl border border-cream-08 bg-surface-tertiary p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-semibold text-cream-65">Split Execution</span>
              <span className="font-mono text-cream-50">{splitCompleted}/{splitTotal} legs</span>
            </div>
            {/* Progress bar */}
            <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-cream-08">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${splitTotal > 0 ? (splitCompleted / splitTotal) * 100 : 0}%`,
                  background: 'linear-gradient(90deg, #C8B89A, #4ADE80)',
                }}
              />
            </div>
            {/* Per-leg status */}
            <div className="space-y-1">
              {splitLegs.map((leg, i) => (
                <div key={i} className="flex items-center justify-between text-[11px]">
                  <span className="flex items-center gap-1.5">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                      leg.status === 'success' ? 'bg-success' :
                      leg.status === 'error' ? 'bg-danger' :
                      leg.status === 'pending' ? 'bg-cream-20' :
                      'bg-cream-gold animate-pulse'
                    }`} />
                    <span className="text-cream-50">{AGGREGATOR_META[leg.source]?.label || leg.source}</span>
                    <span className="text-cream-20">{leg.percent}%</span>
                  </span>
                  <span className="text-cream-35">
                    {leg.status === 'pending' ? 'Waiting' :
                     leg.status === 'fetching' ? 'Getting route...' :
                     leg.status === 'simulating' ? 'Simulating...' :
                     leg.status === 'signing' ? 'Confirm in wallet' :
                     leg.status === 'confirming' ? 'Confirming...' :
                     leg.status === 'success' ? '✓ Done' :
                     leg.error || 'Failed'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Errors */}
        {quoteError && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{quoteError}</div>}
        {/* DefiLlama Price Guard — server-side oracle blocked the swap */}
        {priceGuardBlocked && (
          <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <span className="font-semibold">&#128737; Swap blocked by server-side price protection.</span>{' '}
            The swap output is {priceGuardDeviation != null ? `${(Math.abs(priceGuardDeviation) * 100).toFixed(1)}%` : 'significantly'} below the fair market price
            verified by DefiLlama oracle. This may indicate extreme slippage, low liquidity, or a mispriced token.
            <span className="mt-1 block text-[10px] text-danger/80">
              Try a smaller amount, a different token pair, or wait for liquidity to stabilize. This protection cannot be overridden.
            </span>
          </div>
        )}
        {effectiveError && !isSplitActive && !priceGuardBlocked && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{effectiveError}</div>}
        {approvalError && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{approvalError}</div>}
        {/* [SPRINT-9J J1] Oracle-INTEGRITY failure (stale / invalid / incomplete
            round): the oracle itself can't be trusted → HARD block, no override.
            Stale-gated so it doesn't flash on in-flight quote data. */}
        {oracleIntegrityBlocked && !isExtremeBlock && !priceCheckStale && (
          <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <span className="font-semibold">&#9888; Swap blocked — oracle data unsafe.</span>{' '}
            {pairCheck.message ?? 'The Chainlink price feed is stale or invalid, so this swap price cannot be independently verified.'}
            <span className="mt-1 block text-[10px] text-danger/80">
              This guards against trading on a manipulated or outdated oracle and cannot be overridden. Try again once the feed updates.
            </span>
          </div>
        )}
        {/* [review F2] Extreme deviation vs a healthy oracle — beyond plausible
            price impact, so it is hard-blocked as possible manipulation / a broken
            quote (cannot be clicked through). */}
        {isExtremeBlock && !priceCheckStale && (
          <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <span className="font-semibold">&#9888; Swap blocked:</span> price deviates {(pairCheck.deviation * 100).toFixed(1)}% from the Chainlink oracle — far beyond normal price impact.
            <span className="mt-1 block text-[10px] text-danger/80">
              This likely indicates price manipulation or a broken quote and cannot be overridden. Try a smaller amount or a different pair.
            </span>
          </div>
        )}
        {/* [SPRINT-9J J1] Healthy-oracle DEVIATION = the trade's own price impact on
            a low-liquidity route (expected, slippage-covered). Informed consent —
            the user already accepts slippage — instead of an indefinite pause.
            Genuine manipulation is still caught server-side (DefiLlama guard) and
            by the on-chain minimum output. */}
        {priceImpactConsentNeeded && !priceCheckStale && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <span className="font-semibold">&#9888; High price impact:</span> this route executes ~{(pairCheck.deviation * 100).toFixed(1)}% below the Chainlink reference price — expected slippage on a low-liquidity route, not an oracle problem.
            <label className="mt-2 flex items-center gap-2 text-[11px] text-warning/90">
              <input
                type="checkbox"
                checked={priceImpactAccepted}
                onChange={(e) => setAcceptedDeviation(e.target.checked ? pairCheck.deviation : null)}
                className="h-3.5 w-3.5 accent-warning"
              />
              I understand the price impact and want to proceed.
            </label>
          </div>
        )}
        {/* [SPRINT-9W-oracle] cbETH depeg HARD block — market diverged ≥10% from the exchange
            rate: likely a depeg or a manipulated market feed. No click-through. */}
        {depegHardBlocked && !priceCheckStale && (
          <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <span className="font-semibold">&#9888; Swap blocked — {depegCheck.symbol} depeg.</span>{' '}
            {depegCheck.message}
            <span className="mt-1 block text-[10px] text-danger/80">
              The market price has diverged sharply from the protocol exchange rate — likely a depeg or oracle manipulation. This cannot be overridden. Try again once the prices reconverge.
            </span>
          </div>
        )}
        {/* [SPRINT-9W-oracle] cbETH depeg informed-consent — 2–10% off the exchange rate. The user
            must explicitly accept; consent auto-revokes if the divergence worsens (accepted+0.5%). */}
        {depegConsentNeeded && !priceCheckStale && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <span className="font-semibold">&#9888; Possible depeg:</span> {depegCheck.message}
            <label className="mt-2 flex items-center gap-2 text-[11px] text-warning/90">
              <input
                type="checkbox"
                checked={depegAccepted}
                onChange={(e) => setAcceptedDepeg(e.target.checked ? depegCheck.divergence : null)}
                className="h-3.5 w-3.5 accent-warning"
              />
              I understand {depegCheck.symbol} may be depegged and want to proceed.
            </label>
          </div>
        )}
        {/* Oracle unavailable — tiered warnings */}
        {oracleUnavailable && hasAmount && meta && !priceGateBlocked && (
          <>
            {oracleBlocked ? (
              <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                <span className="font-semibold">&#9888; Swap blocked — no oracle verification.</span>{' '}
                This token has no Chainlink price feed. Swaps above ${UNVERIFIED_SWAP_BLOCK_USD.toLocaleString()} are disabled when the price cannot be independently verified.
                <span className="mt-1 block text-[10px] text-danger/80">
                  This protects against catastrophic losses from mispriced tokens (wrapped tokens, rebasing tokens, exotic pairs). Reduce the amount or swap a token with oracle coverage.
                </span>
              </div>
            ) : oracleWarnThreshold ? (
              <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                <span className="font-semibold">&#9888; No oracle verification — high value swap.</span>{' '}
                This token has no Chainlink price feed. The quoted price cannot be independently verified.
                Swaps above ${UNVERIFIED_SWAP_BLOCK_USD.toLocaleString()} will be blocked.
                <span className="mt-1 block text-[10px] text-warning/80">
                  Verify the price manually on CoinGecko or Etherscan before proceeding.
                </span>
              </div>
            ) : (
              <div className="mb-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-300">
                <span className="font-semibold">&#9432; No oracle available</span> for {tokenIn?.symbol}.{' '}
                Price is based on aggregator quotes only — not independently verified by Chainlink.
              </div>
            )}
          </>
        )}

        {/* Swap Button */}
        {/* [P223] Coming-soon banner — shown when the active chain has no
            deployed FeeCollector. Token selector + amount stay usable for
            browsing; quotes are skipped and the swap button is disabled. */}
        {!chainActive && (
          <div className="mb-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-300">
            <span className="font-semibold">&#128640; Coming Soon on {chainName}.</span>{' '}
            Swaps aren&apos;t live on this network yet — switch to Ethereum to trade. You can still browse tokens here.
          </div>
        )}

        {/* [P224 review] priceBlocked stays = anyBlocked (no `|| !chainActive`):
            on a coming-soon chain the button's own !isCorrectChain branch shows
            "Switch to Ethereum", and the banner + handler guard cover the rest —
            so mixing !chainActive into priceBlocked only created a blockReason
            mismatch with no observable effect. */}
        <SwapButton swapStatus={swapStatus} approvalStatus={approvalStatus} approvalReady={approvalReady} hasAmount={hasAmount} hasSufficientBalance={hasSufficientBalance} hasQuote={!!meta} quoteLoading={quoteLoading} priceBlocked={anyBlocked} blockReason={depegHardBlocked ? 'depeg-block' : isExtremeBlock ? 'extreme' : oracleIntegrityBlocked ? 'oracle-stale' : depegConsentBlocking ? 'depeg-consent' : priceImpactBlocking ? 'price-impact' : oracleBlocked ? 'oracle' : undefined} onApprove={handleApproveAndSwap} onSwap={handleSwap} />

        {/* [P95] Subtle gasless nudge — shown below the swap button when a
            non-CoW route is currently selected but the engine has flagged
            gasless as the better deal. Clicking scrolls to the QuoteBreakdown
            card so the user can act on the recommendation. */}
        {meta?.gasless?.recommended && meta.best.source !== 'cowswap' && (
          <button
            type="button"
            onClick={() => {
              document.getElementById('quote-breakdown')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }}
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-purple-500/20 bg-purple-500/5 px-3 py-1.5 text-[11px] text-purple-300 transition hover:border-purple-500/40 hover:bg-purple-500/10"
            aria-label="Gasless route available — review the recommendation"
          >
            <span aria-hidden="true">&#128161;</span>
            <span>
              Gasless option available
              {meta.gasless.gasSavingsUsd >= 0.5 && (
                <> — save ~${meta.gasless.gasSavingsUsd.toFixed(2)}</>
              )}
            </span>
          </button>
        )}

        {/* [hotfix-ui] MEV-exposure hint — replaces the old amber-banner
            advisory that lived inside QuoteBreakdown. The signal is the
            same (current best route isn't MEV-protected) but the visual
            is now a single muted line of text: no warning icon, no
            background box, no border. The "Enable" link flips the
            existing Force MEV Protection toggle in one click; the "×"
            persists the dismissal in localStorage so users who've
            decided MEV protection isn't for them aren't pestered. */}
        {mevExposedBest && !mevHintDismissed && (
          <div className="mt-2 flex items-center justify-center gap-2 text-[12px] text-cream-35">
            <span>CoW Protocol available for MEV protection.</span>
            <button
              type="button"
              onClick={() => setMevProtected(true)}
              className="font-medium text-cream-65 underline-offset-2 transition hover:text-cream hover:underline"
            >
              Enable
            </button>
            <button
              type="button"
              onClick={dismissMevHint}
              className="text-cream-35 transition hover:text-cream-65"
              aria-label="Dismiss MEV protection hint"
            >
              ×
            </button>
          </div>
        )}

        {/* Pre-swap simulation status */}
        {simulationPassed === true && (swapStatus === 'swapping' || swapStatus === 'success') && (
          <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-emerald-400/80">
            <span>&#10003;</span> Pre-swap simulation passed — transaction verified safe
          </div>
        )}
        {simulationPassed === false && swapStatus === 'error' && (
          <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-danger/80">
            <span>&#10007;</span> Pre-swap simulation caught a revert — no gas was spent
          </div>
        )}
        {/* [P209 / FULL-L-05] Fail-open warning — the simulation was
            inconclusive (RPC hiccup / un-parseable error) so the only
            client-side revert guard was unavailable. Non-blocking: the
            on-chain minimumOutput still protects the fill. */}
        {simulationSkipped && (
          <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-warning/90">
            <span aria-hidden="true">&#9888;</span> Simulation unavailable — proceed with caution
          </div>
        )}
        {/* [SPRINT-9O Part B] Best route couldn't execute its pre-swap sim
            (e.g. mainnet Velora) → we auto-switched to a working source. */}
        {fallbackNotice && (
          <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-warning/90">
            <span aria-hidden="true">&#8635;</span> {fallbackNotice.from} couldn&apos;t execute this route — switched to {fallbackNotice.to}
          </div>
        )}

        {/* Pending tx link — show Etherscan link while waiting for confirmation */}
        {swapStatus === 'swapping' && txHash && (
          <div className="mt-3 text-center text-sm">
            <a href={`${ETHERSCAN_TX}${txHash}`} target="_blank" rel="noopener noreferrer" className="text-cream-35 transition hover:text-cream hover:underline">
              Transaction sent — track on Etherscan &#8599;
            </a>
          </div>
        )}

        {/* Success link + Share button */}
        {swapStatus === 'success' && txHash && (
          <div className="mt-3 space-y-2">
            <div className="text-center text-sm">
              <a href={`${ETHERSCAN_TX}${txHash}`} target="_blank" rel="noopener noreferrer" className="text-cream-65 transition hover:text-cream hover:underline">View on Etherscan &#8599;</a>
            </div>
            {/* Share button — "I just saved X% via TeraSwap" */}
            {meta && meta.all.length > 1 && tokenIn && tokenOut && (() => {
              // [11-L-01] safeBigInt: malformed amounts → hide the share button rather than crash.
              const bestBig = safeBigInt(meta.best.toAmount)
              const worstBig = safeBigInt(meta.all[meta.all.length - 1].toAmount)
              if (bestBig === null || worstBig === null) return null
              const bestOut = Number(formatUnits(bestBig, tokenOut.decimals))
              const worstOut = Number(formatUnits(worstBig, tokenOut.decimals))
              const savedPercent = worstOut > 0 ? ((bestOut - worstOut) / worstOut * 100) : 0
              const savedDisplay = savedPercent > 0.01 ? savedPercent.toFixed(2) : null
              const shareText = savedDisplay
                ? `I just saved ${savedDisplay}% on my ${tokenIn.symbol} → ${tokenOut.symbol} swap by comparing ${meta.all.length} DEX sources with @TeraSwapDEX 🔥\n\nTeraSwap meta-aggregates 11 DEX sources for the best price.\nhttps://www.teraswap.app`
                : `Just swapped ${tokenIn.symbol} → ${tokenOut.symbol} via @TeraSwapDEX — compared ${meta.all.length} sources for the best price 🔥\n\nhttps://www.teraswap.app`
              return (
                <button
                  onClick={() => {
                    window.open(
                      `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`,
                      '_blank',
                      'noopener,noreferrer,width=550,height=420'
                    )
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-cream-08 bg-surface-tertiary py-2.5 text-[13px] font-semibold text-cream-65 transition-all hover:border-cream-35 hover:text-cream active:scale-[0.98]"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                  {savedDisplay ? `Share — saved ${savedDisplay}%` : 'Share swap'}
                </button>
              )
            })()}
          </div>
        )}

        {/* Slippage Modal */}
        {showSlippage && <SlippageModal value={slippage} onChange={setSlippage} onClose={() => setShowSlippage(false)} isAuto={isAutoSlippage} onAutoChange={setIsAutoSlippage} tokenInSymbol={tokenIn?.symbol} tokenOutSymbol={tokenOut?.symbol} />}
      </div>

      {/* Active Approvals — below the swap box */}
      <ActiveApprovals />

      {/* [R-UX-01] Permit2 education modal — shown once before first Permit2 signature */}
      <Permit2EducationModal
        open={needsPermit2Education}
        onConfirm={confirmPermit2Education}
        onCancel={cancelPermit2Education}
        amount={amountIn}
        tokenSymbol={tokenIn?.symbol}
      />

      {/* Transaction preview confirmation modal */}
      {swapStatus === 'confirming' && pendingSwap && address && (
        <TransactionPreview
          calldata={pendingSwap.routerCalldata}
          routerAddress={pendingSwap.routerAddress}
          source={pendingSwap.source}
          userAddress={address}
          tokenIn={pendingSwap.tokenIn}
          tokenOut={pendingSwap.tokenOut}
          amountInDisplay={formatDisplay(formatUnits(pendingSwap.rawAmountBn, pendingSwap.tokenIn.decimals))}
          expectedOutput={(() => {
            // [SPRINT-9R R2] Render Send/Receive from the FROZEN pendingSwap snapshot — never live
            // quote state — so the modal always matches the calldata being signed (incl. after a 9O
            // source fallback). [11-L-01] safeBigInt: malformed toAmount → "—".
            const v = safeBigInt(pendingSwap.swapToAmount)
            return v !== null ? formatDisplay(formatUnits(v, pendingSwap.tokenOut.decimals)) : '—'
          })()}
          routeViaFeeCollector={pendingSwap.routeViaFeeCollector}
          minimumOutput={pendingSwap.minimumOutput}
          onConfirm={confirmSwap}
          onCancel={resetSwap}
        />
      )}

      {/* [SPRINT-9U U1] CoW order review — the EIP-712 order is frozen and shown here before any
          wallet signature; confirmCowOrder signs exactly this payload. Chain/account switch or a
          re-quote invalidates the frozen order (useSwap reset effects) and re-presents. */}
      {swapStatus === 'cow_awaiting_review' && pendingCowOrder && address && (
        <CowOrderReviewModal
          order={pendingCowOrder}
          onConfirm={confirmCowOrder}
          onCancel={resetSwap}
        />
      )}

      {/* [SPRINT-9R R1] Split-swap review — no leg is signed until the user confirms this
          aggregate plan; each wallet prompt then maps 1:1 to a reviewed leg. A rebuild
          (re-running executeSplitSwap) returns here with a fresh plan, forcing re-review. */}
      {isSplitActive && splitSwapStatus === 'awaiting-review' && address && (
        <SplitReviewModal
          plannedLegs={splitPlannedLegs}
          tokenIn={tokenIn}
          tokenOut={tokenOut}
          userAddress={address}
          onConfirm={confirmSplitPlan}
          onCancel={resetSplitSwap}
        />
      )}

      {/* Beta disclaimer */}
      <BetaDisclaimer />
    </>
  )
}
