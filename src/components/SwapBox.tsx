'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAccount, useBalance } from 'wagmi'
import { formatUnits, parseUnits } from 'viem'
import TokenSelector from './TokenSelector'
import QuoteBreakdown from './QuoteBreakdown'
import SwapButton from './SwapButton'
import SlippageModal, { calculateAutoSlippage } from './SlippageModal'
import ActiveApprovals from './ActiveApprovals'
import { useQuote } from '@/hooks/useQuote'
import { useSwap } from '@/hooks/useSwap'
import { useApproval } from '@/hooks/useApproval'
import { useChainlinkPrice } from '@/hooks/useChainlinkPrice'
import { useSwapHistory } from '@/hooks/useSwapHistory'
import { trackTrade } from '@/lib/analytics-tracker'
import { useActiveApprovals } from '@/hooks/useActiveApprovals'
import { useSplitRoute } from '@/hooks/useSplitRoute'
import SplitRouteVisualizer from './SplitRouteVisualizer'
import { fetchApproveSpender, addToRouterWhitelist } from '@/lib/api'
import { findToken, isNativeETH, type Token } from '@/lib/tokens'
import { CHAIN_ID, DEFAULT_SLIPPAGE, ETHERSCAN_TX, COW_VAULT_RELAYER, AGGREGATOR_META } from '@/lib/constants'
import { formatWithSeparator, stripSeparator, formatDisplay } from '@/lib/format'
import { playSwapSuccess, playSwapInitiated, playApproval, playError, playQuoteReceived } from '@/lib/sounds'
import { useToast } from '@/components/ToastProvider'
import { QuoteBreakdownSkeleton } from '@/components/Skeleton'
import { useEthGasCost } from '@/hooks/useEthGasCost'

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

  const { meta: rawMeta, loading: quoteLoading, error: quoteError, countdown } =
    useQuote(tokenIn, tokenOut, amountIn, isConnected && isCorrectChain)

  // Filter to MEV-protected sources only when toggle is on
  const meta = useMemo(() => {
    if (!rawMeta || !mevProtected) return rawMeta
    const mevSources = rawMeta.all.filter(q => AGGREGATOR_META[q.source]?.mevProtected)
    if (mevSources.length === 0) return null // no MEV-safe quotes available
    return { ...rawMeta, best: mevSources[0], all: mevSources }
  }, [rawMeta, mevProtected])

  // Play subtle sound when a new quote arrives
  useEffect(() => {
    if (meta?.best.source) {
      playQuoteReceived()
      fetchApproveSpender(meta.best.source).then((addr) => {
        setSpender(addr)
        // Security: register dynamic spender in router whitelist
        addToRouterWhitelist(addr)
      }).catch(() => {})
    }
  }, [meta?.best.source])

  const { plan: approvalPlan, status: approvalStatus, error: approvalError, approve, isReady: approvalReady } =
    useApproval(tokenIn, amountIn, spender)

  const { status: swapStatus, txHash, errorMessage: swapError, cowOrderUid, execute: executeSwap, reset: resetSwap } =
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

  const { estimate: gasEstimateFn } = useEthGasCost()
  const { toast, dismiss } = useToast()
  const swapToastId = useRef<string | null>(null)

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
      playSwapSuccess()
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

      // Analytics tracking
      const inUsd = ['USDC', 'USDT', 'DAI'].includes(tokenIn.symbol) ? Number(amountIn) : 0
      const outUsd = ['USDC', 'USDT', 'DAI'].includes(tokenOut.symbol) ? Number(outAmount) : 0
      trackTrade({
        type: 'swap',
        wallet: address || '',
        tokenIn: tokenIn.symbol,
        tokenInAddress: tokenIn.address,
        tokenOut: tokenOut.symbol,
        tokenOutAddress: tokenOut.address,
        amountIn,
        amountOut: outAmount,
        volumeUsd: inUsd || outUsd || Number(amountIn) * 2000, // rough ETH fallback
        source: meta.best.source,
        txHash,
      })

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
      playError()
      if (swapToastId.current) { dismiss(swapToastId.current) }
      toast({ type: 'error', title: 'Swap failed', description: swapError || 'Transaction was rejected or failed.' })
      swapToastId.current = null
    }
  }, [swapStatus])

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
  const hasSufficientBalance = !hasAmount || !balanceIn || !tokenIn || parseUnits(amountIn, tokenIn.decimals) <= balanceIn.value
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
    }
  }

  function handleInvert() {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setDisplayAmountIn('')
    resetSwap()
    setShowCowWarning(false)
  }

  function handleSetAmount(value: string) {
    setDisplayAmountIn(formatWithSeparator(value))
  }

  // ── Security: block swap when Chainlink deviation exceeds threshold ──
  const priceBlocked = priceCheck.level === 'danger'

  const handleApproveAndSwap = useCallback(async () => {
    if (priceBlocked) return // hard block — never execute above deviation threshold
    if (!approvalReady) { playApproval(); await approve(); return }
    playSwapInitiated()
    if (meta?.best.source) executeSwap(meta.best.source)
  }, [approvalReady, approve, meta?.best.source, executeSwap, priceBlocked])

  const handleSwap = useCallback(() => {
    if (priceBlocked) return // hard block
    playSwapInitiated()
    if (meta?.best.source) executeSwap(meta.best.source)
  }, [meta?.best.source, executeSwap, priceBlocked])

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
          <button onClick={handleInvert} className="flex h-9 w-9 items-center justify-center rounded-xl border border-cream-15 bg-surface-secondary text-cream-65 transition-all hover:border-cream-50 hover:text-cream hover:rotate-180">&#8645;</button>
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
            <div className="mt-1 px-1 text-right text-[10px] text-cream-35">{meta.all.length} sources queried</div>
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

        {/* Errors */}
        {quoteError && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{quoteError}</div>}
        {swapError && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{swapError}</div>}
        {approvalError && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{approvalError}</div>}
        {/* Price impact warning (>3%) — amber for caution, red for high */}
        {!priceBlocked && priceCheck.deviation > 0.03 && (
          <div className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
            priceCheck.deviation > 0.05
              ? 'border-danger/30 bg-danger/10 text-danger'
              : 'border-warning/30 bg-warning/10 text-warning'
          }`}>
            <span className="font-semibold">&#9888; High price impact: ~{(priceCheck.deviation * 100).toFixed(1)}%</span>
            <span className="ml-1 text-cream-50">
              {priceCheck.deviation > 0.05
                ? 'This trade is very large relative to available liquidity. Consider splitting into smaller trades.'
                : 'You may receive significantly less than expected. Consider reducing the trade size.'}
            </span>
          </div>
        )}
        {priceBlocked && (
          <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <span className="font-semibold">&#9888; Swap blocked:</span> price deviates {(priceCheck.deviation * 100).toFixed(1)}% from Chainlink oracle.
            This may indicate price manipulation or extreme low liquidity. Swap disabled for your protection.
          </div>
        )}

        {/* Swap Button */}
        <SwapButton swapStatus={swapStatus} approvalStatus={approvalStatus} approvalReady={approvalReady} hasAmount={hasAmount} hasSufficientBalance={hasSufficientBalance} hasQuote={!!meta} quoteLoading={quoteLoading} priceBlocked={priceBlocked} onApprove={handleApproveAndSwap} onSwap={handleSwap} />

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
    </>
  )
}
