'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAccount, useBalance } from 'wagmi'
import { formatUnits, parseUnits } from 'viem'
import TokenSelector from './TokenSelector'
import QuoteBreakdown from './QuoteBreakdown'
import SwapButton from './SwapButton'
import SlippageModal, { calculateAutoSlippage } from './SlippageModal'
import SourceToggle from './SourceToggle'
import ActiveApprovals from './ActiveApprovals'
import { useQuote } from '@/hooks/useQuote'
import { useSwap, type SwapStatus } from '@/hooks/useSwap'
import { useApproval } from '@/hooks/useApproval'
import { useChainlinkPrice } from '@/hooks/useChainlinkPrice'
import { useSwapHistory } from '@/hooks/useSwapHistory'
import { setParticleTurbo } from './ParticleNetwork'
// analytics-tracker removed (dead code — server-side /api/analytics is the source of truth)
// Security tracking moved server-side — events are recorded by /api/log-swap
import { useActiveApprovals } from '@/hooks/useActiveApprovals'
import { useSplitRoute } from '@/hooks/useSplitRoute'
import { useSplitSwap } from '@/hooks/useSplitSwap'
import SplitRouteVisualizer from './SplitRouteVisualizer'
import { findToken, isNativeETH, type Token } from '@/lib/tokens'
import { CHAIN_ID, DEFAULT_SLIPPAGE, ETHERSCAN_TX, COW_VAULT_RELAYER, AGGREGATOR_META, UNVERIFIED_SWAP_WARN_USD, UNVERIFIED_SWAP_BLOCK_USD } from '@/lib/constants'
import { formatWithSeparator, stripSeparator, formatDisplay } from '@/lib/format'
import { playSwapConfirmMP3, playCancelOrderMP3, playSwapInitiated, playApproval, playError, playQuoteReceived, startWaitingSound, stopWaitingSound } from '@/lib/sounds'
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
  const [showCowWarning, setShowCowWarning] = useState(false)
  const [mevProtected, setMevProtected] = useState(false)
  const [excludedSources, setExcludedSources] = useState<Set<string>>(new Set())

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
  const isCorrectChain = chain?.id === CHAIN_ID

  const { data: balanceIn } = useBalance({
    address,
    token: tokenIn && !isNativeETH(tokenIn) ? tokenIn.address : undefined,
    query: { enabled: isConnected && isCorrectChain && !!tokenIn },
  })

  const excludeArray = useMemo(() => excludedSources.size > 0 ? Array.from(excludedSources) : undefined, [excludedSources])
  const { meta: rawMeta, loading: quoteLoading, error: quoteError, countdown } =
    useQuote(tokenIn, tokenOut, amountIn, isConnected && isCorrectChain, excludeArray)

  // Filter to MEV-protected sources only when toggle is on
  const meta = useMemo(() => {
    if (!rawMeta || !mevProtected) return rawMeta
    const mevSources = rawMeta.all.filter(q => AGGREGATOR_META[q.source]?.mevProtected)
    if (mevSources.length === 0) return null // no MEV-safe quotes available
    return { ...rawMeta, best: mevSources[0], all: mevSources }
  }, [rawMeta, mevProtected])

  // Play subtle sound when a new quote arrives
  // [BUGFIX] Use AbortController to cancel stale spender fetch on rapid source changes
  useEffect(() => {
    if (meta?.best.source) {
      playQuoteReceived()
      const controller = new AbortController()
      fetch(`/api/spender?source=${meta.best.source}`, { signal: controller.signal })
        .then(r => r.json())
        .then(data => {
          if (data.spender) {
            setSpender(data.spender as `0x${string}`)
          }
        }).catch(() => {})
      return () => controller.abort()
    } else {
      // [BUGFIX] Clear spender when MEV filter nullifies meta
      setSpender(undefined)
    }
  }, [meta?.best.source])

  const { plan: approvalPlan, status: approvalStatus, error: approvalError, approve, isReady: approvalReady } =
    useApproval(tokenIn, amountIn, spender)

  const { status: swapStatus, txHash, errorMessage: swapError, cowOrderUid, priceGuardBlocked, priceGuardDeviation, simulationPassed, execute: executeSwap, reset: resetSwap } =
    useSwap(tokenIn, tokenOut, amountIn, slippage, meta?.best.toAmount)

  const executionPriceUsd = meta?.best && tokenIn && tokenOut
    ? (() => {
        const outAmount = Number(formatUnits(BigInt(meta.best.toAmount), tokenOut.decimals))
        const inAmount = Number(amountIn)
        if (inAmount <= 0) return null
        if (['USDC', 'USDT', 'DAI'].includes(tokenOut.symbol)) return outAmount / inAmount
        return null
      })()
    : null

  const priceCheck = useChainlinkPrice(tokenIn?.address, executionPriceUsd)
  const { addRecord } = useSwapHistory()
  const { addApproval } = useActiveApprovals()
  const { splitResult, analyzing: splitAnalyzing, splitRecommended, useSplit, toggleSplit } =
    useSplitRoute(meta, tokenIn, tokenOut, amountIn, isConnected && isCorrectChain)

  const {
    status: splitSwapStatus,
    legs: splitLegs,
    completedLegs: splitCompleted,
    totalLegs: splitTotal,
    errorMessage: splitSwapError,
    execute: executeSplitSwap,
    reset: resetSplitSwap,
  } = useSplitSwap(tokenIn, tokenOut, amountIn, slippage)

  // Unified status: use split swap status when split is active, else single swap
  const isSplitActive = useSplit && splitResult?.bestSplit.isSplit
  // Map SplitSwapStatus → SwapStatus for unified UI handling
  const splitStatusMap: Record<string, SwapStatus> = {
    idle: 'idle', executing: 'swapping', success: 'success',
    error: 'error', partial: 'error',
  }
  const effectiveSwapStatus: SwapStatus = isSplitActive
    ? (splitStatusMap[splitSwapStatus] ?? 'idle')
    : swapStatus
  const effectiveError = isSplitActive ? splitSwapError : swapError

  const { estimate: gasEstimateFn } = useEthGasCost()
  const { toast, dismiss } = useToast()
  const swapToastId = useRef<string | null>(null)

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
      toast({ type: 'success', title: 'Swap confirmed!', description: `${amountIn} ${tokenIn.symbol} → ${formatDisplay(Number(formatUnits(BigInt(meta.best.toAmount), tokenOut.decimals)), 4)} ${tokenOut.symbol}`, txHash, duration: 10000 })
      swapToastId.current = null

      const outAmount = Number(formatUnits(BigInt(meta.best.toAmount), tokenOut.decimals)).toFixed(4)
      addRecord({
        id: txHash,
        date: new Date().toLocaleDateString('en-GB'),
        tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amountIn,
        amountOut: outAmount,
        txHash, status: 'confirmed',
      })

      // Analytics: server-side /api/log-swap handles tracking (Q2 — removed client-side analytics-tracker)

      // Security tracking is handled server-side by /api/log-swap

      // Track approval for revoke — only if it leaves a residual allowance
      const source = meta.best.source
      const isCow = source === 'cowswap'

      if (isCow && tokenIn && !isNativeETH(tokenIn)) {
        // CoW Protocol: VaultRelayer keeps infinite allowance
        addApproval({
          tokenAddress: tokenIn.address,
          tokenSymbol: tokenIn.symbol,
          spenderAddress: COW_VAULT_RELAYER,
          spenderLabel: 'CoW VaultRelayer',
          source: 'cowswap',
          method: 'infinite',
          timestamp: Date.now(),
          needsRevoke: true,
        })
        setShowCowWarning(true)
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
  useEffect(() => {
    if (quoteError) {
      toast({ type: 'warning', title: 'Quote unavailable', description: quoteError, duration: 6000 })
    }
  }, [quoteError])

  const hasAmount = !!amountIn && Number(amountIn) > 0
  // [BUGFIX] Wrap parseUnits in try/catch — malformed input (e.g. "1.2.3") would crash
  const hasSufficientBalance = !hasAmount || !balanceIn || !tokenIn || (() => {
    try { return parseUnits(amountIn, tokenIn.decimals) <= balanceIn.value } catch { return false }
  })()
  const outputDisplay = meta?.best && tokenOut
    ? formatDisplay(Number(formatUnits(BigInt(meta.best.toAmount), tokenOut.decimals)), 4)
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
      if (swapStatus !== 'idle') resetSwap()
      if (splitSwapStatus !== 'idle') resetSplitSwap()
    }
  }

  function handleInvert() {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setDisplayAmountIn('')
    resetSwap()
    resetSplitSwap()
    setShowCowWarning(false)
  }

  function handleSetAmount(value: string) {
    setDisplayAmountIn(formatWithSeparator(value))
  }

  // ── Security: block swap when Chainlink deviation exceeds threshold ──
  // Block at BOTH warn (≥2%) and danger (≥3%) — button only re-enables when price
  // returns fully within parameters (deviation < PRICE_DEVIATION_WARN).
  // oracleUnavailable tokens are handled separately by the tiered oracle system below.
  const priceBlocked = (priceCheck.level === 'danger' || priceCheck.level === 'warn') && !priceCheck.oracleUnavailable

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

  const oracleUnavailable = priceCheck.oracleUnavailable
  const oracleWarnThreshold = oracleUnavailable && estimatedInputUsd > UNVERIFIED_SWAP_WARN_USD
  const oracleBlocked = oracleUnavailable && estimatedInputUsd > UNVERIFIED_SWAP_BLOCK_USD
  const anyBlocked = priceBlocked || oracleBlocked

  const handleApproveAndSwap = useCallback(async () => {
    if (anyBlocked) {
      // [Wallet Activity] Track security block
      if (address) {
        trackWalletActivity(address, {
          category: 'ui',
          action: priceBlocked ? 'swap_blocked_security' : 'swap_blocked_oracle',
          token_in: tokenIn?.symbol, token_out: tokenOut?.symbol,
          metadata: {
            reason: priceBlocked ? `price_deviation_${priceCheck.level}` : 'oracle_unavailable_large_swap',
            deviation: priceCheck.deviation,
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
      executeSwap(meta.best.source)
    }
  }, [approvalReady, approve, meta?.best.source, executeSwap, anyBlocked, isSplitActive, splitResult, executeSplitSwap])

  const handleSwap = useCallback(() => {
    if (anyBlocked) {
      if (address) {
        trackWalletActivity(address, {
          category: 'ui',
          action: priceBlocked ? 'swap_blocked_security' : 'swap_blocked_oracle',
          token_in: tokenIn?.symbol, token_out: tokenOut?.symbol,
          metadata: {
            reason: priceBlocked ? `price_deviation_${priceCheck.level}` : 'oracle_unavailable_large_swap',
            deviation: priceCheck.deviation,
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
      executeSwap(meta.best.source)
    }
  }, [meta?.best.source, executeSwap, anyBlocked, isSplitActive, splitResult, executeSplitSwap])

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
            <TokenSelector selected={tokenIn} onSelect={(t) => { setTokenIn(t); resetSwap() }} disabledAddress={tokenOut?.address} />
          </div>
          {balanceIn && tokenIn && (
            <div className="mt-1 flex items-center justify-between px-1 text-xs text-cream-35">
              <span>Balance: {balanceDisplay} {tokenIn.symbol}</span>
              <div className="flex gap-2">
                <button onClick={() => handleSetAmount(formatUnits(balanceIn.value / 2n, balanceIn.decimals))} className="text-[11px] font-semibold uppercase text-cream-65 transition hover:text-cream">50%</button>
                <button onClick={() => handleSetAmount(formatUnits(balanceIn.value, balanceIn.decimals))} className="text-[11px] font-semibold uppercase text-cream-65 transition hover:text-cream">MAX</button>
              </div>
            </div>
          )}
        </div>

        {/* Invert */}
        <div className="relative z-10 -my-2 flex justify-center">
          <button onClick={handleInvert} className="flex h-11 w-11 items-center justify-center rounded-xl border border-cream-15 bg-surface-secondary text-cream-65 transition-all hover:border-cream-50 hover:text-cream hover:rotate-180">&#8645;</button>
        </div>

        {/* Receive */}
        <div className="mb-4 mt-1">
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[1.5px] text-cream-35">Receive</label>
          <div className="flex items-center gap-2 rounded-xl border border-cream-08 bg-surface-tertiary p-3">
            <span className="min-w-0 flex-1 text-2xl font-semibold text-cream-65">
              {quoteLoading ? <span className="inline-block animate-pulse text-cream-35">...</span> : `~${outputDisplay}`}
            </span>
            <TokenSelector selected={tokenOut} onSelect={(t) => { setTokenOut(t); resetSwap() }} disabledAddress={tokenIn?.address} />
          </div>
          {meta && meta.all.length > 1 && (
            <div className="mt-1 flex items-center justify-between px-1">
              <SourceToggle excludedSources={excludedSources} onToggle={handleSourceToggle} />
              <span className="text-[10px] text-cream-35">{meta.all.length} sources queried</span>
            </div>
          )}
        </div>

        {/* MEV Protection toggle */}
        <div className="mb-3 flex items-center justify-between rounded-lg border border-cream-08 bg-surface-tertiary/50 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-cream-65">
              MEV Protection
            </span>
            <span
              className="cursor-help text-[10px] text-cream-35"
              title="Routes your swap exclusively through CoW Protocol, which uses batch auctions to protect against MEV (sandwich attacks, front-running). May result in slightly different rates."
            >
              &#9432;
            </span>
          </div>
          <button
            onClick={() => setMevProtected(!mevProtected)}
            className="relative flex h-6 w-10 items-center rounded-full transition-colors"
            style={{ backgroundColor: mevProtected ? '#C8B89A' : 'rgba(200,184,154,0.15)' }}
            aria-label="Toggle MEV protection"
          >
            <span
              className="h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-200"
              style={{ marginLeft: mevProtected ? '20px' : '4px' }}
            />
          </button>
        </div>

        {/* No MEV-safe quote warning */}
        {mevProtected && !meta && rawMeta && !quoteLoading && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
            No MEV-protected quote available. CoW Protocol may be temporarily unavailable. Try disabling MEV Protection or wait a moment.
          </div>
        )}

        {/* Quote Breakdown */}
        {meta && tokenIn && tokenOut && hasAmount && (
          <div className="mb-4">
            <QuoteBreakdown meta={meta} tokenIn={tokenIn} tokenOut={tokenOut} amountIn={amountIn} slippage={slippage} countdown={countdown} priceCheck={priceCheck} approvalPlan={approvalPlan} onEditSlippage={() => setShowSlippage(true)} gasEstimate={gasEstimateFn} />
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
        {/* Price deviation — warn level (2-3%): swap paused until price converges */}
        {priceBlocked && priceCheck.level === 'warn' && !priceCheck.oracleUnavailable && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <span className="font-semibold">&#9888; Swap paused:</span> price deviates {(priceCheck.deviation * 100).toFixed(1)}% from Chainlink oracle.
            Waiting for price to return within safe parameters. The button will re-enable automatically.
          </div>
        )}
        {/* Price deviation — danger level (>3%): hard block */}
        {priceBlocked && priceCheck.level === 'danger' && (
          <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <span className="font-semibold">&#9888; Swap blocked:</span> price deviates {(priceCheck.deviation * 100).toFixed(1)}% from Chainlink oracle.
            This may indicate price manipulation or extreme low liquidity. Swap disabled for your protection.
          </div>
        )}
        {/* Oracle unavailable — tiered warnings */}
        {oracleUnavailable && hasAmount && meta && !priceBlocked && (
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
        <SwapButton swapStatus={swapStatus} approvalStatus={approvalStatus} approvalReady={approvalReady} hasAmount={hasAmount} hasSufficientBalance={hasSufficientBalance} hasQuote={!!meta} quoteLoading={quoteLoading} priceBlocked={anyBlocked} blockReason={priceBlocked && priceCheck.level === 'warn' ? 'warn' : priceBlocked && priceCheck.level === 'danger' ? 'danger' : oracleBlocked ? 'oracle' : undefined} onApprove={handleApproveAndSwap} onSwap={handleSwap} />

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
              const bestOut = Number(formatUnits(BigInt(meta.best.toAmount), tokenOut.decimals))
              const worstOut = Number(formatUnits(BigInt(meta.all[meta.all.length - 1].toAmount), tokenOut.decimals))
              const savedPercent = worstOut > 0 ? ((bestOut - worstOut) / worstOut * 100) : 0
              const savedDisplay = savedPercent > 0.01 ? savedPercent.toFixed(2) : null
              const shareText = savedDisplay
                ? `I just saved ${savedDisplay}% on my ${tokenIn.symbol} → ${tokenOut.symbol} swap by comparing ${meta.all.length} DEX sources with @TeraSwapDEX 🔥\n\nTeraSwap meta-aggregates 11 DEX sources for the best price.\nhttps://teraswap.app`
                : `Just swapped ${tokenIn.symbol} → ${tokenOut.symbol} via @TeraSwapDEX — compared ${meta.all.length} sources for the best price 🔥\n\nhttps://teraswap.app`
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

        {/* CoW Protocol — Approval Revoke Warning */}
        {showCowWarning && swapStatus === 'success' && (
          <div className="mt-3 rounded-lg border border-warning/25 bg-warning/8 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 text-warning text-sm">&#9888;</span>
              <div className="text-xs leading-relaxed text-cream-65">
                <span className="font-semibold text-warning">CoW Protocol leaves an infinite allowance</span> on the VaultRelayer contract.
                While CoW Protocol is audited and battle-tested, revoking the approval after your swap removes any residual access to your {tokenIn?.symbol} tokens.
                <span className="mt-1 block text-[10px] text-cream-35">
                  You can revoke below in &ldquo;Active Approvals&rdquo; or later via{' '}
                  <a href="https://revoke.cash" target="_blank" rel="noopener noreferrer" className="underline transition hover:text-cream">revoke.cash</a>.
                </span>
              </div>
            </div>
            <button
              onClick={() => setShowCowWarning(false)}
              className="mt-2 w-full rounded-lg border border-cream-08 py-1 text-[10px] font-semibold text-cream-35 transition hover:text-cream"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Slippage Modal */}
        {showSlippage && <SlippageModal value={slippage} onChange={setSlippage} onClose={() => setShowSlippage(false)} isAuto={isAutoSlippage} onAutoChange={setIsAutoSlippage} tokenInSymbol={tokenIn?.symbol} tokenOutSymbol={tokenOut?.symbol} />}
      </div>

      {/* Active Approvals — below the swap box */}
      <ActiveApprovals />

      {/* Beta disclaimer */}
      <BetaDisclaimer />
    </>
  )
}
